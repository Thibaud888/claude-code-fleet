#!/usr/bin/env node
// Collecte les données du BILAN TOKENS HEBDO en un seul appel (même patron que
// brief-data.mjs : le script mesure, la session Haiku ne fait qu'analyser et rédiger).
//
// Deux mondes mesurés sur 7 jours glissants :
//   LOCAL (quota Pro)  — via ccusage : total/jour, par modèle, ratio cache, top sessions.
//   CLOUD (API 5 €/m)  — via gh : runs Claude/MAP/Self-heal par repo actif, avec l'effet
//                        des gardes (MAP régénérée vs court-circuitée, self-heal lancé vs
//                        évité — estimé par la durée du run) et le compteur de relances
//                        par commentaire @claude (règle « 1 commentaire = 1 lot »).
//
// Archive son propre instantané dans rapport/tokens/data/<AAAA-SNN>.json et joint celui de
// la semaine précédente pour la comparaison. Sortie : JSON compact sur stdout.
//
// Usage : node scripts/tokens-hebdo.mjs   (prérequis : gh CLI authentifié)
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
const parRepo = await enParallele(actifs, 6, async (r) => {
  const raw = await gh(["run", "list", "--repo", `${OWNER}/${r.repo}`, "--limit", "80",
    "--json", "workflowName,event,conclusion,createdAt,startedAt,updatedAt"]);
  if (!raw) return { repo: r.repo, runs: [] };
  const runs = JSON.parse(raw).filter((run) =>
    Date.parse(run.createdAt) > DEBUT &&
    ["Claude", "MAP", "Self-heal"].includes(run.workflowName));
  return { repo: r.repo, runs };
});

const cloud = {
  note: `sessions Claude dans Actions (budget API 5 €/mois) ; lancé/évité estimé par la durée du run (seuils ${SEUIL_MAP_S}s/${SEUIL_HEAL_S}s)`,
  dispatch_sessions: 0,
  relances_commentaire: 0, // @claude — la règle « 1 commentaire = 1 lot » veut ce compteur bas
  map: { regenerees: 0, court_circuitees: 0 },
  self_heal: { lances: 0, evites: 0 },
  runs_en_echec: 0, // hors classement lancé/évité : un run planté n'est ni l'un ni l'autre
  par_repo: {},
};
for (const { repo, runs } of parRepo) {
  if (!runs.length) continue;
  const c = { dispatch: 0, relances: 0, map_regen: 0, map_skip: 0, heal_lance: 0, heal_evite: 0, echecs: 0 };
  for (const run of runs) {
    const duree = (Date.parse(run.updatedAt) - Date.parse(run.startedAt || run.createdAt)) / 1000;
    if (run.workflowName === "Claude") {
      if (run.event === "issue_comment") { c.relances++; cloud.relances_commentaire++; }
      else { c.dispatch++; cloud.dispatch_sessions++; }
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

// ---------- 3. Instantané + comparaison avec la semaine précédente ----------
mkdirSync(DATA_DIR, { recursive: true });
const instantane = {
  semaine,
  periode: { du: new Date(DEBUT).toISOString().slice(0, 10), au: new Date(MAINTENANT).toISOString().slice(0, 10) },
  local, cloud,
};
writeFileSync(join(DATA_DIR, `${semaine}.json`), JSON.stringify(instantane, null, 1) + "\n", "utf8");

let precedente = null;
const semPrec = semaineISO(MAINTENANT - 8 * 86_400_000);
const fichierPrec = join(DATA_DIR, `${semPrec}.json`);
if (semPrec !== semaine && existsSync(fichierPrec)) {
  try { precedente = JSON.parse(readFileSync(fichierPrec, "utf8")); } catch { /* corrompu → ignoré */ }
}

process.stdout.write(JSON.stringify({
  ...instantane,
  semaine_precedente: precedente
    ? { semaine: precedente.semaine, local_cout_usd: precedente.local?.cout_usd_7j ?? null,
        local_par_modele: precedente.local?.par_modele ?? null, cloud: precedente.cloud ?? null }
    : null,
  erreurs: erreurs.length ? erreurs : undefined,
}, null, 1) + "\n");
