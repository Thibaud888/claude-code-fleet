#!/usr/bin/env node
// Vérif autonome de token-canari.mjs (pas de cadre de test dans ce repo) : rejoue des listes
// d'étapes GitHub Actions — dont celles VRAIMENT observées sur la flotte — et compare le
// verdict à l'attendu. Usage : node scripts/token-canari.test.mjs (exit 0 si tout passe)
import { etapeClaude, verdictToken } from "./token-canari.mjs";

let echecs = 0;
const verifie = (nom, obtenu, attendu) => {
  const ok = JSON.stringify(obtenu) === JSON.stringify(attendu);
  if (!ok) {
    echecs += 1;
    console.error(`✗ ${nom}\n    attendu : ${JSON.stringify(attendu)}\n    obtenu  : ${JSON.stringify(obtenu)}`);
  } else console.log(`✓ ${nom}`);
};

const step = (name, sec, conclusion = "success", t0 = "2026-07-19T13:30:00Z") => ({
  name, conclusion,
  started_at: t0,
  completed_at: new Date(Date.parse(t0) + sec * 1000).toISOString(),
});

// ---------- etapeClaude : les deux familles de workflows ----------
// Relevé réel : brief-hebdo.yml, run 29688979063 (claude-ops).
const BRIEF = [
  step("Set up job", 2), step("Run actions/checkout@v4", 1), step("Run actions/setup-node@v4", 6),
  step("Installer Claude Code", 4), step("Brief hebdo de la flotte", 177),
  step("Post Run actions/setup-node@v4", 0), step("Complete job", 0),
];
verifie("brief hebdo : l'étape qui suit l'installation",
  etapeClaude(BRIEF), { nom: "Brief hebdo de la flotte", duree_s: 177, conclusion: "success" });

// map.yml : l'étape ne porte PAS le mot « claude » — d'où l'ancrage sur l'installation.
const MAP = [
  step("Set up job", 1), step("Run actions/checkout@v4", 1),
  step("Garde — la carte doit-elle être régénérée ?", 0),
  step("Installer Claude Code", 4), step("Régénérer MAP.md", 62),
  step("Commiter si la carte a changé", 2),
];
verifie("map : étape sans le mot « claude » trouvée quand même",
  etapeClaude(MAP), { nom: "Régénérer MAP.md", duree_s: 62, conclusion: "success" });

// claude.yml (claude-code-action) n'installe rien : le nom porte l'information.
const SESSION = [
  step("Set up job", 1), step("Choisir le modèle (labels claude:haiku / claude:opus)", 0),
  step("Session Claude (issue labellisée)", 300), step("Session Claude (mention @claude)", 0, "skipped"),
];
verifie("claude.yml : repérée par son nom",
  etapeClaude(SESSION), { nom: "Session Claude (issue labellisée)", duree_s: 300, conclusion: "success" });

// Garde MAP : tout est sauté après l'installation → rien d'exploitable, pas un faux signal.
const MAP_SAUTE = [
  step("Garde — la carte doit-elle être régénérée ?", 0),
  step("Installer Claude Code", 0, "skipped"), step("Régénérer MAP.md", 0, "skipped"),
];
verifie("map sauté par sa garde : rien d'exploitable", etapeClaude(MAP_SAUTE), null);
verifie("job vide", etapeClaude([]), null);
verifie("« Installer Claude Code » n'est jamais l'étape d'appel",
  etapeClaude([step("Installer Claude Code", 3)]), null);

// ---------- verdictToken ----------
const obs = (duree_s, conclusion = "success", repo = "fleetview", wf = "MAP") =>
  ({ repo, wf, url: `https://x/${repo}`, etape: duree_s === null ? null : { duree_s, conclusion } });

verifie("un appel long = preuve que le token sert",
  verdictToken([obs(177)]).statut, "ok");
verifie("appel long en ÉCHEC : le token a quand même servi (l'échec vient d'ailleurs)",
  verdictToken([obs(310, "failure")]).statut, "ok");
verifie("60 s (plus courte session réelle observée) reste une preuve",
  verdictToken([obs(60)]).statut, "ok");

// Le cas que l'item veut attraper : rejet d'auth, 1-2 s, à répétition.
// Noms de repos neutres à dessein : ce ne sont que des étiquettes de fixture, et un vrai nom
// de repo privé ferait rougir le détecteur de fuites de publier-extrait.mjs.
const REJETS = [obs(1, "failure"), obs(2, "failure", "repo-b", "Self-heal"), obs(1, "failure", "repo-c", "MAP")];
verifie("DoD : appels retombés en 1-2 s en échec → token suspect",
  verdictToken(REJETS).statut, "suspect");
verifie("DoD : les runs fautifs sont nommés", verdictToken(REJETS).suspects.length, 3);
verifie("DoD : le message dit quoi faire",
  /régénérer|setup-token/i.test(verdictToken(REJETS).message), true);

// Non-régressions : ne pas crier pour rien.
verifie("un rejet court MAIS un appel long ailleurs → ok (la preuve l'emporte)",
  verdictToken([obs(1, "failure"), obs(177)]).statut, "ok");
verifie("appels courts mais réussis : pas de conclusion hâtive",
  verdictToken([obs(3), obs(2)]).statut, "inconnu");
verifie("aucune observation exploitable", verdictToken([]).statut, "inconnu");
verifie("étapes toutes sautées", verdictToken([obs(null), obs(null)]).statut, "inconnu");
verifie("le seuil est paramétrable",
  verdictToken([obs(20)], 60).statut, "inconnu");

console.log(echecs ? `\n${echecs} échec(s).` : "\nTout passe.");
process.exit(echecs ? 1 : 0);
