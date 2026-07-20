#!/usr/bin/env node
// Collecte les données du BILAN TOKENS HEBDO en un seul appel (même patron que
// brief-data.mjs : le script mesure, la session Haiku ne fait qu'analyser et rédiger).
//
// Deux mondes mesurés sur 7 jours glissants :
//   LOCAL (quota Pro)  — via ccusage : total/jour, par modèle, ratio cache, top sessions.
//   CLOUD (abonnement) — via gh : runs Claude/MAP/Self-heal par repo actif + les workflows
//                        propres au repo méta (brief hebdo, cadrage du codex, propagation du
//                        kit), avec l'effet des gardes (lancé vs évité, estimé par la durée du
//                        run), le compteur de relances par commentaire @claude (règle
//                        « 1 commentaire = 1 lot ») et le COÛT PAR AUTOMATISME : réel pour les
//                        sessions dispatch/relance (claude-code-action logue `total_cost_usd`)
//                        et pour les runs headless lancés en `claude -p --output-format json` ;
//                        forfait calibré en repli pour les runs qui ne loguent pas leur coût.
//
// Archive son propre instantané dans rapport/tokens/data/<AAAA-SNN>.json et joint celui de
// la semaine précédente pour la comparaison. Sortie : JSON compact sur stdout.
//
// Usage : node scripts/tokens-hebdo.mjs [--force]   (prérequis : gh CLI authentifié)
//   --force : écrire l'archive versionnée même hors dimanche (rattrapage d'un run manqué).
import { exec, execFile } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);
const pExec = promisify(exec);
const OWNER = process.env.FLEET_OWNER ?? "VOTRE-COMPTE";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // .../claude-ops
const DATA_DIR = join(ROOT, "rapport", "tokens", "data");
const MAINTENANT = Date.now();
const JOURS = 7;
const DEBUT = MAINTENANT - JOURS * 86_400_000;
// Seuils durée (estimation lancé/évité) : un run court-circuité par une garde = checkout +
// décision (~15-60 s) ; un run avec session Claude = npm install + session (minutes).
const SEUIL_MAP_S = 90;
const SEUIL_HEAL_S = 120;
const SEUIL_HEADLESS_S = 90; // brief/cadrage : garde 0 token (rien à traiter…) vs vraie session
// Forfaits USD (équivalent API) pour les runs headless dont le log ne dit pas le coût. Ce sont
// des valeurs CALIBRÉES sur une flotte réelle (sessions Haiku courtes, max-turns 40) : réadapte-les
// à la tienne, ou mieux — passe tes `claude -p` en `--output-format json` et le coût réel prendra
// leur place. `session_claude` sert de repli pour un run dispatch/relance au log illisible
// (points réels observés : 0,62 $ pour une session avortée, 2,16 $ pour une grosse session).
const FORFAITS_USD = { map_regen: 0.08, heal_lance: 0.15, brief: 0.12, cadrage: 0.1, session_claude: 1.2 };
const erreurs = [];

const gh = async (args) => {
  try {
    const { stdout } = await pExecFile("gh", args, { encoding: "utf8", timeout: 60_000 });
    return stdout;
  } catch (e) {
    erreurs.push(`gh ${args.slice(0, 3).join(" ")}… : ${(e.stderr || e.message || "").trim().slice(0, 120)}`);
    return null;
  }
};
const enParallele = async (items, limite, fn) => {
  const out = [];
  let i = 0;
  const worker = async () => { while (i < items.length) out.push(await fn(items[i++])); };
  await Promise.all(Array.from({ length: Math.min(limite, items.length) }, worker));
  return out;
};
const arrondi = (x) => Math.round((x ?? 0) * 100) / 100;

// Numéro de semaine ISO (le bilan du lundi porte sur la semaine qui vient de s'achever)
const semaineISO = (t) => {
  const d = new Date(t);
  const jeudi = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  jeudi.setUTCDate(jeudi.getUTCDate() + 4 - (jeudi.getUTCDay() || 7));
  const an1 = new Date(Date.UTC(jeudi.getUTCFullYear(), 0, 1));
  const num = Math.ceil(((jeudi - an1) / 86_400_000 + 1) / 7);
  return `${jeudi.getUTCFullYear()}-S${String(num).padStart(2, "0")}`;
};
const semaine = semaineISO(MAINTENANT - 86_400_000); // dimanche → semaine écoulée

// Garde d'archive. `rapport/tokens/data/<AAAA-SNN>.json` est VERSIONNÉ (mémoire longue du
// bilan) alors que la fenêtre mesurée est de 7 jours GLISSANTS : relancer le script un autre
// jour réécrit l'archive de la semaine avec une fenêtre décalée — donc fausse. Le run nominal
// est celui du dimanche soir ; toute autre exécution écrit dans un fichier de travail que le
// .gitignore écarte.
const FORCE = process.argv.includes("--force");
const ARCHIVE_NOMINALE = new Date(MAINTENANT).getDay() === 0 || FORCE;
const FICHIER_SEMAINE = `${semaine}${ARCHIVE_NOMINALE ? "" : ".local"}.json`;

// ---------- 1. LOCAL : ccusage ----------
let local = null;
try {
  const depuis = new Date(DEBUT).toISOString().slice(0, 10).replaceAll("-", "");
  const ccusage = async (cmd) =>
    JSON.parse((await pExec(`npx --yes ccusage@latest ${cmd} --json --offline --since ${depuis}`,
      { encoding: "utf8", timeout: 180_000, maxBuffer: 32 * 1024 * 1024 })).stdout);

  const { daily = [] } = await ccusage("daily");
  const somme = (champ) => daily.reduce((s, j) => s + (j[champ] ?? 0), 0);
  const parModele = {};
  for (const j of daily) {
    for (const m of j.modelBreakdowns ?? []) {
      const nom = (m.modelName ?? m.model ?? "?").replace(/^claude-/, "");
      parModele[nom] = parModele[nom] ?? { cout_usd: 0, tokens: 0 };
      parModele[nom].cout_usd = arrondi(parModele[nom].cout_usd + (m.cost ?? m.totalCost ?? 0));
      parModele[nom].tokens += (m.inputTokens ?? 0) + (m.outputTokens ?? 0) +
        (m.cacheCreationTokens ?? 0) + (m.cacheReadTokens ?? 0);
    }
  }
  const lu = somme("cacheReadTokens");
  const frais = somme("inputTokens") + somme("cacheCreationTokens");

  // ccusage session identifie une session par son UUID (`period`) : on retrouve le PROJET
  // en cherchant quel dossier de ~/.claude/projects contient le transcript <uuid>.jsonl.
  const PROJETS_DIR = join(homedir(), ".claude", "projects");
  let dossiersProjets = [];
  try { dossiersProjets = readdirSync(PROJETS_DIR); } catch { /* pas de transcripts */ }
  const projetDeSession = (uuid) => {
    for (const d of dossiersProjets) {
      if (existsSync(join(PROJETS_DIR, d, `${uuid}.jsonl`))) {
        // Le nom de dossier de ~/.claude/projects est le chemin du clone, séparateurs → tirets.
        // Adapte ce préfixe au chemin de TON dossier de clones (ex. C--Users-<toi>-vos-repos-).
        const court = d.replace(/^C--Users-[^-]+-/, "");
        return court || "(dossier principal)";
      }
    }
    return `session ${String(uuid).slice(0, 8)}…`;
  };

  let topSessions = [];
  try {
    const rapport = await ccusage("session");
    topSessions = (rapport.session ?? rapport.sessions ?? [])
      .filter((s) => !s.metadata?.lastActivity || Date.parse(s.metadata.lastActivity) > DEBUT)
      .sort((a, b) => (b.totalCost ?? 0) - (a.totalCost ?? 0))
      .slice(0, 5)
      .map((s) => ({
        projet: projetDeSession(s.period ?? s.project ?? "?"),
        cout_usd: arrondi(s.totalCost),
        tokens: s.totalTokens ?? null,
        derniere_activite: (s.metadata?.lastActivity ?? "").slice(0, 10) || null,
      }));
  } catch (e) {
    erreurs.push(`ccusage session : ${(e.message || "").slice(0, 120)}`);
  }

  local = {
    note: "coût ÉQUIVALENT API du forfait (ccusage) — indicateur de volume, pas une facture",
    cout_usd_7j: arrondi(somme("totalCost")),
    tokens_7j: somme("totalTokens"),
    par_jour: daily.map((j) => ({ date: String(j.period ?? j.date ?? "?").slice(0, 10), cout_usd: arrondi(j.totalCost) })),
    par_modele: parModele,
    ratio_cache: frais + lu > 0 ? `${Math.round((lu / (frais + lu)) * 100)} % du contexte relu depuis le cache` : null,
    top_sessions: topSessions,
  };
} catch (e) {
  erreurs.push(`ccusage : ${(e.message || "").slice(0, 150)}`);
}

// ---------- 2. CLOUD : runs Actions de la flotte ----------
const fleet = JSON.parse(readFileSync(join(ROOT, "fleet", "fleet.json"), "utf8"));
const actifs = fleet.repos.filter((r) => r.statut === "actif");
// « Claude »/« MAP »/« Self-heal » existent sur chaque repo équipé ; les trois autres noms ne
// vivent que sur le repo méta (une seule liste suffit : un nom absent ne matche rien).
const WORKFLOWS_SUIVIS = ["Claude", "MAP", "Self-heal",
  "Brief flotte hebdo", "Cadrage du codex", "Propagation du kit"];
const parRepo = await enParallele(actifs, 6, async (r) => {
  const raw = await gh(["run", "list", "--repo", `${OWNER}/${r.repo}`, "--limit", "80",
    "--json", "databaseId,workflowName,event,conclusion,createdAt,startedAt,updatedAt"]);
  if (!raw) return { repo: r.repo, runs: [] };
  const runs = JSON.parse(raw).filter((run) =>
    Date.parse(run.createdAt) > DEBUT &&
    WORKFLOWS_SUIVIS.includes(run.workflowName));
  return { repo: r.repo, runs };
});

const cloud = {
  note: `sessions Claude dans Actions (abonnement, coût = équivalent API) ; lancé/évité estimé par la durée du run (seuils ${SEUIL_MAP_S}s/${SEUIL_HEAL_S}s/${SEUIL_HEADLESS_S}s)`,
  dispatch_sessions: 0,
  relances_commentaire: 0, // @claude — la règle « 1 commentaire = 1 lot » veut ce compteur bas
  map: { regenerees: 0, court_circuitees: 0 },
  self_heal: { lances: 0, evites: 0 },
  runs_en_echec: 0, // hors classement lancé/évité : un run planté n'est ni l'un ni l'autre
  par_repo: {},
};
const sessionsClaude = []; // runs dispatch/relance → coût réel à extraire du log ensuite
const runsHeadless = [];   // runs brief/cadrage → idem depuis `--output-format json`
const autoOps = { brief: 0, cadrage: 0, propagation: 0, gardes_headless: 0 };
for (const { repo, runs } of parRepo) {
  if (!runs.length) continue;
  const c = { dispatch: 0, relances: 0, map_regen: 0, map_skip: 0, heal_lance: 0, heal_evite: 0, echecs: 0 };
  for (const run of runs) {
    const duree = (Date.parse(run.updatedAt) - Date.parse(run.startedAt || run.createdAt)) / 1000;
    if (run.workflowName === "Claude") {
      // Garde du stub (commentaire sans @claude, auteur non autorisé…) : run `skipped`,
      // ~0 token — ni session ni échec. Le comptage dispatch/relance se fait APRÈS
      // lecture du log (un run `failure` sans coût logué = échec avant session).
      if (["skipped", "cancelled"].includes(run.conclusion)) continue;
      sessionsClaude.push({ repo, id: run.databaseId, conclusion: run.conclusion,
        type: run.event === "issue_comment" ? "relance" : "dispatch" });
    } else if (["Brief flotte hebdo", "Cadrage du codex", "Propagation du kit"].includes(run.workflowName)) {
      // Workflows du repo méta. Garde au niveau du job (skipped) ou run annulé : 0 token,
      // hors comptage — ni session ni échec.
      if (["skipped", "cancelled"].includes(run.conclusion)) continue;
      if (run.conclusion !== "success") { c.echecs++; cloud.runs_en_echec++; }
      else if (run.workflowName === "Propagation du kit") autoOps.propagation++;
      else if (duree < SEUIL_HEADLESS_S) autoOps.gardes_headless++;
      else {
        const type = run.workflowName === "Brief flotte hebdo" ? "brief" : "cadrage";
        autoOps[type]++;
        // Ces runs tournent en `--output-format json` : leur log porte `total_cost_usd`.
        // Un run lancé avant ce passage n'en a pas → repli sur le forfait.
        runsHeadless.push({ repo, id: run.databaseId, type });
      }
    } else if (run.conclusion !== "success") {
      c.echecs++; cloud.runs_en_echec++;
    } else if (run.workflowName === "MAP") {
      if (duree >= SEUIL_MAP_S) { c.map_regen++; cloud.map.regenerees++; }
      else { c.map_skip++; cloud.map.court_circuitees++; }
    } else if (run.workflowName === "Self-heal") {
      if (duree >= SEUIL_HEAL_S) { c.heal_lance++; cloud.self_heal.lances++; }
      else { c.heal_evite++; cloud.self_heal.evites++; }
    }
  }
  cloud.par_repo[repo] = c;
}

// ---------- 2bis. Coût par automatisme ----------
// Sessions dispatch/relance : claude-code-action écrit le résultat JSON de la session dans le
// log du run — on y lit `total_cost_usd` (la dernière occurrence, le bloc peut être répété).
const coutDepuisLog = async (s) => {
  try {
    const { stdout } = await pExecFile("gh",
      ["run", "view", String(s.id), "--repo", `${OWNER}/${s.repo}`, "--log"],
      { encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
    const m = stdout.match(/"total_cost_usd":\s*([\d.]+)/g);
    const val = m ? parseFloat(m[m.length - 1].replace(/[^\d.]/g, "")) : NaN;
    return { ...s, cout: Number.isFinite(val) ? val : null };
  } catch {
    return { ...s, cout: null };
  }
};
const sessionsChiffrees = await enParallele(sessionsClaude, 4, coutDepuisLog);
// Même lecture pour brief/cadrage : `claude -p --output-format json` logue `total_cost_usd`.
const headlessChiffres = await enParallele(runsHeadless, 4, coutDepuisLog);

// Coût d'un automatisme headless : somme des coûts réellement lus, forfait pour le reste
// (runs d'avant le passage en --output-format json, ou log tronqué).
const coutHeadless = (type, forfait) => {
  const runs = headlessChiffres.filter((r) => r.type === type);
  const chiffres = runs.filter((r) => r.cout !== null);
  const auForfait = runs.length - chiffres.length;
  return {
    sessions: runs.length,
    cout_usd: arrondi(chiffres.reduce((s, r) => s + r.cout, 0) + auForfait * forfait),
    chiffrees: chiffres.length, au_forfait: auForfait,
  };
};

const automatismes = {
  note: "coût 7 j par automatisme (USD équivalent API) — dispatch/relances lus dans les logs claude-code-action (`total_cost_usd`), sinon forfait `session_claude` ; brief/cadrage lus de même quand ils tournent en `claude -p --output-format json`, forfait en repli ; map/self-heal encore au forfait (headless côté fleet-kit) ; propagation = pur script",
  forfaits_usd: FORFAITS_USD,
  dispatch: { sessions: 0, cout_usd: 0, chiffrees: 0, au_forfait: 0 },
  relances: { sessions: 0, cout_usd: 0, chiffrees: 0, au_forfait: 0 },
  map: { sessions: cloud.map.regenerees, cout_usd: arrondi(cloud.map.regenerees * FORFAITS_USD.map_regen) },
  self_heal: { sessions: cloud.self_heal.lances, cout_usd: arrondi(cloud.self_heal.lances * FORFAITS_USD.heal_lance) },
  brief: coutHeadless("brief", FORFAITS_USD.brief),
  cadrage: coutHeadless("cadrage", FORFAITS_USD.cadrage),
  propagation: { runs: autoOps.propagation, cout_usd: 0 },
  gardes_headless: autoOps.gardes_headless, // brief/cadrage court-circuités (0 token)
  total_cout_usd: 0,
};
for (const s of sessionsChiffrees) {
  const r = cloud.par_repo[s.repo];
  if (s.cout == null && s.conclusion !== "success") {
    // Planté avant la session (setup, auth…) : un vrai run de session logue son coût
    // même en échec (max-turns dépassé, etc.).
    cloud.runs_en_echec++;
    if (r) r.echecs++;
    continue;
  }
  const cible = s.type === "relance" ? automatismes.relances : automatismes.dispatch;
  cible.sessions++;
  if (s.type === "relance") { cloud.relances_commentaire++; if (r) r.relances++; }
  else { cloud.dispatch_sessions++; if (r) r.dispatch++; }
  if (s.cout != null) { cible.chiffrees++; cible.cout_usd = arrondi(cible.cout_usd + s.cout); }
  else { cible.au_forfait++; cible.cout_usd = arrondi(cible.cout_usd + FORFAITS_USD.session_claude); }
  if (r) r.cout_sessions_usd = arrondi((r.cout_sessions_usd ?? 0) + (s.cout ?? FORFAITS_USD.session_claude));
}
// Repos dont tous les runs de la fenêtre étaient des gardes (skipped) : ligne vide, on purge.
for (const [repo, c] of Object.entries(cloud.par_repo)) {
  if (Object.values(c).every((v) => !v)) delete cloud.par_repo[repo];
}
automatismes.total_cout_usd = arrondi(
  automatismes.dispatch.cout_usd + automatismes.relances.cout_usd + automatismes.map.cout_usd +
  automatismes.self_heal.cout_usd + automatismes.brief.cout_usd + automatismes.cadrage.cout_usd);
cloud.automatismes = automatismes;
// Sessions cloud WEB (claude.ai/code) : hors mesure hebdo — les exports harvest contiennent le
// coût réel par tour (`result.total_cost_usd` + `usage` détaillé), donc l'estimation est
// possible, mais à la REVUE MENSUELLE (l'archive est mensuelle), pas ici.
cloud.sessions_web = { note: "non mesurées ici ; coût réel présent dans l'archive harvest (result.total_cost_usd) → revue mensuelle" };

// ---------- 3. Instantané + comparaison avec la semaine précédente ----------
mkdirSync(DATA_DIR, { recursive: true });
const instantane = {
  semaine,
  periode: { du: new Date(DEBUT).toISOString().slice(0, 10), au: new Date(MAINTENANT).toISOString().slice(0, 10) },
  local, cloud,
};
writeFileSync(join(DATA_DIR, FICHIER_SEMAINE), JSON.stringify(instantane, null, 1) + "\n", "utf8");
if (!ARCHIVE_NOMINALE) {
  console.error(`ℹ️  Hors dimanche : archive versionnée ${semaine}.json laissée intacte, ` +
    `instantané écrit dans ${FICHIER_SEMAINE} (ignoré par git). Rattrapage : --force.`);
}

let precedente = null;
const semPrec = semaineISO(MAINTENANT - 8 * 86_400_000);
const fichierPrec = join(DATA_DIR, `${semPrec}.json`);
if (semPrec !== semaine && existsSync(fichierPrec)) {
  try { precedente = JSON.parse(readFileSync(fichierPrec, "utf8")); } catch { /* corrompu → ignoré */ }
}

process.stdout.write(JSON.stringify({
  ...instantane,
  archive: { fichier: FICHIER_SEMAINE, nominale: ARCHIVE_NOMINALE,
    note: ARCHIVE_NOMINALE ? undefined : "exécution hors dimanche : fenêtre 7 j décalée, archive versionnée non touchée" },
  semaine_precedente: precedente
    ? { semaine: precedente.semaine, local_cout_usd: precedente.local?.cout_usd_7j ?? null,
        local_par_modele: precedente.local?.par_modele ?? null, cloud: precedente.cloud ?? null }
    : null,
  erreurs: erreurs.length ? erreurs : undefined,
}, null, 1) + "\n");
