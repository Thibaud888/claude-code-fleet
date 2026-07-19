#!/usr/bin/env node
// Propage les fichiers du kit de flotte (fleet-kit) vers les repos équipés.
//
// Ne propage QUE ce que le kit possède et fait évoluer :
//   - les skills de session `templates/common/.claude/skills/<nom>/SKILL.md` (écrasées) ;
//   - le fichier `.kit-version` (aligné sur fleet-kit/VERSION).
// Ne touche JAMAIS : un skill maison propre au repo (nom absent du kit), CLAUDE.md,
// l'allowlist, les workflows. Ces fichiers-là restent du ressort de `/equiper` (merge doux).
//
// Pour chaque repo actif du registre dont le `.kit-version` est en retard :
//   1 commit sur une branche `chore/kit-flotte-v<VERSION>` (API Git Data, pas de clone),
//   1 PR, et auto-merge (squash) dès CI verte — sauf si le repo porte `.claude/no-auto-merge`.
// Idempotent : un repo déjà à jour est ignoré (aucun diff, aucune PR).
//
// Usage :
//   node scripts/kit-propager.mjs --dry-run      # aperçu, n'écrit rien
//   node scripts/kit-propager.mjs                # propage
//   node scripts/kit-propager.mjs --repo <nom>   # un seul repo
//   node scripts/kit-propager.mjs --no-merge     # PRs ouvertes, sans auto-merge
// Prérequis : gh CLI authentifié (local), ou GH_TOKEN/FLEET_GH_TOKEN (PAT cross-repo) en Actions.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OWNER = process.env.FLEET_OWNER ?? "VOTRE-COMPTE";
const KIT = `${OWNER}/fleet-kit`;
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FLEET_PATH = join(ROOT, "fleet", "fleet.json");

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const NO_MERGE = args.includes("--no-merge");
const ONLY = args.includes("--repo") ? args[args.indexOf("--repo") + 1] : null;

// `entree` : corps JSON envoyé sur stdin (pour les payloads que `-f` ne sait pas exprimer).
const gh = (a, ok = false, entree = undefined) => {
  try {
    return execFileSync("gh", a, {
      encoding: "utf8",
      input: entree,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    if (ok) return null;
    throw new Error(`gh ${a.slice(0, 3).join(" ")} : ${String(e.stderr || e.message).trim()}`);
  }
};
const ghJson = (a, ok = false, entree = undefined) => {
  const out = gh(a, ok, entree);
  return out === null ? null : JSON.parse(out);
};
// Contenu d'un fichier d'un repo (null si absent).
const contenu = (repo, chemin, ref) => {
  const q = ref ? `?ref=${ref}` : "";
  const r = ghJson(["api", `repos/${repo}/contents/${chemin}${q}`], true);
  return r?.content ? Buffer.from(r.content, "base64").toString("utf8") : null;
};

// ---- 1. Ce que le kit veut propager -------------------------------------------------
const version = contenu(KIT, "VERSION")?.trim();
if (!version) throw new Error(`VERSION introuvable sur ${KIT}`);

const dossiers = ghJson(["api", `repos/${KIT}/contents/templates/common/.claude/skills`], true) ?? [];
const skills = dossiers.filter((d) => d.type === "dir").map((d) => d.name);
if (!skills.length) throw new Error("aucun skill trouvé dans templates/common/.claude/skills");

const aPoser = new Map([[".kit-version", `${version}\n`]]);
for (const s of skills) {
  const c = contenu(KIT, `templates/common/.claude/skills/${s}/SKILL.md`);
  if (c) aPoser.set(`.claude/skills/${s}/SKILL.md`, c);
}
console.log(`Kit ${KIT} v${version} — ${skills.length} skills : ${skills.join(", ")}\n`);

// ---- 2. Les repos en retard ----------------------------------------------------------
const registre = JSON.parse(readFileSync(FLEET_PATH, "utf8"));
const cibles = registre.repos.filter(
  (r) => r.statut === "actif" && r.kit_version && r.kit_version !== version && (!ONLY || r.repo === ONLY),
);
if (!cibles.length) {
  console.log("Aucun repo en retard : toute la flotte est à jour.");
  process.exit(0);
}
console.log(`${cibles.length} repo(s) en retard : ${cibles.map((r) => `${r.repo} (${r.kit_version})`).join(", ")}\n`);

// ---- 3. Propagation, repo par repo ---------------------------------------------------
const bilan = [];
for (const r of cibles) {
  const repo = `${OWNER}/${r.repo}`;
  const branche = `chore/kit-flotte-v${version}`;
  try {
    // Ce qui change réellement (idempotence : on ne commite que les vrais diffs).
    const diffs = [...aPoser].filter(([p, c]) => contenu(repo, p, r.default_branch) !== c);
    if (!diffs.length) {
      console.log(`○ ${r.repo} — déjà à jour (aucun diff)`);
      bilan.push({ repo: r.repo, etat: "déjà à jour" });
      continue;
    }
    const nouveaux = diffs.filter(([p]) => p !== ".kit-version").map(([p]) => p.split("/")[2]);
    if (DRY) {
      console.log(`→ ${r.repo} — poserait : ${nouveaux.join(", ") || "(rien)"} + .kit-version ${r.kit_version} → ${version}`);
      bilan.push({ repo: r.repo, etat: "dry-run" });
      continue;
    }

    // Une PR de propagation encore ouverte (repo en no-auto-merge, ou CI rouge) : ne pas
    // la recréer ni forcer la branche — on attend la relecture. Sans ce garde, chaque
    // passage hebdo échouerait sur `gh pr create` (« already exists »).
    const prExistante = ghJson(["pr", "list", "--repo", repo, "--head", branche,
      "--state", "open", "--json", "url"], true)?.[0];
    if (prExistante) {
      console.log(`○ ${r.repo} — PR déjà ouverte (en attente de relecture) : ${prExistante.url}`);
      bilan.push({ repo: r.repo, etat: "PR déjà ouverte (en attente)", url: prExistante.url });
      continue;
    }

    // Commit unique via l'API Git Data (aucun clone).
    const base = ghJson(["api", `repos/${repo}/git/ref/heads/${r.default_branch}`]).object.sha;
    const baseTree = ghJson(["api", `repos/${repo}/git/commits/${base}`]).tree.sha;
    const tree = diffs.map(([path, c]) => ({
      path,
      mode: "100644",
      type: "blob",
      sha: ghJson(["api", `repos/${repo}/git/blobs`, "--input", "-"], false,
        JSON.stringify({ content: c, encoding: "utf-8" })).sha,
    }));
    const arbre = ghJson(["api", `repos/${repo}/git/trees`, "--input", "-"], false,
      JSON.stringify({ base_tree: baseTree, tree }));
    const message =
      `chore: kit de flotte v${version}\n\n` +
      `Skills de session du kit alignées (${nouveaux.join(", ") || "aucune"}).\n` +
      `Propagé par claude-ops/scripts/kit-propager.mjs.\n\n` +
      `Co-Authored-By: Claude <noreply@anthropic.com>`;
    const commit = ghJson(["api", `repos/${repo}/git/commits`, "--input", "-"], false,
      JSON.stringify({ message, tree: arbre.sha, parents: [base] }));
    gh(["api", "-X", "POST", `repos/${repo}/git/refs`, "-f", `ref=refs/heads/${branche}`, "-f", `sha=${commit.sha}`], true) ??
      gh(["api", "-X", "PATCH", `repos/${repo}/git/refs/heads/${branche}`, "-f", `sha=${commit.sha}`, "-F", "force=true"]);

    const corps = `Propagation du kit de flotte **v${r.kit_version} → v${version}**.\n\nSkills de session alignées sur \`fleet-kit/templates/common/.claude/skills/\` : ${nouveaux.map((n) => `\`/${n}\``).join(", ") || "—"}.\nVersionnées dans le repo, donc disponibles en **session Cloud**.\n\nPR ouverte automatiquement par \`claude-ops/scripts/kit-propager.mjs\`.\n\n## Vérification\nCopie mécanique : contenu strictement identique aux fichiers de \`fleet-kit\` v${version} (aucune ligne rédigée, diff limité aux fichiers du kit listés ci-dessus).`;
    const url = gh([
      "pr", "create", "--repo", repo, "--base", r.default_branch, "--head", branche,
      "--title", `chore: kit de flotte v${version}`, "--body", corps,
    ]).trim().split("\n").pop();

    // Merge dès CI verte — même convention que fleet-kit/dispatch.yml (attendre les checks
    // puis merger), et non `--auto` : l'auto-merge natif suppose `allow_auto_merge` activé
    // sur le repo, ce qui n'est le cas d'aucun repo de la flotte.
    // Opt-out par repo : fichier `.claude/no-auto-merge` (choix explicite de relecture).
    const relecture = contenu(repo, ".claude/no-auto-merge", r.default_branch) !== null;
    let etat = "PR ouverte";
    if (relecture) {
      etat = "PR ouverte (no-auto-merge)";
    } else if (!NO_MERGE) {
      const nChecks = gh(["pr", "checks", url, "--json", "name", "--jq", "length"], true)?.trim();
      const ciVerte = !nChecks || nChecks === "0" || gh(["pr", "checks", url, "--watch", "--interval", "15"], true) !== null;
      if (!ciVerte) {
        etat = "PR ouverte (CI rouge)"; // jamais de merge à l'aveugle
      } else {
        gh(["pr", "ready", url], true); // un draft ne peut pas être mergé (405)
        etat = gh(["pr", "merge", url, "--squash", "--delete-branch"], true) === null
          ? "PR ouverte (merge refusé)"
          : "mergée";
      }
    }
    console.log(`✓ ${r.repo} — ${etat} : ${url}`);
    bilan.push({ repo: r.repo, etat, url });
  } catch (e) {
    console.log(`✗ ${r.repo} — ÉCHEC : ${e.message}`);
    bilan.push({ repo: r.repo, etat: `échec : ${e.message}` });
  }
}

console.log(`\n--- Bilan ---`);
for (const b of bilan) console.log(`${b.repo.padEnd(32)} ${b.etat}${b.url ? "  " + b.url : ""}`);
if (!DRY) console.log(`\nPense à rafraîchir le registre quand les PRs sont mergées : node scripts/fleet.mjs`);
// Un échec de propagation doit se VOIR (run rouge en Actions → veilleur/FleetView) — sinon
// le run sort vert et la dérive persiste en silence. Cas vécu : FLEET_GH_TOKEN sans la
// permission Pull requests → `gh pr create` refusé, bilan « échec », run vert (2026-07-19).
if (bilan.some((b) => b.etat.startsWith("échec"))) process.exitCode = 1;
