#!/usr/bin/env node
// Helper `gh()` partagé par brief-data.mjs et tokens-hebdo.mjs, + bilan de COMPLÉTUDE.
//
// Pourquoi ce module. Le helper d'origine avalait toute erreur gh, poussait une ligne dans un
// tableau `erreurs` en FIN de JSON, et continuait avec un résultat vide pour le repo concerné.
// La sortie restait donc parfaitement bien formée — indiscernable d'une collecte complète —
// mais sous-évaluée. Vécu le 2026-07-20 : 13 repos sur 16 en HTTP 503, coût cloud annoncé ~4×
// trop bas, et rien pour alerter la session de bilan (Haiku), qui n'a aucune raison d'aller
// lire un tableau d'erreurs en queue de fichier.
//
// Deux réponses : réessayer ce qui est TRANSITOIRE, et surtout DIRE en tête de sortie quand la
// collecte est incomplète — pour qu'un consommateur puisse refuser de conclure plutôt que de
// publier un chiffre faux.

// Erreurs qui valent la peine d'être rejouées : indisponibilité côté GitHub, throttling,
// coupures réseau. Tout le reste (404, dépôt inexistant, droits manquants, JSON invalide) est
// définitif — le rejouer ne ferait que tripler l'attente avant le même échec.
export const estTransitoire = (msg = "") =>
  /HTTP (?:429|500|502|503|504)\b|rate limit|secondary rate|abuse detection|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|server error|try again/i
    .test(String(msg));

// `lancer` et `dormir` sont injectés pour que les tests tournent sans réseau ni attente réelle.
export function creerCollecteur({
  lancer,
  dormir = (ms) => new Promise((r) => setTimeout(r, ms)),
  tentatives = 3,
  delaiBaseMs = 800,
} = {}) {
  const erreurs = [];
  const stats = { appels: 0, echecs: 0, reessais: 0 };

  const gh = async (args, { ok404 = false } = {}) => {
    stats.appels++;
    let dernier = "";
    for (let essai = 1; essai <= tentatives; essai++) {
      try {
        return await lancer(args);
      } catch (e) {
        dernier = (e.stderr || e.message || "").trim();
        if (essai < tentatives && estTransitoire(dernier)) {
          stats.reessais++;
          await dormir(delaiBaseMs * 2 ** (essai - 1)); // 800 ms, 1,6 s
          continue;
        }
        break;
      }
    }
    // `ok404` = l'appelant tolère l'absence (ex. un fichier optionnel) : ni erreur ni comptage.
    // Le réessai a quand même eu lieu au-dessus : un 503 sur un appel tolérant reste une
    // indisponibilité, pas une absence.
    if (ok404) return null;
    stats.echecs++;
    erreurs.push(`gh ${args.slice(0, 3).join(" ")}… : ${dernier.slice(0, 150)}`);
    return null;
  };

  // À placer EN TÊTE du JSON de sortie. `complete: false` veut dire « ne conclus pas sur ces
  // chiffres » : il manque des repos, donc tout total est un plancher, pas une mesure.
  const bilan = ({ attendus, obtenus }) => {
    const manquants = Math.max(0, attendus - obtenus);
    const complete = stats.echecs === 0 && manquants === 0;
    return {
      complete,
      ...(complete ? {} : {
        avertissement: `COLLECTE INCOMPLÈTE : ${obtenus}/${attendus} repos obtenus, ` +
          `${stats.echecs} appel(s) gh en échec. Les totaux ci-dessous sont des PLANCHERS, ` +
          `pas des mesures — le dire dans le rapport et ne pas comparer à une autre semaine.`,
      }),
      repos_attendus: attendus,
      repos_obtenus: obtenus,
      appels_gh: stats.appels,
      echecs_gh: stats.echecs,
      reessais: stats.reessais,
      erreurs: erreurs.length ? erreurs : undefined,
    };
  };

  return { gh, erreurs, stats, bilan };
}
