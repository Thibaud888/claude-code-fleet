#!/usr/bin/env node
// Vérif autonome de backlog-collect.mjs (pas de cadre de test dans ce repo) : rejoue des
// BACKLOG.md — dont des extraits VRAIMENT observés sur la flotte — et compare le parsing à
// l'attendu. Aucun accès réseau : on n'importe que les fonctions pures.
// Usage : node scripts/backlog-collect.test.mjs (exit 0 si tout passe)
import { agrege, coupeTitre, parseOpen } from "./backlog-collect.mjs";

let echecs = 0;
const verifie = (nom, obtenu, attendu) => {
  const ok = JSON.stringify(obtenu) === JSON.stringify(attendu);
  if (!ok) {
    echecs += 1;
    console.error(`✗ ${nom}\n    attendu : ${JSON.stringify(attendu)}\n    obtenu  : ${JSON.stringify(obtenu)}`);
  } else console.log(`✓ ${nom}`);
};

// ---------- coupeTitre : non-régression ----------
verifie("titre coupé au tiret cadratin",
  coupeTitre("Faire la chose — contexte et DoD"), { t: "Faire la chose", d: "contexte et DoD" });
verifie("colon espacé en repli",
  coupeTitre("Faire la chose : contexte"), { t: "Faire la chose", d: "contexte" });
verifie("un tiret DANS des parenthèses ne coupe pas",
  coupeTitre("Chose (a — b) — vrai détail"), { t: "Chose (a — b)", d: "vrai détail" });
verifie("pas de séparateur : tout est titre",
  coupeTitre("Chose sans détail"), { t: "Chose sans détail", d: "" });

// ---------- parseOpen : marqueurs ----------
// Cas réel relevé sur un repo de la flotte : item multi-lignes, continuation indentée recollée.
const MULTI = [
  "# Backlog", "",
  "- [ ] Sortir TikTok du mode privé — revoir",
  "  `scripts/upload-tiktok.mjs` et la retentative du cron.",
  "- [x] Un item fait, jamais lu ici",
  "  sa continuation non plus",
].join("\n");
verifie("item ouvert multi-lignes recollé, `- [x]` ignoré",
  parseOpen(MULTI), [{ n: 1, p: null, t: "Sortir TikTok du mode privé",
    d: "revoir `scripts/upload-tiktok.mjs` et la retentative du cron.", gel: false }]);

verifie("priorité seule",
  parseOpen("- [ ] (P2) Chose — détail").map(({ p, gel, t }) => ({ p, gel, t })),
  [{ p: "P2", gel: false, t: "Chose" }]);

// Les deux ordres doivent marcher : personne ne retiendra lequel est le bon.
verifie("(gelé) puis (P2)",
  parseOpen("- [ ] (gelé) (P2) Chose — détail").map(({ p, gel, t }) => ({ p, gel, t })),
  [{ p: "P2", gel: true, t: "Chose" }]);
verifie("(P2) puis (gelé)",
  parseOpen("- [ ] (P2) (gelé) Chose — détail").map(({ p, gel, t }) => ({ p, gel, t })),
  [{ p: "P2", gel: true, t: "Chose" }]);
verifie("gel sans priorité",
  parseOpen("- [ ] (gelé) Chose — détail").map(({ p, gel, t }) => ({ p, gel, t })),
  [{ p: null, gel: true, t: "Chose" }]);
verifie("tolérance à l'accent oublié : (gele)",
  parseOpen("- [ ] (gele) Chose").map(({ gel }) => gel), [true]);

// Cas réel (RAG-WBC) : le titre est en gras, marqueur compris — le gras masquait la priorité.
verifie("marqueur sous du gras markdown",
  parseOpen("- [ ] **(P1) (gelé) Chose en gras** — détail").map(({ p, gel, t }) => ({ p, gel, t })),
  [{ p: "P1", gel: true, t: "Chose en gras" }]);

// Le piège à éviter : un item qui PARLE de gel n'est pas gelé.
verifie("« (gelé) » ailleurs qu'en tête ne gèle rien",
  parseOpen("- [ ] Chose — le reste est (gelé) pour l'instant").map(({ gel }) => gel), [false]);

// ---------- Numérotation : le point qui rend `degele` fiable ----------
const TROIS = [
  "- [ ] Premier — a",
  "- [ ] (gelé) Deuxième — b",
  "- [ ] Troisième — c",
].join("\n");
verifie("DoD : un gelé garde son n° et ne décale pas les suivants",
  parseOpen(TROIS).map(({ n, gel }) => ({ n, gel })),
  [{ n: 1, gel: false }, { n: 2, gel: true }, { n: 3, gel: false }]);

// ---------- agrege : ce que voit la vue ----------
const vide = () => ({ repos: [], empty: [], frozen: [] });

const a = agrege(vide(), { nom: "repo-a", equipped: true, session: false, raw: TROIS });
verifie("DoD : le gelé sort de la vue", a.repos[0].items.map((i) => i.n), [1, 3]);
verifie("DoD : le gelé est compté à part, avec son repo et son n°",
  a.frozen, [{ repo: "repo-a", n: 2, p: null, t: "Deuxième", d: "b" }]);
verifie("pas de clé `gel` dans les items de la vue (JSON injecté au plus court)",
  Object.keys(a.repos[0].items[0]), ["n", "p", "t", "d"]);

const b = agrege(vide(), { nom: "repo-b", equipped: true, session: false, raw: "- [ ] (gelé) Seule — x" });
verifie("repo dont TOUT est gelé : pas dans la vue…", b.repos.length, 0);
verifie("…mais le motif le dit, il ne disparaît pas", b.empty, ["repo-b (à jour · 1 gelé)"]);
verifie("…et il reste dans le congélateur", b.frozen.length, 1);

const c = agrege(vide(), { nom: "repo-c", equipped: false, session: true, raw: "- [ ] Chose — x" });
verifie("non-régression : badges equipped/session inchangés",
  { equipped: c.repos[0].equipped, session: c.repos[0].session }, { equipped: false, session: true });
verifie("non-régression : repo sans BACKLOG.md",
  agrege(vide(), { nom: "repo-d", equipped: true, session: false, raw: null }).empty,
  ["repo-d (pas de BACKLOG.md)"]);
verifie("non-régression : repo à jour (aucun gel) garde son motif nu",
  agrege(vide(), { nom: "repo-e", equipped: true, session: false, raw: "- [x] fait" }).empty,
  ["repo-e (à jour)"]);

const pluriel = agrege(vide(), { nom: "r", equipped: true, session: false, raw: "- [ ] (gelé) A\n- [ ] (gelé) B" });
verifie("accord au pluriel", pluriel.empty, ["r (à jour · 2 gelés)"]);

console.log(echecs ? `\n${echecs} échec(s).` : "\nTout passe.");
process.exit(echecs ? 1 : 0);
