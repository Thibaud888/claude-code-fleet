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
// au format JSON attendu par le widget :
//   {repos:[{name,equipped,session,items:[{n,p,t,d}]}], empty:[…], frozen:[{repo,n,p,t,d}]}
// L'historique reste dans les BACKLOG.md des repos (mémoire in-repo utile) — on ne le déplace pas.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // .../claude-ops
const OWNER = "VOTRE-COMPTE";

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
export function coupeTitre(s) {
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
// Les items GELÉS comptent dans cette numérotation (ils restent des `- [ ]` à leur place) :
// c'est ce qui permet à `/backlog <repo> <n°> degele` de viser le bon item sans renuméroter
// le reste. Ils sortent seulement de la vue, pas du fichier.
export function parseOpen(md) {
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
    // Le gras est retiré AVANT la lecture des marqueurs : plusieurs items du terrain sont
    // écrits `- [ ] **(P2) titre**`, et le marqueur y passait inaperçu.
    let s = raw.trim().replace(/\*\*/g, "").trim();
    let p = null, gel = false;
    // Marqueurs optionnels en tête, dans n'importe quel ordre : `(gelé)` et/ou `(P1|P2|P3)`.
    for (;;) {
      const mg = /^\(gel[ée]e?\)\s*/i.exec(s);
      if (mg) { gel = true; s = s.slice(mg[0].length); continue; }
      const mp = /^\((P1|P2|P3)\)\s*/.exec(s);
      if (mp) { p = mp[1]; s = s.slice(mp[0].length); continue; }
      break;
    }
    const { t, d } = coupeTitre(s);
    return { n: i + 1, p, t, d, gel };
  });
}

// --- Agrégation d'un repo déjà récupéré : sépare ouverts / gelés (testable sans réseau) ---
export function agrege(out, { nom, equipped, session, raw }) {
  if (raw == null) { out.empty.push(`${nom} (pas de BACKLOG.md)`); return out; }
  const ouverts = parseOpen(raw);
  // Les gelés sortent de `repos[].items` (donc de la vue) mais restent comptés à part : un
  // congélateur invisible serait une suppression déguisée. Ils gardent leur `n` d'origine.
  for (const g of ouverts.filter((i) => i.gel)) {
    out.frozen.push({ repo: nom, n: g.n, p: g.p, t: g.t, d: g.d });
  }
  const items = ouverts.filter((i) => !i.gel).map(({ n, p, t, d }) => ({ n, p, t, d }));
  const nbGel = ouverts.length - items.length;
  if (items.length === 0) {
    out.empty.push(`${nom} (à jour${nbGel ? ` · ${nbGel} gelé${nbGel > 1 ? "s" : ""}` : ""})`);
    return out;
  }
  out.repos.push({ name: nom, equipped, session, items });
  return out;
}

// Les détails du terrain pèsent lourd : certains items portent plusieurs milliers de
// caractères de mesures. Non bridés, ILS dominent le coût de `/backlog` — mesuré le
// 2026-07-31 : 8 443 caractères de JSON dont 6 259 de seuls détails, et une sortie brute
// qui dépassait 30 Ko. Le détail intégral se lit par `/backlog <repo> <n> voir`, qui
// refetche le fichier : rien n'est perdu à le couper ici.
//   (défaut)   détails coupés à 200 caractères — lisible en prose sans ruiner le contexte
//   --widget   détails ABSENTS — le widget les replie par défaut, il n'en affiche aucun
//   --complet  détails intacts — pour un diagnostic, jamais pour l'affichage courant
const CAP = 200;
function borner(out, mode) {
  if (mode === "complet") return out;
  const traite = (i) => {
    if (mode === "widget") { delete i.d; return; }
    if (typeof i.d === "string") {
      const plat = i.d.replace(/\s+/g, " ").trim();
      i.d = plat.length > CAP ? `${plat.slice(0, CAP - 1)}…` : plat;
    }
  };
  for (const r of out.repos) r.items.forEach(traite);
  out.frozen.forEach(traite);
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const mode = args.includes("--widget") ? "widget" : args.includes("--complet") ? "complet" : "borne";
  const filtre = (args.find((a) => !a.startsWith("--")) ?? "").toLowerCase().trim();

  // --- Repos actifs du registre ---
  // `actif` SEUL, volontairement : c'est ce qui fait qu'un projet passé en `veille` (v1 sortie,
  // plus de dev) disparaît d'ici sans qu'on ait à vider son BACKLOG.md. Ses items restent dans
  // le repo et reviennent tous si le projet repasse en `actif`. Cf. /projets.
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
  const out = { repos: [], empty: [], frozen: [] };
  for (const r of repos) {
    const nom = r.repo;
    agrege(out, {
      nom,
      equipped: r.kit_version != null,
      session: sessions.has(nom),
      raw: gh(["api", `repos/${OWNER}/${nom}/contents/BACKLOG.md`, "-H", "Accept: application/vnd.github.raw"]),
    });
  }

  // JSON compact : injecté tel quel dans le widget (`const DATA=…;`), pas besoin d'indentation.
  process.stdout.write(JSON.stringify(borner(out, mode)) + "\n");
}

// Corps CLI seulement en exécution directe : le test importe ce module et ne doit
// déclencher ni lecture du registre ni appel `gh`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
