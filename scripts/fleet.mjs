#!/usr/bin/env node
// Rafraîchit le registre de flotte fleet/fleet.json (auto-découverte via gh).
//
// Pour chaque repo non archivé du compte (hors repo-temp-*) :
//   - découvre visibilité, branche par défaut, langage principal ;
//   - lit .kit-version à la racine (version du kit de flotte installée, sinon null) ;
//   - détecte les workflows planifiés (crons) dans .github/workflows/ ;
//   - dispatchable : une issue labellisée `claude` y lance VRAIMENT une session qui peut
//     livrer sa PR. Trois conditions, toutes vérifiables sans lire aucun secret :
//     stub claude.yml + secret CLAUDE_CODE_OAUTH_TOKEN posé + Actions autorisé à créer des
//     PR. `dispatch_manque` liste ce qui bloque. Ne PAS se fier à kit_version (les repos
//     méta ont le stub sans le marqueur) ni au stub seul (sans secret la session échoue) ;
//   - PRÉSERVE les champs édités à la main dans fleet.json : type, statut, notes.
// Le registre est LA source que lisent /dispatch, le brief quotidien, la veille
// mensuelle et l'hygiène hebdo — aucune liste de repos en dur ailleurs.
//
// Usage : node scripts/fleet.mjs   (prérequis : gh CLI authentifié)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OWNER = process.env.FLEET_OWNER ?? "VOTRE-COMPTE";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // .../claude-ops
const FLEET_PATH = join(ROOT, "fleet", "fleet.json");

const gh = (args, ok404 = false) => {
  try {
    return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    if (ok404) return null;
    throw e;
  }
};

// Types par défaut (seed) — écrasés par fleet.json existant, affinés par /equiper.
// Adapte cette table à tes propres repos (sinon le type est déduit du langage principal).
const SEED_TYPES = {
  "claude-ops": "meta",
  "fleet-kit": "meta",
  // "mon-site":        "static",
  // "mon-service":     "service-node",
  // "mon-cron":        "cron-python",
};

// Registre existant (préservation des champs manuels)
const existing = {};
if (existsSync(FLEET_PATH)) {
  for (const r of JSON.parse(readFileSync(FLEET_PATH, "utf8")).repos ?? []) existing[r.repo] = r;
}

console.log(`Découverte de la flotte (${OWNER})...`);
const repos = JSON.parse(
  gh(["repo", "list", OWNER, "--limit", "200", "--json",
    "name,visibility,isArchived,primaryLanguage,defaultBranchRef"])
);

const b64 = (s) => Buffer.from(s.replace(/\n/g, ""), "base64").toString("utf8");
const entries = [];

for (const repo of repos.sort((a, b) => a.name.localeCompare(b.name))) {
  if (repo.isArchived || /^repo-temp-/.test(repo.name)) continue;
  const name = repo.name;
  const old = existing[name];

  // .kit-version (404 = kit non installé)
  const kvRaw = gh(["api", `repos/${OWNER}/${name}/contents/.kit-version`, "--jq", ".content"], true);
  const kitVersion = kvRaw ? b64(kvRaw).trim() : null;

  // Workflows planifiés (crons) + stub de dispatch
  const crons = [];
  let aLeStub = false;
  const wfList = gh(["api", `repos/${OWNER}/${name}/contents/.github/workflows`, "--jq", ".[].name"], true);
  if (wfList) {
    const wfs = wfList.split("\n").filter((w) => /\.ya?ml$/.test(w));
    aLeStub = wfs.some((w) => /^claude\.ya?ml$/.test(w));
    for (const wf of wfs) {
      const c = gh(["api", `repos/${OWNER}/${name}/contents/.github/workflows/${wf}`, "--jq", ".content"], true);
      if (c && /^\s*schedule\s*:/m.test(b64(c))) crons.push(wf);
    }
  }

  // Ce qui manque au repo pour qu'une issue `claude` y aboutisse à une PR.
  // Vérifié seulement si le stub est là (sinon les 2 appels ne serviraient à rien).
  // On lit des NOMS de secrets et un booléen de réglage — jamais une valeur de secret.
  const dispatchManque = [];
  if (!aLeStub) dispatchManque.push("claude.yml");
  else {
    const noms = (gh(["api", `repos/${OWNER}/${name}/actions/secrets`, "--jq", "[.secrets[].name] | join(\",\")"], true) ?? "")
      .split(",").map((s) => s.trim()); // gh termine sa sortie par un \n : sans trim, le dernier nom ne matche jamais
    if (!noms.includes("CLAUDE_CODE_OAUTH_TOKEN")) dispatchManque.push("CLAUDE_CODE_OAUTH_TOKEN");
    const peutPR = gh(["api", `repos/${OWNER}/${name}/actions/permissions/workflow`, "--jq", ".can_approve_pull_request_reviews"], true);
    if (peutPR?.trim() !== "true") dispatchManque.push("actions-peut-creer-des-PR");
  }
  const dispatchable = dispatchManque.length === 0;

  const lang = repo.primaryLanguage?.name;
  const type =
    old?.type ??
    SEED_TYPES[name] ??
    (lang === "Python" ? "cron-python"
      : ["JavaScript", "TypeScript", "HTML"].includes(lang) ? "static"
      : "a-definir");

  entries.push({
    repo: name,
    type,
    visibility: repo.visibility.toLowerCase(),
    default_branch: repo.defaultBranchRef?.name ?? null,
    kit_version: kitVersion,
    dispatchable,
    dispatch_manque: dispatchManque,
    crons,
    statut: old?.statut ?? "actif",
    notes: old?.notes ?? "",
  });
  console.log(
    `  ${name}  (type=${type}, kit=${kitVersion ?? "aucun"}, dispatch=${dispatchable ? "oui" : `non — manque ${dispatchManque.join(" + ")}`}, crons=${crons.length})`
  );
}

mkdirSync(dirname(FLEET_PATH), { recursive: true });
writeFileSync(
  FLEET_PATH,
  JSON.stringify(
    {
      _doc: "Registre de flotte — généré par scripts/fleet.mjs. Champs manuels préservés : type, statut, notes. `dispatchable` = une issue labellisée `claude` y lance une session qui peut livrer sa PR (stub claude.yml + secret CLAUDE_CODE_OAUTH_TOKEN + Actions autorisé à créer des PR) ; `dispatch_manque` dit ce qui bloque. C'est le critère de /dispatch — pas kit_version. Lu par /dispatch, brief quotidien, veille mensuelle, hygiène.",
      updated_at: new Date().toISOString().slice(0, 16).replace("T", " "),
      kit_repo: `${OWNER}/fleet-kit`,
      repos: entries,
    },
    null,
    2
  ) + "\n",
  "utf8"
);
console.log(`Registre écrit : ${FLEET_PATH} (${entries.length} repos)`);
