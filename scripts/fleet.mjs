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
//   - PRÉSERVE les champs édités à la main dans fleet.json : type, statut, notes, pitch, site.
//     `pitch` (à quoi ça sert, en une phrase) et `site` (l'URL de la chose en ligne) sont ce que
//     /projets affiche. Tant qu'ils sont VIDES, ils sont re-devinés à chaque passage — depuis la
//     description et le site du repo sur GitHub, sinon depuis GitHub Pages. Donc renseigner un
//     repo depuis l'interface GitHub (y compris au téléphone) suffit à amorcer sa fiche ; dès
//     qu'un champ est rempli, il est stable et seule une main le rechange.
//   - `statut` = où en est le DÉVELOPPEMENT du projet (pas une tâche) : `actif` en cours ·
//     `veille` v1 sortie et en service, plus de dev · `archivé` fini ou abandonné. Il ne dit
//     PAS ce qui est en service : la surveillance suit les `crons`, donc un repo `archivé`
//     dont le cron tourne encore reste dans le brief et le bilan de tokens. Chaque lecteur
//     choisit : /backlog et /dispatch ne voient que `actif`, le kit aussi, le brief voit
//     `actif` + `veille` + tout ce qui a un cron.
// Le registre est LA source que lisent /projets, /dispatch, le brief quotidien, la veille
// mensuelle et l'hygiène hebdo — aucune liste de repos en dur ailleurs.
//
// Usage : node scripts/fleet.mjs              → toute la flotte (cron du lundi)
//         node scripts/fleet.mjs --repo <nom> → un seul repo, les autres entrées intactes
//
// Le mode --repo existe pour la fin de course de `/equiper` : rafraîchir 16 repos pour en
// constater UN seul coûtait assez de temps pour qu'une session saute l'étape, et le registre
// annonçait alors l'ancien état jusqu'au cron du lundi. ⚠️ À lancer APRÈS le merge de la PR
// d'équipement : `.kit-version` est lu sur la branche par défaut, donc avant le merge ce
// script constaterait fidèlement… l'état d'avant.
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

const iRepo = process.argv.indexOf("--repo");
const cible = iRepo !== -1 ? process.argv[iRepo + 1] : null;
if (iRepo !== -1 && !cible) {
  console.error("--repo attend un nom de repo.");
  process.exit(1);
}

console.log(cible ? `Rafraîchissement de ${OWNER}/${cible}...` : `Découverte de la flotte (${OWNER})...`);
let repos = JSON.parse(
  gh(["repo", "list", OWNER, "--limit", "200", "--json",
    "name,visibility,isArchived,primaryLanguage,defaultBranchRef,description,homepageUrl"])
);
if (cible) {
  repos = repos.filter((r) => r.name === cible);
  if (!repos.length) {
    console.error(`Repo « ${cible} » introuvable chez ${OWNER} (ou archivé).`);
    process.exit(1);
  }
}

const b64 = (s) => Buffer.from(s.replace(/\n/g, ""), "base64").toString("utf8");

// Dernier recours pour `site` : l'URL GitHub Pages du repo (404 = Pages non activé).
// Render, Vercel et Netlify ne s'auto-découvrent pas — leurs URL se saisissent à la main, ou
// dans le champ « Website » du repo sur GitHub. Appelée seulement quand `site` est encore vide
// (court-circuit du `||`), donc zéro appel de plus une fois la flotte renseignée.
const urlPages = (name) =>
  (gh(["api", `repos/${OWNER}/${name}/pages`, "--jq", ".html_url"], true) ?? "").trim();

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
    pitch: old?.pitch || repo.description?.trim() || "",
    site: old?.site || repo.homepageUrl?.trim() || urlPages(name),
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

// En mode --repo, la seule entrée recalculée remplace (ou complète) le registre existant :
// les autres repos sont recopiés tels quels, jamais re-devinés.
let finales = entries;
if (cible) {
  const par = new Map(Object.entries(existing));
  for (const e of entries) par.set(e.repo, e);
  finales = [...par.values()].sort((a, b) => a.repo.localeCompare(b.repo));
}

mkdirSync(dirname(FLEET_PATH), { recursive: true });
writeFileSync(
  FLEET_PATH,
  JSON.stringify(
    {
      _doc: "Registre de flotte — généré par scripts/fleet.mjs. Champs manuels préservés : type, statut, notes, pitch, site. `statut` = où en est le DÉVELOPPEMENT : `actif` (en cours) · `veille` (v1 sortie et en service, plus de dev) · `archivé` (fini ou abandonné). /backlog, /dispatch et la propagation du kit ne voient que `actif`. Le statut ne dit PAS ce qui est en service : la surveillance suit les `crons`, donc un repo `archivé` dont le cron tourne reste dans le brief et le bilan de tokens. `pitch` (à quoi ça sert) et `site` (l'URL en ligne) sont ce qu'affiche /projets : tant qu'ils sont vides ils se redevinent depuis la description et le site du repo sur GitHub, sinon GitHub Pages. `dispatchable` = une issue labellisée `claude` y lance une session qui peut livrer sa PR (stub claude.yml + secret CLAUDE_CODE_OAUTH_TOKEN + Actions autorisé à créer des PR) ; `dispatch_manque` dit ce qui bloque. C'est le critère de /dispatch — pas kit_version. Lu par /projets, /dispatch, brief quotidien, veille mensuelle, hygiène.",
      updated_at: new Date().toISOString().slice(0, 16).replace("T", " "),
      kit_repo: `${OWNER}/fleet-kit`,
      repos: finales,
    },
    null,
    2
  ) + "\n",
  "utf8"
);
console.log(`Registre écrit : ${FLEET_PATH} (${finales.length} repos${cible ? `, 1 rafraîchi` : ""})`);

// Une fiche /projets sans phrase ne sert à rien, et un projet déployé sans URL est justement ce
// qu'on cherchait à ne plus avoir à retrouver. On ne réclame d'URL qu'aux types qui en ont une :
// un cron qui envoie un mail n'a pas de site, et le signaler chaque semaine serait du bruit.
const AVEC_SITE = new Set(["static", "service-node", "service-python"]);
const incompletes = (cible ? entries : finales)
  .map((r) => ({ r, manque: [!r.pitch && "pitch", AVEC_SITE.has(r.type) && !r.site && "site"].filter(Boolean) }))
  .filter(({ manque }) => manque.length);
if (incompletes.length) {
  console.log(`\nFiches /projets à compléter (${incompletes.length}) — à la main dans fleet.json, ou via`);
  console.log(`Description / Website du repo sur GitHub (repris tels quels au prochain passage) :`);
  for (const { r, manque } of incompletes) console.log(`  ${r.repo} — manque ${manque.join(" + ")}`);
}
