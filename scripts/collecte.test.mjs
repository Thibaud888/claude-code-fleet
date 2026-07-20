#!/usr/bin/env node
// Vérif autonome de collecte.mjs (pas de cadre de test dans ce repo) : rejoue des échecs `gh`
// réellement rencontrés, sans réseau ni attente (lancer/dormir injectés).
// Usage : node scripts/collecte.test.mjs (exit 0 si tout passe)
import { creerCollecteur, estTransitoire } from "./collecte.mjs";

let echecs = 0;
const verifie = (nom, obtenu, attendu) => {
  const ok = JSON.stringify(obtenu) === JSON.stringify(attendu);
  if (!ok) {
    echecs += 1;
    console.error(`✗ ${nom}\n    attendu : ${JSON.stringify(attendu)}\n    obtenu  : ${JSON.stringify(obtenu)}`);
  } else console.log(`✓ ${nom}`);
};

// Fabrique un collecteur dont `lancer` rejoue une file de réponses par appel.
// Une entrée string = succès ; une entrée Error = échec.
const collecteurAvec = (reponsesParAppel, opts = {}) => {
  let dormi = 0;
  const files = new Map(Object.entries(reponsesParAppel));
  const lancer = async (args) => {
    const cle = args[0];
    const file = files.get(cle) ?? [];
    const r = file.shift();
    if (r === undefined) throw Object.assign(new Error("file vide"), { stderr: "file vide" });
    if (r instanceof Error) throw r;
    return r;
  };
  const c = creerCollecteur({ lancer, dormir: async (ms) => { dormi += ms; }, ...opts });
  return { ...c, dormi: () => dormi };
};
const err = (msg) => Object.assign(new Error(msg), { stderr: msg });
const E503 = () => err("failed to get runs: HTTP 503: No server is currently available");
const E404 = () => err("HTTP 404: Not Found");

// ---------- estTransitoire ----------
verifie("503 est transitoire", estTransitoire("HTTP 503: No server is currently available"), true);
verifie("429 / rate limit est transitoire", estTransitoire("HTTP 429: rate limit exceeded"), true);
verifie("502 est transitoire", estTransitoire("HTTP 502: Bad Gateway"), true);
verifie("coupure réseau est transitoire", estTransitoire("connect ECONNRESET 140.82.121.6:443"), true);
verifie("secondary rate limit est transitoire", estTransitoire("You have exceeded a secondary rate limit"), true);
verifie("404 n'est PAS transitoire", estTransitoire("HTTP 404: Not Found"), false);
verifie("droits manquants n'est PAS transitoire", estTransitoire("HTTP 403: Resource not accessible"), false);
verifie("message vide n'est PAS transitoire", estTransitoire(""), false);
verifie("undefined ne casse pas", estTransitoire(undefined), false);

// ---------- réessai ----------
{
  const c = collecteurAvec({ run: [E503(), E503(), "OK"] });
  verifie("un 503 transitoire est rejoué jusqu'au succès", await c.gh(["run", "list"]), "OK");
  verifie("  … et compté comme 2 réessais", c.stats.reessais, 2);
  verifie("  … sans être compté en échec", c.stats.echecs, 0);
  verifie("  … avec un backoff exponentiel (800 + 1600 ms)", c.dormi(), 2400);
}
{
  const c = collecteurAvec({ run: [E503(), E503(), E503()] });
  verifie("un 503 persistant finit en échec", await c.gh(["run", "list"]), null);
  verifie("  … compté une seule fois", c.stats.echecs, 1);
  verifie("  … et laisse une erreur lisible", /HTTP 503/.test(c.erreurs[0]), true);
}
{
  const c = collecteurAvec({ api: [E404(), "jamais atteint"] });
  verifie("une erreur définitive n'est PAS rejouée", await c.gh(["api", "x"]), null);
  verifie("  … aucun réessai", c.stats.reessais, 0);
  verifie("  … aucune attente", c.dormi(), 0);
}

// ---------- ok404 : l'absence tolérée ne pollue pas le bilan ----------
{
  const c = collecteurAvec({ api: [E404()] });
  verifie("ok404 : renvoie null", await c.gh(["api", "x"], { ok404: true }), null);
  verifie("  … sans compter d'échec", c.stats.echecs, 0);
  verifie("  … sans remonter d'erreur", c.erreurs.length, 0);
}
{
  // Le piège : un 503 sur un appel tolérant reste une indisponibilité, pas une absence.
  const c = collecteurAvec({ api: [E503(), "OK"] });
  verifie("ok404 : un 503 est quand même rejoué", await c.gh(["api", "x"], { ok404: true }), "OK");
  verifie("  … et le réessai est compté", c.stats.reessais, 1);
}

// ---------- bilan de complétude ----------
{
  const c = collecteurAvec({ run: ["A", "B"] });
  await c.gh(["run", "list"]); await c.gh(["run", "list"]);
  const b = c.bilan({ attendus: 2, obtenus: 2 });
  verifie("DoD : collecte intacte → complete: true", b.complete, true);
  verifie("  … pas d'avertissement", b.avertissement, undefined);
  verifie("  … pas de tableau d'erreurs", b.erreurs, undefined);
}
{
  // Le cas vécu le 2026-07-20 : la majorité des repos muets, sortie bien formée quand même.
  const c = collecteurAvec({ run: ["A", E503(), E503(), E503()] }, { tentatives: 1 });
  await c.gh(["run", "list"]); await c.gh(["run", "list"]); await c.gh(["run", "list"]);
  const b = c.bilan({ attendus: 16, obtenus: 3 });
  verifie("DoD : collecte trouée → complete: false", b.complete, false);
  verifie("  … avertissement en clair", /COLLECTE INCOMPLÈTE : 3\/16/.test(b.avertissement), true);
  verifie("  … qui dit que les totaux sont des planchers", /PLANCHERS/.test(b.avertissement), true);
  verifie("  … compte les repos obtenus", [b.repos_attendus, b.repos_obtenus], [16, 3]);
  verifie("  … et les échecs gh", b.echecs_gh, 2);
}
{
  // Aucun échec gh, mais moins de repos que prévu (fleet.json désynchronisé, filtre trop large…)
  const c = collecteurAvec({ run: ["A"] });
  await c.gh(["run", "list"]);
  const b = c.bilan({ attendus: 5, obtenus: 1 });
  verifie("un manque sans échec gh compte aussi comme incomplet", b.complete, false);
}
{
  // Non-régression : obtenus > attendus ne doit pas rendre `complete` faux.
  const c = collecteurAvec({ run: ["A"] });
  await c.gh(["run", "list"]);
  verifie("obtenus > attendus reste complet", c.bilan({ attendus: 1, obtenus: 2 }).complete, true);
}

console.log(echecs ? `\n${echecs} échec(s).` : "\nTout passe.");
process.exit(echecs ? 1 : 0);
