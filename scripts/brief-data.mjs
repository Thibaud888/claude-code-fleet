#!/usr/bin/env node
// Collecte TOUTES les données du brief hebdo en un seul appel d'outil (économie de
// tokens : ~30-45 appels gh dont les sorties JSON entreraient dans le contexte
// de la session → 1 appel, 1 JSON compact ; Claude ne fait plus que rédiger).
//
// Sort sur stdout un JSON en deux volets :
// ÉTAT à l'instant T (le « reste à traiter ») :
//   - PRs ouvertes par repo actif (avec âge en jours) ;
//   - workflows dont le dernier run terminé est en échec (crons marqués) ; un échec suivi
//     d'un run vert part dans repares_24h (« réparé depuis »), pas en alerte ;
//   - issues `claude` ouvertes (avec âge et présence d'une PR liée) ;
//   - dispatchs EN RADE (dispatch_en_rade) : issue `claude` > 1 h sans PR ni session en cours,
//     et PR de session (`claude/*`) ouverte que rien ne bloque — cf. scripts/brief-rade.mjs ;
//   - token_claude : le CLAUDE_CODE_OAUTH_TOKEN sert-il encore ? (canari sans effet de bord,
//     lecture de la durée d'appel des runs passés — cf. scripts/token-canari.mjs) ;
//   - chiens de garde Healthchecks en late/down + état du check harvest (moisson mensuelle).
// SEMAINE écoulée (le « traité » + l'activité) :
//   - PRs mergées 7 j (toutes, avec repo) et issues `claude` fermées 7 j (avec modèle) ;
//   - sessions cloud 7 j par repo et par workflow (proxy d'activité : les tokens des
//     sessions d'abonnement ne sont pas mesurables) + minutes de runs ;
//   - part méta (pct_meta_7j) : PRs mergées sur claude-ops/fleet-kit/fleetview vs projets ;
//   - usage local Claude Code (ccusage, coût équivalent API) — sauté si BRIEF_CLOUD=1
//     (le brief cloud lit à la place le dernier rapport versionné rapport/tokens/).
//
// Usage : node scripts/brief-data.mjs   (prérequis : gh CLI authentifié)
import { exec, execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { detecteRade, estPrDeSession, issueDeLaBranche, synthetiseChecks } from "./brief-rade.mjs";
import { etapeClaude, verdictToken, WORKFLOWS_CLAUDE } from "./token-canari.mjs";

const pExecFile = promisify(execFile);
const pExec = promisify(exec);
const OWNER = process.env.FLEET_OWNER ?? "VOTRE-COMPTE";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // .../claude-ops
const erreurs = [];

const gh = async (args, { ok404 = false } = {}) => {
  try {
    const { stdout } = await pExecFile("gh", args, { encoding: "utf8", timeout: 60_000 });
    return stdout;
  } catch (e) {
    if (ok404) return null;
    erreurs.push(`gh ${args.slice(0, 3).join(" ")}… : ${(e.stderr || e.message || "").trim().slice(0, 150)}`);
    return null;
  }
};

// Exécution parallèle avec plafond (éviter le rate-limit gh)
const enParallele = async (items, limite, fn) => {
  const resultats = [];
  let i = 0;
  const worker = async () => {
    while (i < items.length) resultats.push(await fn(items[i++]));
  };
  await Promise.all(Array.from({ length: Math.min(limite, items.length) }, worker));
  return resultats;
};

const MAINTENANT = Date.now();
const ageJours = (iso) => Math.floor((MAINTENANT - Date.parse(iso)) / 86_400_000);
const ageHeures = (iso) => Math.floor((MAINTENANT - Date.parse(iso)) / 3_600_000);

// ---------- 1. Flotte ----------
const fleet = JSON.parse(readFileSync(join(ROOT, "fleet", "fleet.json"), "utf8"));
const actifs = fleet.repos.filter((r) => r.statut === "actif");

// ---------- 2. PRs + état courant des workflows par repo (parallèle, plafond 6) ----------
const CONCLUSIONS_ECHEC = new Set(["failure", "startup_failure", "timed_out"]);
const parRepo = await enParallele(actifs, 6, async (r) => {
  const [prsRaw, runsRaw] = await Promise.all([
    gh(["pr", "list", "--repo", `${OWNER}/${r.repo}`,
      "--json", "number,title,isDraft,createdAt,url,headRefName,author,statusCheckRollup"]),
    gh(["run", "list", "--repo", `${OWNER}/${r.repo}`, "--limit", "40",
      "--json", "workflowName,status,conclusion,createdAt,updatedAt,url,databaseId"]),
  ]);
  const runsList = runsRaw ? JSON.parse(runsRaw) : [];
  const prs = (prsRaw ? JSON.parse(prsRaw) : []).map((p) => ({
    n: p.number, titre: p.title, age_j: ageJours(p.createdAt), age_h: ageHeures(p.createdAt),
    draft: p.isDraft, url: p.url,
    // Suivi de dispatch : une PR de session porte une branche `claude/…` (voir brief-rade.mjs).
    session: estPrDeSession(p.headRefName, p.author), issue: issueDeLaBranche(p.headRefName),
    checks: synthetiseChecks(p.statusCheckRollup),
  }));
  // « Publish Shorts » (nom du workflow) doit matcher « publish-shorts.yml » (nom du fichier)
  const slug = (s) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const cronsDuRepo = (r.crons ?? []).map((c) => slug(c.replace(/\.ya?ml$/, "")));
  // État à l'instant T : le DERNIER run terminé de chaque workflow fait foi.
  const runsParWf = new Map();
  // Activité de la semaine : runs terminés < 7 j par workflow (limite 40 runs/repo : une
  // semaine très chargée peut être sous-comptée — proxy, pas une compta exacte).
  const sessions7j = {};
  const runsActifs = [];
  const runsClaude = []; // candidats pour le canari de token (cf. token-canari.mjs)
  let minutes7j = 0;
  for (const run of runsList) {
    if (run.status !== "completed") {
      // Run en cours : l'état du workflow reste le dernier terminé, mais une session vivante
      // absout une issue `claude` sans PR (elle est peut-être en train de la produire).
      // Passé 3 h, un run « in_progress » est coincé, pas actif — il n'absout plus rien.
      if (ageHeures(run.createdAt) < 3) runsActifs.push(run.workflowName);
      continue;
    }
    if (!runsParWf.has(run.workflowName)) runsParWf.set(run.workflowName, []);
    runsParWf.get(run.workflowName).push(run); // gh trie du plus récent au plus ancien
    if (ageJours(run.createdAt) < 7) {
      sessions7j[run.workflowName] = (sessions7j[run.workflowName] ?? 0) + 1;
      if (run.updatedAt) minutes7j += Math.max(0, (Date.parse(run.updatedAt) - Date.parse(run.createdAt)) / 60_000);
      if (WORKFLOWS_CLAUDE.includes(run.workflowName)) {
        runsClaude.push({ repo: r.repo, wf: run.workflowName, id: run.databaseId,
          url: run.url, cree: run.createdAt });
      }
    }
  }
  const enEchec = [];
  const repares24h = [];
  for (const [wf, runs] of runsParWf) {
    const cron = cronsDuRepo.includes(slug(wf));
    const dernier = runs[0];
    if (CONCLUSIONS_ECHEC.has(dernier.conclusion)) {
      // Cron cassé = à traiter quel que soit l'âge ; hors cron, on ne remonte que le récent
      // (le vieil échec de CI d'une branche abandonnée n'est pas un état de la flotte).
      if (!cron && ageHeures(dernier.createdAt) >= 24) continue;
      let echecsConsecutifs = 0;
      for (const run of runs) {
        if (!CONCLUSIONS_ECHEC.has(run.conclusion)) break;
        echecsConsecutifs += 1;
      }
      enEchec.push({
        wf, cron, echecs_consecutifs: echecsConsecutifs,
        dernier_il_y_a_h: ageHeures(dernier.createdAt), url: dernier.url,
      });
    } else if (dernier.conclusion === "success" &&
        runs.some((run) => CONCLUSIONS_ECHEC.has(run.conclusion) && ageHeures(run.createdAt) < 24)) {
      repares24h.push({ wf, cron, repare_il_y_a_h: ageHeures(dernier.createdAt) });
    }
  }
  return { repo: r.repo, prs, en_echec: enEchec, repares_24h: repares24h,
    runs_actifs: runsActifs, runs_claude: runsClaude,
    sessions_7j: sessions7j, minutes_7j: Math.round(minutes7j) };
});
const repos = parRepo
  .filter((r) => r.prs.length || r.en_echec.length || r.repares_24h.length)
  .map(({ sessions_7j, minutes_7j, runs_actifs, runs_claude, ...etat }) => etat);
const sessionsCloud7j = parRepo
  .filter((r) => Object.keys(r.sessions_7j).length)
  .map((r) => ({ repo: r.repo, minutes: r.minutes_7j, par_workflow: r.sessions_7j }));

// ---------- 2bis. Canari : le token d'abonnement sert-il encore ? ----------
// On ne déclenche aucun workflow : on relit la durée de l'étape d'appel des runs déjà passés
// (cf. token-canari.mjs). Du plus récent au plus ancien, on s'arrête à la première PREUVE —
// en flotte saine c'est le 1er appel, et le plafond borne le coût quand ça va mal.
// 6 : sur une flotte de 16 repos, beaucoup de runs `MAP` récents sont sautés par leur garde
// (aucune étape exploitable). Mesuré ici : il en a fallu 4 pour tomber sur un vrai appel.
// On garde l'ordre par récence — un token révoqué hier ne se voit que sur les runs d'hier.
const PLAFOND_CANARI = 6;
const candidats = parRepo.flatMap((r) => r.runs_claude ?? [])
  .sort((a, b) => Date.parse(b.cree) - Date.parse(a.cree));
const observations = [];
for (const c of candidats.slice(0, PLAFOND_CANARI)) {
  const jobsRaw = await gh(["api", `repos/${OWNER}/${c.repo}/actions/runs/${c.id}/jobs`], { ok404: true });
  if (!jobsRaw) continue;
  const steps = (JSON.parse(jobsRaw).jobs ?? []).flatMap((j) => j.steps ?? []);
  observations.push({ repo: c.repo, wf: c.wf, url: c.url, etape: etapeClaude(steps) });
  if (observations.at(-1).etape?.duree_s >= 15) break; // preuve trouvée, inutile d'aller plus loin
}
const tokenClaude = { ...verdictToken(observations), runs_examines: observations.length };

// ---------- 3. Issues `claude` ouvertes ----------
let issuesClaude = [];
const issuesRaw = await gh(["search", "issues", "--owner", OWNER, "--label", "claude",
  "--state", "open", "--json", "number,title,repository,createdAt,url", "--limit", "30"]);
if (issuesRaw) {
  issuesClaude = JSON.parse(issuesRaw).map((i) => ({
    repo: i.repository?.name, n: i.number, titre: i.title,
    age_h: ageHeures(i.createdAt), url: i.url,
  }));
  // Une PR liée existe-t-elle ? (sinon la session est probablement plantée). Seuil 1 h : en
  // deçà, la session a le droit d'être encore en train de travailler.
  // D'abord sans le moindre appel : une PR ouverte sur la branche `claude/issue-<n>` du repo.
  const prsOuvertesParRepo = new Map(parRepo.map((r) => [r.repo, r.prs]));
  for (const i of issuesClaude) {
    i.pr_liee = (prsOuvertesParRepo.get(i.repo) ?? []).some((p) => p.issue === i.n);
  }
  // Repli pour les autres : la PR peut être déjà mergée (le merge auto ne fermait pas
  // l'issue avant fleet-kit#5) ou porter une branche hors convention.
  await enParallele(issuesClaude.filter((i) => i.age_h >= 1 && !i.pr_liee).slice(0, 12), 4, async (i) => {
    const pr = await gh(["pr", "list", "--repo", `${OWNER}/${i.repo}`,
      "--search", `Closes #${i.n}`, "--json", "number", "--state", "all"], { ok404: true });
    i.pr_liee = !!(pr && JSON.parse(pr).length);
  });
}

// ---------- 3ter. Dispatchs en rade (suivi méta-agent du lot de la veille) ----------
const dispatchEnRade = detecteRade({ repos: parRepo, issues: issuesClaude, seuilH: 1 });

// ---------- 3bis. Semaine écoulée : PRs mergées + issues `claude` fermées ----------
const depuis7j = new Date(MAINTENANT - 7 * 86_400_000).toISOString().slice(0, 10);
let prsMergees7j = [];
const mergedRaw = await gh(["search", "prs", "--owner", OWNER, "--merged", "--limit", "100",
  "--json", "repository,number,title,url", `merged:>=${depuis7j}`]);
if (mergedRaw) {
  prsMergees7j = JSON.parse(mergedRaw).map((p) => ({
    repo: p.repository?.name, n: p.number, titre: p.title, url: p.url,
  }));
}
let issuesClaudeFermees7j = [];
const fermeesRaw = await gh(["search", "issues", "--owner", OWNER, "--label", "claude",
  "--state", "closed", "--limit", "50",
  "--json", "repository,number,title,labels,url", `closed:>=${depuis7j}`]);
if (fermeesRaw) {
  issuesClaudeFermees7j = JSON.parse(fermeesRaw).map((i) => ({
    repo: i.repository?.name, n: i.number, titre: i.title, url: i.url,
    modele: (i.labels ?? []).map((l) => l.name).find((n) => n.startsWith("claude:"))?.slice(7) ?? "sonnet",
  }));
}
// Part méta : PRs mergées de la semaine sur l'outillage vs les projets.
const META = new Set(["claude-ops", "fleet-kit", "fleetview"]);
const pctMeta7j = prsMergees7j.length
  ? Math.round((100 * prsMergees7j.filter((p) => META.has(p.repo)).length) / prsMergees7j.length)
  : null;

// ---------- 4. Healthchecks ----------
let healthchecks = null;
try {
  // Env d'abord (secret HEALTHCHECKS_API_KEY en cloud), fichier local en repli (sessions locales).
  const cle = (process.env.HEALTHCHECKS_API_KEY ?? readFileSync(join(homedir(), ".claude", "healthchecks-api-key"), "utf8")).trim();
  const rep = await fetch("https://healthchecks.io/api/v3/checks/", { headers: { "X-Api-Key": cle } });
  if (!rep.ok) throw new Error(`HTTP ${rep.status}`);
  const { checks } = await rep.json();
  const harvest = checks.find((c) => (c.name || "").includes("harvest"));
  healthchecks = {
    problemes: checks
      .filter((c) => ["grace", "down"].includes(c.status))
      .map((c) => ({ nom: c.name, statut: c.status === "grace" ? "late" : c.status, dernier_ping: c.last_ping })),
    harvest: harvest ? (harvest.status === "grace" ? "late" : harvest.status) : "introuvable",
  };
} catch (e) {
  erreurs.push(`healthchecks : ${e.message}`);
}

// ---------- 5. Usage local Claude Code (ccusage — coût équivalent API de l'abonnement) ----------
// BRIEF_CLOUD : sur un runner cloud (GitHub Actions) il n'y a pas de données ccusage locales —
// on saute le bloc pour éviter une erreur systématique dans `erreurs`. usage_local reste null.
let usageLocal = null;
if (!process.env.BRIEF_CLOUD) try {
  const depuis = new Date(MAINTENANT - 8 * 86_400_000).toISOString().slice(0, 10).replaceAll("-", "");
  const { stdout } = await pExec(
    `npx --yes ccusage@latest daily --json --offline --since ${depuis}`,
    { encoding: "utf8", timeout: 180_000 }
  );
  const jours = JSON.parse(stdout).daily ?? [];
  const parDate = (iso) => jours.find((j) => j.date === iso);
  const resume = (j) => (j ? { cout_usd: Math.round(j.totalCost * 100) / 100, tokens: j.totalTokens } : null);
  const somme = (champ) => Math.round(jours.reduce((s, j) => s + (j[champ] ?? 0), 0) * 100) / 100;
  usageLocal = {
    note: "coût équivalent API des sessions locales (ccusage) — l'abonnement n'est pas facturé à l'usage",
    aujourd_hui: resume(parDate(new Date(MAINTENANT).toISOString().slice(0, 10))),
    hier: resume(parDate(new Date(MAINTENANT - 86_400_000).toISOString().slice(0, 10))),
    "7j": { cout_usd: somme("totalCost") },
  };
} catch (e) {
  erreurs.push(`ccusage : ${(e.message || "").slice(0, 150)}`);
}

// ---------- Sortie ----------
process.stdout.write(JSON.stringify({
  généré_le: new Date().toISOString().slice(0, 16),
  repos_actifs: actifs.length,
  repos,
  issues_claude: issuesClaude,
  dispatch_en_rade: dispatchEnRade,
  token_claude: tokenClaude,
  prs_mergees_7j: prsMergees7j,
  issues_claude_fermees_7j: issuesClaudeFermees7j,
  sessions_cloud_7j: sessionsCloud7j,
  pct_meta_7j: pctMeta7j,
  healthchecks,
  usage_local: usageLocal,
  erreurs: erreurs.length ? erreurs : undefined,
}, null, 1) + "\n");
