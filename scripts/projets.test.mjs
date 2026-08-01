#!/usr/bin/env node
// Vérif autonome de projets.mjs (pas de cadre de test dans ce repo) : rejoue des registres
// factices — dont des cas VRAIMENT présents dans fleet.json — et compare le classement à
// l'attendu. Aucun accès disque ni réseau : on n'importe que les fonctions pures.
// Usage : node scripts/projets.test.mjs (exit 0 si tout passe)
import { enMarkdown, ficheMarkdown, grouper, resoudre } from "./projets.mjs";

let echecs = 0;
const verifie = (nom, obtenu, attendu) => {
  const ok = JSON.stringify(obtenu) === JSON.stringify(attendu);
  if (!ok) {
    echecs += 1;
    console.error(`✗ ${nom}\n    attendu : ${JSON.stringify(attendu)}\n    obtenu  : ${JSON.stringify(obtenu)}`);
  } else console.log(`✓ ${nom}`);
};
const verifieVrai = (nom, condition) => verifie(nom, !!condition, true);

const projet = (repo, statut, extra = {}) =>
  ({ repo, type: "static", statut, pitch: `pitch ${repo}`, site: `https://${repo}.test`, ...extra });

// ---------- grouper : les trois états ----------
const troisEtats = grouper([
  projet("en-cours", "actif"),
  projet("sorti", "veille"),
  projet("fini", "archivé"),
]);
verifie("actif → cours", troisEtats.cours.map((p) => p.n), ["en-cours"]);
verifie("veille → livré", troisEtats.livre.map((p) => p.n), ["sorti"]);
verifie("archivé → terminé", troisEtats.termine.map((p) => p.n), ["fini"]);
verifie("un projet garde nom, pitch, url et type",
  troisEtats.cours[0], { n: "en-cours", p: "pitch en-cours", u: "https://en-cours.test", t: "static" });

// ---------- grouper : outillage, hors des trois états ----------
// Cas réel de la flotte : le repo méta qui porte le registre est `actif` en permanence, mais il
// ne doit JAMAIS peser dans « en cours » — c'est l'outillage, pas un projet qu'on finit. Idem
// pour des notes de cours (`contenu`), qui traînaient encore un statut `gelé`.
const avecMeta = grouper([
  projet("un-repo-meta", "actif", { type: "meta" }),
  projet("des-notes", "gelé", { type: "contenu" }),
  projet("vrai-projet", "actif"),
]);
verifie("type meta|contenu → outillage quel que soit le statut", avecMeta.outillage, ["un-repo-meta", "des-notes"]);
verifie("les métas ne polluent aucun des trois états",
  [avecMeta.cours.length, avecMeta.livre.length, avecMeta.termine.length], [1, 0, 0]);

// ---------- grouper : tolérance aux statuts inconnus ----------
// Pendant la migration, `gelé` traîne encore ; et rien n'empêche une main d'écrire n'importe
// quoi dans le registre. Un projet qu'on ne sait pas classer doit rester VISIBLE, pas disparaître.
const bizarres = grouper([
  projet("ancien-gele", "gelé"),
  projet("faute-de-frappe", "actifs"),
  projet("sans-statut", undefined),
]);
verifie("statut inconnu, ancien ou absent → terminé, jamais perdu",
  bizarres.termine.map((p) => p.n), ["ancien-gele", "faute-de-frappe", "sans-statut"]);

// ---------- grouper : entrée du registre encore incomplète ----------
// Avant le remplissage, `pitch` et `site` n'existent pas sur les vieilles entrées.
const nu = grouper([{ repo: "tout-nu", type: "static", statut: "actif" }]);
verifie("pitch/site absents → chaînes vides, jamais undefined",
  nu.cours[0], { n: "tout-nu", p: "", u: "", t: "static" });

// ---------- enMarkdown ----------
const md = enMarkdown(troisEtats);
verifieVrai("le markdown compte les trois états en tête", md.startsWith("# Projets — 1 en cours · 1 livré · 1 terminé"));
verifieVrai("les comptes s'accordent au pluriel",
  enMarkdown(grouper([projet("a", "veille"), projet("b", "veille")])).startsWith("# Projets — 0 en cours · 2 livrés · 0 terminé"));
verifieVrai("le markdown porte l'URL du site", md.includes("https://sorti.test"));
verifieVrai("le markdown porte les libellés en clair", md.includes("🔵 Livré (1)"));
const seulementCours = enMarkdown(grouper([projet("seul", "actif")]));
verifieVrai("un état vide n'affiche pas sa section", !seulementCours.includes("Terminé"));
verifieVrai("pas d'outillage → pas de pied", !seulementCours.includes("Outillage"));
verifieVrai("outillage listé en pied", enMarkdown(avecMeta).includes("Outillage & notes : un-repo-meta · des-notes"));

// ---------- ficheMarkdown ----------
const fiche = ficheMarkdown({
  repo: "un-outil", type: "static", statut: "veille", pitch: "Tour de contrôle",
  site: "https://exemple.github.io/un-outil/", default_branch: "main", visibility: "public",
  kit_version: "1.6.0", dispatchable: true, crons: ["veilleur.yml"], notes: "une note",
});
verifieVrai("la fiche titre avec l'état en clair", fiche.startsWith("# un-outil — 🔵 Livré"));
verifieVrai("la fiche porte le site", fiche.includes("**En ligne :** https://exemple.github.io/un-outil/"));
verifieVrai("la fiche porte les crons", fiche.includes("**Crons :** veilleur.yml"));
const ficheNue = ficheMarkdown({ repo: "x", type: "static", statut: "actif", dispatchable: false, dispatch_manque: ["claude.yml"] });
verifieVrai("sans pitch, la fiche dit quoi faire", ficheNue.includes("à écrire dans fleet.json"));
verifieVrai("sans site, pas de ligne « En ligne » vide", !ficheNue.includes("En ligne"));
verifieVrai("la fiche dit ce qui bloque le dispatch", ficheNue.includes("dispatch bloqué (claude.yml)"));

// ---------- resoudre ----------
// Cas réel du registre : deux repos dont le nom de l'un préfixe entièrement celui de l'autre
// (un doublon jamais nettoyé, et sa version au nom long). Sans priorité à l'exact, le court
// devient INDÉSIGNABLE — la skill répondrait « 2 repos correspondent » indéfiniment.
const prefixes = [{ repo: "Notes" }, { repo: "Notes---version-longue-du-nom" }];
verifie("un nom exact gagne sur ses préfixés", resoudre(prefixes, "Notes").map((r) => r.repo), ["Notes"]);
verifie("la casse est ignorée", resoudre(prefixes, "notes").map((r) => r.repo), ["Notes"]);
verifie("une sous-chaîne ambiguë renvoie tout", resoudre(prefixes, "version").map((r) => r.repo),
  ["Notes---version-longue-du-nom"]);
verifie("aucun match → liste vide", resoudre(prefixes, "zzz"), []);

console.log(echecs ? `\n${echecs} échec(s).` : "\nTout passe.");
process.exit(echecs ? 1 : 0);
