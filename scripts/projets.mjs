#!/usr/bin/env node
// Vue d'ensemble des projets — ce que lit la skill /projets.
//
// Répond à une question qu'aucun autre outil ne couvrait : « qu'est-ce que j'ai fait, à quoi ça
// sert, où c'est en ligne, et est-ce que j'ai encore à m'en occuper ? » Le backlog dit ce qu'il
// RESTE à faire ; ceci dit ce qui EXISTE.
//
// Zéro appel réseau : tout vient de fleet/fleet.json, déjà présent dans le checkout. C'est ce
// qui rend /projets instantané là où /backlog interroge 15 repos. Le prix à payer est que la
// vue vaut ce que vaut le registre — un `git pull` suffit à la rafraîchir.
//
// Trois états de projet, et un quatrième groupe qui n'en est pas un :
//   actif   → 🟢 En cours   je code dessus en ce moment
//   veille  → 🔵 Livré      v1 sortie et en service, plus de dev, pannes toujours surveillées
//   archivé → ⚪ Terminé    fini ou abandonné
//   type meta|contenu → « Outillage & notes » : ni projets ni chantiers, ils sortent des trois
//   groupes quel que soit leur statut. C'est le geste qui allège vraiment la vue : sans lui, la
//   moitié de la liste est faite de repos qu'on ne « finit » jamais.
// Tout statut inconnu (ou l'ancien `gelé`) est rangé dans Terminé plutôt qu'ignoré : un projet
// qu'on ne sait pas classer doit rester visible.
//
// Usage : node scripts/projets.mjs              → markdown lisible (repli de la skill)
//         node scripts/projets.mjs --widget     → JSON compact, injecté dans le widget
//         node scripts/projets.mjs <repo>       → la fiche d'un seul projet
//         node scripts/projets.mjs <repo> --json → cette fiche en JSON
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // .../claude-ops

// Les libellés vivent ici et dans widget-template.html — nulle part ailleurs. Le registre, lui,
// ne connaît que les valeurs techniques : les renommer casserait six lecteurs pour un mot.
export const ETATS = {
  actif: { cle: "cours", icone: "🟢", label: "En cours" },
  veille: { cle: "livre", icone: "🔵", label: "Livré" },
  archivé: { cle: "termine", icone: "⚪", label: "Terminé" },
};
const HORS_PROJET = new Set(["meta", "contenu"]);

const cleDeStatut = (statut) => ETATS[String(statut ?? "").trim()]?.cle ?? "termine";

/** Registre → { cours, livre, termine, outillage } ; projets réduits à {n,p,u,t}. */
export function grouper(repos) {
  const vue = { cours: [], livre: [], termine: [], outillage: [] };
  for (const r of repos ?? []) {
    if (HORS_PROJET.has(r.type)) {
      vue.outillage.push(r.repo);
      continue;
    }
    vue[cleDeStatut(r.statut)].push({ n: r.repo, p: r.pitch ?? "", u: r.site ?? "", t: r.type });
  }
  return vue;
}

/** Vue → markdown. Repli quand le widget n'est pas disponible (session sans outil de rendu). */
export function enMarkdown(vue) {
  const pluriel = (n, mot) => `${n} ${mot}${n > 1 ? "s" : ""}`;
  const lignes = [
    `# Projets — ${vue.cours.length} en cours · ${pluriel(vue.livre.length, "livré")} · ${pluriel(vue.termine.length, "terminé")}`,
  ];
  for (const { cle, icone, label } of Object.values(ETATS)) {
    if (!vue[cle].length) continue;
    lignes.push("", `## ${icone} ${label} (${vue[cle].length})`, "");
    for (const p of vue[cle]) {
      const bouts = [`- **${p.n}**`];
      if (p.p) bouts.push(`— ${p.p}`);
      if (p.u) bouts.push(`· ${p.u}`);
      lignes.push(bouts.join(" "));
    }
  }
  if (vue.outillage.length) lignes.push("", `Outillage & notes : ${vue.outillage.join(" · ")}`);
  return lignes.join("\n");
}

/** Une entrée du registre → sa fiche markdown. Ici on montre tout, y compris la technique. */
export function ficheMarkdown(r) {
  const { icone, label } = ETATS[String(r.statut ?? "").trim()] ?? ETATS["archivé"];
  const lignes = [`# ${r.repo} — ${icone} ${label}`, ""];
  lignes.push(r.pitch || "_Pas encore de description — à écrire dans fleet.json ou sur GitHub._");
  if (r.site) lignes.push("", `**En ligne :** ${r.site}`);
  const tech = [r.type, `branche ${r.default_branch ?? "?"}`, r.visibility];
  tech.push(r.kit_version ? `kit ${r.kit_version}` : "sans kit");
  tech.push(r.dispatchable ? "dispatchable" : `dispatch bloqué (${(r.dispatch_manque ?? []).join(", ") || "?"})`);
  lignes.push("", `**Technique :** ${tech.join(" · ")}`);
  if (r.crons?.length) lignes.push(`**Crons :** ${r.crons.join(" · ")}`);
  if (r.notes) lignes.push("", `**Notes :** ${r.notes}`);
  return lignes.join("\n");
}

/** Résolution approximative d'un nom de repo — même règle que /backlog <repo>. */
export function resoudre(repos, filtre) {
  const f = filtre.toLowerCase().trim();
  const exact = repos.find((r) => r.repo.toLowerCase() === f);
  return exact ? [exact] : repos.filter((r) => r.repo.toLowerCase().includes(f));
}

function main() {
  const args = process.argv.slice(2);
  const chemin = join(ROOT, "fleet", "fleet.json");
  // Registre absent = l'état normal d'un clone frais (seul `fleet.example.json` est versionné).
  // C'est donc le premier mur que rencontre quelqu'un qui essaie la commande : une pile Node
  // ne lui dit pas quoi faire, une phrase si.
  let brut;
  try {
    brut = readFileSync(chemin, "utf8");
  } catch {
    console.error(`Pas de registre de flotte : ${chemin} est absent.`);
    console.error("Génère-le d'abord (nécessite `gh` authentifié) :\n  node scripts/fleet.mjs");
    process.exit(1);
  }
  const registre = JSON.parse(brut);
  const repos = registre.repos ?? [];
  const filtre = args.find((a) => !a.startsWith("--")) ?? "";

  if (filtre) {
    const trouves = resoudre(repos, filtre);
    if (!trouves.length) {
      console.error(`Aucun repo ne correspond à « ${filtre} ». Lance sans argument pour la liste.`);
      process.exit(1);
    }
    if (trouves.length > 1) {
      console.error(`« ${filtre} » correspond à ${trouves.length} repos : ${trouves.map((r) => r.repo).join(", ")}`);
      process.exit(1);
    }
    const [r] = trouves;
    process.stdout.write(args.includes("--json") ? JSON.stringify(r) + "\n" : ficheMarkdown(r) + "\n");
    return;
  }

  const vue = grouper(repos);
  // JSON compact : injecté tel quel dans le widget (`const DATA=…;`), pas besoin d'indentation.
  process.stdout.write(
    args.includes("--widget") || args.includes("--json")
      ? JSON.stringify(vue) + "\n"
      : enMarkdown(vue) + "\n"
  );
}

// Corps CLI seulement en exécution directe : le test importe ce module et ne doit pas lire
// le registre de la machine.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
