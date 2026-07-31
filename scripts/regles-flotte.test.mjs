#!/usr/bin/env node
// Tests de la fusion additive des règles de flotte (aucun réseau, aucun gh).
//   node --test scripts/regles-flotte.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { sectionRegles, puces, cle, fusionner, TITRE_SECTION } from "./regles-flotte.mjs";

const KIT = [
  "- **Lis `MAP.md` avant toute exploration** ; n'explore que ce qu'elle ne couvre pas.",
  "- **Aucune session ne rend la main sans avoir vérifié** : lance `{{COMMANDE_VERIFY}}`",
  "  (ou build + tests) et regarde le résultat avant de conclure.",
  "- Branche + PR, **jamais de push direct sur `main`**. Commits **en français**.",
  "- **Règle du clair** — ce qui est destiné à l'humain se lit sans être technicien.",
  "  - **Item de backlog** : le titre dit ce que ça change pour lui.",
  "  - Test : si quelqu'un qui ne code pas ne peut pas choisir, c'est raté.",
].join("\n");

const repoMd = (regles) =>
  ["# CLAUDE.md — mon-repo", "", "> Un service.", "", TITRE_SECTION, regles, "", "## Stack & commandes", "- Stack : Node.", ""].join("\n");

const REPO_AVANT = [
  "- **Lis `MAP.md` avant toute exploration** ; n'explore que ce qu'elle ne couvre pas.",
  "- **Aucune session ne rend la main sans avoir vérifié** : lance `npm test`",
  "  (ou build + tests) et regarde le résultat avant de conclure.",
  "- Branche + PR, **jamais de push direct sur `main`**. Commits **en français**.",
  "- **Consigne maison** : ne jamais toucher aux migrations SQL sans moi.",
].join("\n");

test("sectionRegles isole la section et rend null si elle manque", () => {
  const s = sectionRegles(repoMd(REPO_AVANT));
  assert.ok(s.avant.endsWith(TITRE_SECTION));
  assert.ok(s.corps.includes("Consigne maison"));
  assert.ok(s.apres.startsWith("## Stack & commandes"));
  assert.equal(sectionRegles("# CLAUDE.md\n\n## Stack\n- rien"), null);
  assert.equal(sectionRegles(""), null);
});

test("un titre numéroté est reconnu (repo qui numérote son plan)", () => {
  const md = ["# CLAUDE.md", "", "## 0. Règles de travail (flotte)", REPO_AVANT, "", "## 1. Mission", "- bla", ""].join("\n");
  assert.ok(sectionRegles(md), "section trouvée malgré le « 0. »");
  const r = fusionner(md, KIT);
  assert.deepEqual(r.ajoutees, ["règle du clair"]);
  assert.ok(r.contenu.includes("## 0. Règles de travail (flotte)"), "le titre du repo est conservé tel quel");
  assert.ok(r.contenu.includes("## 1. Mission"));
});

test("puces regroupe continuations et sous-puces avec leur puce", () => {
  const p = puces(KIT);
  assert.equal(p.length, 4);
  assert.ok(p[1].includes("(ou build + tests)"), "ligne de continuation rattachée");
  assert.ok(p[3].includes("Item de backlog"), "sous-puce rattachée");
  assert.ok(p[3].includes("c'est raté"));
});

test("cle ne reconnaît qu'un intitulé en gras EN TÊTE", () => {
  assert.equal(cle("- **Règle du clair** — bla"), "règle du clair");
  assert.equal(cle("- **Règle du clair**\n  suite"), "règle du clair");
  assert.equal(cle("- Branche + PR, **jamais de push**."), null, "gras au milieu = pas d'identité");
  assert.equal(cle("- 3e récurrence → écris un script."), null);
});

test("une règle sans intitulé en gras n'est jamais propagée (risque de doublon)", () => {
  // Cas réel : le repo a adapté « Branche + PR vers master », le kit dit « sur main ».
  const repo = repoMd(
    [
      "- **Lis `MAP.md` avant toute exploration** ; n'explore que ce qu'elle ne couvre pas.",
      "- Branche + PR **vers `master`** (branche par défaut ici), jamais de push direct.",
    ].join("\n"),
  );
  const r = fusionner(repo, KIT);
  assert.deepEqual(r.ajoutees, ["règle du clair"], "seule la règle identifiable est ajoutée");
  assert.ok(!r.contenu.includes("jamais de push direct sur `main`"), "pas de consigne contradictoire ajoutée");
  assert.ok(r.ignorees.some((i) => i.motif.startsWith("pas d'intitulé en gras")));
});

test("fusionner insère la règle manquante et rien d'autre", () => {
  const r = fusionner(repoMd(REPO_AVANT), KIT);
  assert.deepEqual(r.ajoutees, ["règle du clair"]);
  assert.ok(r.contenu.includes("- **Règle du clair** —"));
  assert.ok(r.contenu.includes("  - **Item de backlog**"), "sous-puces insérées aussi");
  assert.ok(r.contenu.includes("Consigne maison"), "la consigne propre au repo survit");
  assert.ok(r.contenu.includes("lance `npm test`"), "la commande de vérif du repo n'est pas écrasée");
  assert.ok(r.contenu.includes("## Stack & commandes\n- Stack : Node."), "le reste du fichier est intact");
  assert.match(r.contenu, /c'est raté\.\n\n## Stack/, "ligne vide conservée avant la section suivante");
});

test("fusionner est idempotent", () => {
  const un = fusionner(repoMd(REPO_AVANT), KIT);
  const deux = fusionner(un.contenu, KIT);
  assert.deepEqual(deux.ajoutees, []);
  assert.equal(deux.contenu, un.contenu);
});

test("une puce à placeholder n'est jamais insérée", () => {
  const sansVerif = REPO_AVANT.split("\n").filter((l) => !l.includes("npm test") && !l.includes("(ou build")).join("\n");
  const r = fusionner(repoMd(sansVerif), KIT);
  assert.ok(!r.contenu.includes("{{COMMANDE_VERIFY}}"));
  assert.ok(r.ignorees.some((i) => i.quoi === "aucune session ne rend la main sans avoir vérifié" && i.motif === "placeholder à remplir"));
  assert.deepEqual(r.ajoutees, ["règle du clair"]);
});

test("un CLAUDE.md sans section de règles n'est pas touché (null)", () => {
  assert.equal(fusionner("# CLAUDE.md — repo maison\n\n## Stack\n- rien", KIT), null);
});

test("une règle re-formulée par le kit REMPLACE l'ancienne puce du repo", () => {
  const ANCIEN = "- 3e récurrence d'une même tâche → écris un script réutilisable (`scripts/`), pas juste le résultat.";
  const NOUVEAU = "- **Écris l'outil, pas l'output** — à la 3e récurrence d'une même tâche, écris un script\n  réutilisable (`scripts/`), pas juste le résultat.";
  const kit = [KIT, NOUVEAU].join("\n");
  const r = fusionner(repoMd([REPO_AVANT, ANCIEN].join("\n")), kit);
  assert.deepEqual(r.migrees, ["écris l'outil, pas l'output"]);
  assert.ok(!r.contenu.includes(ANCIEN), "l'ancienne formulation a disparu");
  assert.equal(r.contenu.split("récurrence d'une même tâche").length - 1, 1, "une seule occurrence, pas deux");
  assert.ok(r.contenu.includes("**Écris l'outil, pas l'output**"));
  // Idempotent : au passage suivant la règle est reconnue par son intitulé.
  const deux = fusionner(r.contenu, kit);
  assert.deepEqual(deux.migrees, []);
  assert.equal(deux.contenu, r.contenu);
});

test("un repo qui a adapté la règle n'est ni migré ni complété, mais signalé", () => {
  const NOUVEAU = "- **Branche + PR** — jamais de push direct sur `main`. Commits **en français**.";
  const kit = [KIT, NOUVEAU].join("\n");
  const local = "- Branche + PR **vers `master`** (branche par défaut ici), jamais de push direct.";
  const sansBranche = REPO_AVANT.split("\n").filter((l) => !l.startsWith("- Branche + PR,")).join("\n");
  const r = fusionner(repoMd([sansBranche, local].join("\n")), kit);
  assert.deepEqual(r.migrees, []);
  assert.ok(r.contenu.includes(local), "la décision locale survit");
  assert.ok(!r.contenu.includes("**Branche + PR** —"), "pas de consigne jumelle ajoutée");
  assert.ok(r.ignorees.some((i) => i.quoi === "branche + pr" && i.motif.startsWith("formulation locale")));
});

test("une règle re-formulée mais JAMAIS reçue par le repo est insérée", () => {
  const NOUVEAU = "- **Écris l'outil, pas l'output** — à la 3e récurrence d'une même tâche, écris un script.";
  const kit = [KIT, NOUVEAU].join("\n");
  // REPO_AVANT ne parle nulle part de récurrence ni de script réutilisable.
  const r = fusionner(repoMd(REPO_AVANT), kit);
  assert.ok(r.ajoutees.includes("écris l'outil, pas l'output"), "insérée, pas signalée");
  assert.deepEqual(r.migrees, []);
  assert.ok(!r.ignorees.some((i) => i.quoi === "écris l'outil, pas l'output"));
});

test("une règle déjà présente sous une casse différente n'est pas dupliquée", () => {
  const r = fusionner(repoMd(REPO_AVANT + "\n- **RÈGLE DU CLAIR** : déjà là, formulée autrement."), KIT);
  assert.deepEqual(r.ajoutees, []);
});

console.log("Tout passe.");
