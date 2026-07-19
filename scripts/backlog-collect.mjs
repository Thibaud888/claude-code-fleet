#!/usr/bin/env node
// Collecte agrégée des BACKLOG.md de la flotte — items OUVERTS uniquement.
//
//   node scripts/backlog-collect.mjs [<repo>]
//   (sans argument : toute la flotte ; avec : filtre approx. sur le nom de repo)
//
// Pourquoi ce script : le skill /backlog récupérait chaque BACKLOG.md ENTIER via `gh api`
// (les `- [x]` faits compris), qui atterrissaient bruts dans le contexte de la session avant
// d'être « ignorés » au parsing — soit ~60-70 % de tokens d'historique mort payés à chaque
// appel (cf. chantiers/BACKLOG.md, item hygiène tokens /backlog). Ici le fetch + décodage +
// filtrage des `[x]` + agrégation se font DANS le script : seuls les items ouverts sortent,
// au format JSON attendu par le widget ({repos:[{name,equipped,session,items:[{n,p,t,d}]}],empty}).
// L'historique reste dans les BACKLOG.md des repos (mémoire in-repo utile) — on ne le déplace pas.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // .../claude-ops
const OWNER = "VOTRE-COMPTE";
const filtre = (process.argv[2] ?? "").toLowerCase().trim();

// --- gh helper : renvoie stdout, ou null sur échec (404, réseau…) ---
function gh(args) {
  try {
    // stderr ignoré : un 404 (repo sans BACKLOG.md) ne doit pas polluer la sortie.
    return execFileSync("gh", args, {
      encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

// --- Coupe un item en {titre, détail} au 1er séparateur HORS parenthèses ---
// Séparateur = « — », ou à défaut un « : » espacé (le colon espacé évite de couper sur
// `04:00`/`http://` ; ignorer les parenthèses évite « (3 items : … » ou « (…— …) »).
function coupeTitre(s) {
  let prof = 0;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === "(") prof++;
    else if (c === ")") { if (prof > 0) prof--; }
    else if (prof === 0) {
      if (c === "—") return { t: s.slice(0, k).trim(), d: s.slice(k + 1).trim() };
      if (c === " " && s[k + 1] === ":" && s[k + 2] === " ")
        return { t: s.slice(0, k).trim(), d: s.slice(k + 3).trim() };
    }
  }
  return { t: s, d: "" };
}

// --- Parse un BACKLOG.md : ne garde que les items ouverts `- [ ]` (multi-lignes recollées) ---
// Numérotation = position parmi les `- [ ]` dans l'ordre du fichier (convention du skill).
function parseOpen(md) {
  const lignes = md.split(/\r?\n/);
  const bruts = [];
  let cur = null; // item ouvert en cours de construction, ou null
  const flush = () => { if (cur !== null) { bruts.push(cur); cur = null; } };
  for (const l of lignes) {
    const mOpen = /^\s*-\s*\[ \]\s?(.*)$/.exec(l);
    const estFait = /^\s*-\s*\[[xX]\]/.test(l);
    const estEntete = /^\s*(#|>|=====)/.test(l);
    const estVide = /^\s*$/.test(l);
    if (mOpen) {                    // nouvel item ouvert
      flush();
      cur = mOpen[1];
    } else if (estFait || estEntete || estVide) {
      flush();                      // un item fait / une entête / une ligne vide clôt l'item courant
    } else if (cur !== null) {      // ligne de continuation d'un item ouvert (repli indenté)
      cur += " " + l.trim();
    }                               // sinon : ligne hors item (puce non-checkbox, suite d'un `[x]`) → ignorée
  }
  flush();

  return bruts.map((raw, i) => {
    let s = raw.trim();
    let p = null;
    const mp = /^\((P1|P2|P3)\)\s*/.exec(s);      // priorité optionnelle en tête
    if (mp) { p = mp[1]; s = s.slice(mp[0].length); }
    s = s.replace(/\*\*/g, "").trim();            // le widget n'interprète pas le markdown gras
    const { t, d } = coupeTitre(s);
    return { n: i + 1, p, t, d };
  });
}

// --- Repos actifs du registre ---
const registre = JSON.parse(readFileSync(join(ROOT, "fleet", "fleet.json"), "utf8"));
let repos = registre.repos.filter((r) => r.statut === "actif");
if (filtre) repos = repos.filter((r) => r.repo.toLowerCase().includes(filtre));

// --- Repos avec une issue `claude` ouverte (badge « session en cours ») ---
const sessions = new Set();
const rawIssues = gh([
  "search", "issues", "--owner", OWNER, "--label", "claude", "--state", "open",
  "--json", "repository", "-L", "100",
]);
if (rawIssues) {
  try {
    for (const it of JSON.parse(rawIssues)) {
      const nom = it.repository?.name;
      if (nom) sessions.add(nom);
    }
  } catch { /* sortie inattendue : pas de badge, tant pis */ }
}

// --- Fetch + filtrage par repo ---
const out = { repos: [], empty: [] };
for (const r of repos) {
  const nom = r.repo;
  const equipped = r.kit_version != null;
  const raw = gh([
    "api", `repos/${OWNER}/${nom}/contents/BACKLOG.md`,
    "-H", "Accept: application/vnd.github.raw",
  ]);
  if (raw == null) { out.empty.push(`${nom} (pas de BACKLOG.md)`); continue; }
  const items = parseOpen(raw);
  if (items.length === 0) { out.empty.push(`${nom} (à jour)`); continue; }
  out.repos.push({ name: nom, equipped, session: sessions.has(nom), items });
}

// JSON compact : injecté tel quel dans le widget (`const DATA=…;`), pas besoin d'indentation.
process.stdout.write(JSON.stringify(out) + "\n");
