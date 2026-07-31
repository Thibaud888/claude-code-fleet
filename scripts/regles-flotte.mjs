#!/usr/bin/env node
// Fusion ADDITIVE de la section « Règles de travail (flotte) » d'un CLAUDE.md de repo avec
// celle du kit (fleet-kit/templates/common/CLAUDE.md.tpl). Logique pure, testée sans réseau
// par regles-flotte.test.mjs ; utilisée par kit-propager.mjs.
//
// Pourquoi additif, et pas une copie comme pour les skills : le CLAUDE.md d'un repo n'appartient
// PAS au kit — il porte la stack, l'archi et les pièges de ce repo, et sa section « Règles de
// travail » a pu être adaptée (commande de vérification, consigne locale). Écraser la section
// perdrait ce travail ; ne rien faire laissait les repos équipés ignorer toute règle ajoutée au
// kit après leur équipement (constaté le 2026-07-25 avec la « règle du clair », qui n'atteignait
// que les repos ré-équipés à la main). On insère donc les règles ABSENTES, jamais plus.
//
// Identité d'une règle = son intitulé EN GRAS EN TÊTE de puce (`- **Règle du clair** — …`).
// Une puce du kit sans intitulé en gras n'est PAS propagée : sans identité stable, on ne peut
// pas savoir si le repo la porte déjà sous une autre formulation, et l'insérer y créerait une
// consigne en double — voire contradictoire. Cas réel qui a fixé la règle (2026-07-26,
// dry-run) : un repo de la flotte écrit « Branche + PR **vers `master`** (la branche par
// défaut ici) » là où le kit dit « Branche + PR, **jamais de push direct sur `main`** » —
// aucune des deux ne commence par du gras, la propagation naïve aurait ajouté la seconde
// à côté de la première. Ces puces-là sont listées en sortie, à porter à la main si besoin.
// Une puce portant un placeholder `{{…}}` (ex. `{{COMMANDE_VERIFY}}`) n'est jamais insérée
// non plus : on ne saurait pas la remplir pour ce repo.

export const TITRE_SECTION = "## Règles de travail (flotte)";
// Le titre peut être NUMÉROTÉ dans un repo qui numérote son plan (`## 0. Règles de travail
// (flotte)` sur bac-maths-1ere-spe-2026) : sans cette tolérance, sa section passait pour
// absente et le repo était rangé à tort en « à porter à la main » (constaté le 2026-07-26).
const RE_TITRE = /^##\s+(?:\d+[.)]\s*)?Règles de travail \(flotte\)\s*$/;

// Découpe un markdown autour de la section de règles.
// → { avant, corps, apres } (corps = le contenu SOUS le titre) ou null si la section manque.
export function sectionRegles(md) {
  const lignes = String(md ?? "").split("\n");
  const debut = lignes.findIndex((l) => RE_TITRE.test(l.trim()));
  if (debut === -1) return null;
  let fin = lignes.length;
  for (let i = debut + 1; i < lignes.length; i++) {
    if (/^##\s/.test(lignes[i])) { fin = i; break; }
  }
  return {
    avant: lignes.slice(0, debut + 1).join("\n"),
    corps: lignes.slice(debut + 1, fin).join("\n"),
    apres: lignes.slice(fin).join("\n"),
  };
}

// Puces de premier niveau d'un corps de section (les lignes de continuation et les sous-puces
// indentées restent attachées à leur puce).
export function puces(corps) {
  const out = [];
  for (const ligne of String(corps ?? "").split("\n")) {
    if (/^-\s/.test(ligne)) out.push([ligne]);
    else if (out.length && ligne.trim()) out[out.length - 1].push(ligne);
    else if (out.length && !ligne.trim()) out[out.length - 1].push(ligne); // ligne vide interne
  }
  // Retire les lignes vides de fin de chaque puce (elles appartiennent à la mise en page).
  return out.map((l) => {
    while (l.length > 1 && !l[l.length - 1].trim()) l.pop();
    return l.join("\n");
  });
}

// Identité d'une puce : son intitulé en gras EN TÊTE, sinon null (pas d'identité stable).
export function cle(puce) {
  const gras = String(puce).match(/^-\s+\*\*(.+?)\*\*/);
  return gras ? gras[1].toLowerCase().replace(/\s+/g, " ").trim() : null;
}

// Anciennes formulations d'une règle, telles qu'elles dorment dans les repos équipés avant que
// le kit ne lui donne un intitulé en gras. Sans cette table, re-formuler une règle du kit
// AJOUTERAIT la nouvelle version à côté de l'ancienne (clés différentes) : deux consignes
// jumelles dans le même fichier. Avec elle, la puce du repo est REMPLACÉE — et seulement si son
// texte est exactement l'ancienne formulation du kit. Un repo qui a adapté la règle
// (par exemple « Branche + PR **vers `master`** ») ne correspond à aucune entrée :
// il n'est ni migré ni complété, il est SIGNALÉ. C'est voulu — deviner y écraserait une décision.
// Comparaison sur le texte normalisé (espaces et retours à la ligne écrasés).
// `sonde` répond à la question « le repo parle-t-il DÉJÀ de cette règle ? » et sépare les deux
// cas que la seule liste `anciens` confondait : puce reformulée par le repo (on ne touche à
// rien, on signale) vs règle jamais reçue (on l'insère comme n'importe quelle autre).
export const MIGRATIONS = [
  {
    cle: "branche + pr",
    anciens: ["Branche + PR, **jamais de push direct sur `main`**. Commits **en français**."],
    sonde: /branche \+ pr|push direct/i,
  },
  {
    cle: "1 session = 1 item = 1 pr",
    anciens: ["1 session = 1 item de `BACKLOG.md` = 1 PR ; mets à jour `BACKLOG.md` en fin de session."],
    sonde: /1 session *= *1 item/i,
  },
  {
    cle: "écris l'outil, pas l'output",
    anciens: ["3e récurrence d'une même tâche → écris un script réutilisable (`scripts/`), pas juste le résultat."],
    sonde: /3e récurrence|script réutilisable/i,
  },
];

const normaliser = (puce) => String(puce).replace(/^-\s+/, "").replace(/\s+/g, " ").trim();

// Aligne la section de règles de `mdRepo` sur celle du kit : REMPLACE les puces dont le kit a
// re-formulé l'intitulé (cf. MIGRATIONS), INSÈRE celles qui manquent, ne touche à rien d'autre.
// → { contenu, ajoutees: [clés], migrees: [clés], ignorees: [{quoi, motif}] }
//   ou null si le repo n'a pas la section (CLAUDE.md maison : rien n'est deviné, l'appelant le signale).
export function fusionner(mdRepo, sectionKit) {
  const s = sectionRegles(mdRepo);
  if (!s) return null;
  const pucesRepo = puces(s.corps);
  const presentes = new Set(pucesRepo.map(cle).filter(Boolean));
  const ajoutees = [];
  const migrees = [];
  const ignorees = [];
  const aInserer = [];
  let corps = s.corps;
  for (const p of puces(sectionKit)) {
    const k = cle(p);
    const resume = p.split("\n")[0].replace(/^-\s+/, "").slice(0, 60);
    if (!k) { ignorees.push({ quoi: resume, motif: "pas d'intitulé en gras — identité instable" }); continue; }
    if (presentes.has(k)) continue;
    if (p.includes("{{")) { ignorees.push({ quoi: k, motif: "placeholder à remplir" }); continue; }
    const mig = MIGRATIONS.find((m) => m.cle === k);
    if (mig) {
      // Règle re-formulée par le kit : on remplace l'ancienne puce du repo, jamais on n'ajoute.
      const vieille = pucesRepo.find((q) => mig.anciens.includes(normaliser(q)));
      if (vieille) { corps = corps.replace(vieille, p); migrees.push(k); continue; }
      // Le repo en parle mais autrement : décision locale, on n'y touche pas — on la signale.
      if (pucesRepo.some((q) => mig.sonde.test(q))) {
        ignorees.push({ quoi: k, motif: "formulation locale — à porter à la main" });
        continue;
      }
      // Le repo n'en parle nulle part : règle jamais reçue, elle s'insère normalement.
    }
    aInserer.push(p);
    ajoutees.push(k);
  }
  if (!aInserer.length && !migrees.length) return { contenu: mdRepo, ajoutees, migrees, ignorees };
  // Insertion à la fin de la section, avant l'éventuelle ligne vide de séparation.
  corps = corps.replace(/\s*$/, "");
  const nouveauCorps = aInserer.length ? `${corps}\n${aInserer.join("\n")}\n` : `${corps}\n`;
  const contenu = [s.avant, nouveauCorps, s.apres].filter((x) => x !== "").join("\n");
  return { contenu, ajoutees, migrees, ignorees };
}
