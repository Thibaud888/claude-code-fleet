#!/usr/bin/env node
// Collecte TOUTES les données du brief quotidien en un seul appel d'outil (économie de
// tokens : ~30-45 appels gh dont les sorties JSON entraient chaque jour dans le contexte
// de la session → 1 appel, 1 JSON compact ; Claude ne fait plus que rédiger).
//
// Sort sur stdout un JSON avec uniquement ce qui mérite attention :
//   - PRs ouvertes par repo actif (avec âge en jours) ;
//   - runs en échec des dernières 24 h (crons prioritaires marqués) ;
//   - issues `claude` ouvertes (avec âge et présence d'une PR liée si > 24 h) ;
//   - chiens de garde Healthchecks en late/down + état du check harvest-hebdo ;
//   - usage local Claude Code (ccusage, coût équivalent API) : hier + 7 derniers jours.
//
// Usage : node scripts/brief-data.mjs   (prérequis : gh CLI authentifié)
import { exec, execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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

// ---------- 2. PRs + échecs de runs par repo (parallèle, plafond 6) ----------
const parRepo = await enParallele(actifs, 6, async (r) => {
  const [prsRaw, runsRaw] = await Promise.all([
    gh(["pr", "list", "--repo", `${OWNER}/${r.repo}`, "--json", "number,title,isDraft,createdAt,url"]),
    gh(["run", "list", "--repo", `${OWNER}/${r.repo}`, "--status", "failure", "--limit", "8",
      "--json", "workflowName,createdAt,url,event"]),
  ]);
  const prs = (prsRaw ? JSON.parse(prsRaw) : []).map((p) => ({
    n: p.number, titre: p.title, age_j: ageJours(p.createdAt), draft: p.isDraft, url: p.url,
  }));
  // « Publish Shorts » (nom du workflow) doit matcher « publish-shorts.yml » (nom du fichier)
  const slug = (s) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const cronsDuRepo = (r.crons ?? []).map((c) => slug(c.replace(/\.ya?ml$/, "")));
  // Regrouper les échecs répétés d'un même workflow : 1 entrée avec compteur + dernier run
  const echecsParWf = new Map();
  for (const run of (runsRaw ? JSON.parse(runsRaw) : []).filter((run) => ageHeures(run.createdAt) < 24)) {
    const existant = echecsParWf.get(run.workflowName);
    if (existant) { existant.n += 1; continue; } // runs triés du plus récent au plus ancien
    echecsParWf.set(run.workflowName, {
      wf: run.workflowName,
      cron: cronsDuRepo.includes(slug(run.workflowName)),
      n: 1,
      dernier_il_y_a_h: ageHeures(run.createdAt),
      url: run.url,
    });
  }
  return { repo: r.repo, prs, echecs_24h: [...echecsParWf.values()] };
});
const repos = parRepo.filter((r) => r.prs.length || r.echecs_24h.length);

// ---------- 3. Issues `claude` ouvertes ----------
let issuesClaude = [];
const issuesRaw = await gh(["search", "issues", "--owner", OWNER, "--label", "claude",
  "--state", "open", "--json", "number,title,repository,createdAt,url", "--limit", "30"]);
if (issuesRaw) {
  issuesClaude = JSON.parse(issuesRaw).map((i) => ({
    repo: i.repository?.name, n: i.number, titre: i.title,
    age_h: ageHeures(i.createdAt), url: i.url,
  }));
  // Pour les issues > 24 h : une PR liée existe-t-elle ? (session probablement plantée sinon)
  await enParallele(issuesClaude.filter((i) => i.age_h > 24).slice(0, 10), 4, async (i) => {
    const pr = await gh(["pr", "list", "--repo", `${OWNER}/${i.repo}`,
      "--search", `Closes #${i.n}`, "--json", "number", "--state", "all"], { ok404: true });
    i.pr_liee = !!(pr && JSON.parse(pr).length);
  });
}

// ---------- 4. Healthchecks ----------
let healthchecks = null;
try {
  // Env d'abord (secret HEALTHCHECKS_API_KEY en cloud), fichier local en repli (sessions locales).
  const cle = (process.env.HEALTHCHECKS_API_KEY ?? readFileSync(join(homedir(), ".claude", "healthchecks-api-key"), "utf8")).trim();
  const rep = await fetch("https://healthchecks.io/api/v3/checks/", { headers: { "X-Api-Key": cle } });
  if (!rep.ok) throw new Error(`HTTP ${rep.status}`);
  const { checks } = await rep.json();
  const harvest = checks.find((c) => (c.name || "").includes("harvest-hebdo"));
  healthchecks = {
    problemes: checks
      .filter((c) => ["grace", "down"].includes(c.status))
      .map((c) => ({ nom: c.name, statut: c.status === "grace" ? "late" : c.status, dernier_ping: c.last_ping })),
    harvest_hebdo: harvest ? (harvest.status === "grace" ? "late" : harvest.status) : "introuvable",
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
  lundi: new Date().getDay() === 1,
  repos_actifs: actifs.length,
  repos,
  issues_claude: issuesClaude,
  healthchecks,
  usage_local: usageLocal,
  erreurs: erreurs.length ? erreurs : undefined,
}, null, 1) + "\n");
