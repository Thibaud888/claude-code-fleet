// Le token d'abonnement est-il encore valide ? — logique pure, testable (token-canari.test.mjs).
//
// `fleet.mjs` vérifie que le secret CLAUDE_CODE_OAUTH_TOKEN **existe** (l'API ne livre que des
// noms), jamais qu'il **fonctionne**. Un token révoqué laisse donc le registre au vert pendant
// que chaque session échoue au premier tour — et rien ne le dit avant le prochain dispatch.
//
// Le canari ne déclenche RIEN : il lit les runs déjà passés. Les crons de la flotte (map,
// self-heal, brief) appellent Claude plusieurs fois par jour ; il suffit de regarder combien de
// temps a duré leur étape d'appel. Un rejet d'authentification revient en 1-2 s ; un appel réel
// prend des dizaines de secondes (mesuré sur la flotte : 60, 177, 300, 310 s). La COULEUR du run
// ne suffit pas — un échec peut venir d'autre chose, et un rejet d'auth peut sortir vert.

/** Workflows de la flotte qui appellent Claude (noms d'affichage, cf. fleet-kit). */
export const WORKFLOWS_CLAUDE = ["MAP", "Self-heal", "Claude", "Brief flotte hebdo", "Codex-cadrage"];

/** En deçà, l'étape n'a pas eu le temps de parler à Claude : c'est un rejet, pas un travail. */
export const SEUIL_APPEL_REEL_S = 15;

const duree = (s) => (s.started_at && s.completed_at
  ? Math.round((Date.parse(s.completed_at) - Date.parse(s.started_at)) / 1000)
  : null);

/**
 * Repère l'étape qui appelle vraiment Claude dans les étapes d'un job.
 *
 * Deux familles de workflows, et le nom de l'étape ne suffit pas : `map.yml` appelle son étape
 * « Régénérer MAP.md », sans le mot « claude ». En revanche « Installer Claude Code » est stable
 * dans tous les workflows headless du kit, et l'appel est TOUJOURS l'étape utile qui suit.
 * `claude.yml` (claude-code-action) n'installe rien : là, le nom porte « Session Claude ».
 *
 * @returns {{nom, duree_s, conclusion}|null} null si rien d'exploitable (étape sautée par une garde)
 */
export const etapeClaude = (steps = []) => {
  const utile = (s) => s && s.conclusion !== "skipped";
  const sortie = (s) => ({ nom: s.name, duree_s: duree(s), conclusion: s.conclusion });

  const iInstall = steps.findIndex((s) => /installer claude code/i.test(s.name ?? ""));
  if (iInstall !== -1 && utile(steps[iInstall])) {
    const suite = steps.slice(iInstall + 1).find(utile);
    if (suite) return sortie(suite);
  }

  // Plusieurs étapes peuvent porter « claude » dans claude.yml (« Choisir le modèle (labels
  // claude:haiku…) », instantanée). La plus longue est l'appel : un rejet d'auth dure 1-2 s,
  // toujours plus qu'une étape de sélection de label à 0 s.
  const parNom = steps.filter((s) => utile(s) &&
    /claude/i.test(s.name ?? "") && !/installer|install/i.test(s.name ?? ""));
  if (!parNom.length) return null;
  return sortie(parNom.reduce((a, b) => ((duree(b) ?? -1) > (duree(a) ?? -1) ? b : a)));
};

/**
 * Verdict à partir des étapes observées (une par run examiné).
 *
 * On cherche une PREUVE que le token sert encore : une étape qui a parlé à Claude assez
 * longtemps pour que l'authentification soit forcément passée. Une seule suffit.
 *
 * @param observations [{repo, wf, etape:{duree_s,conclusion}, url}]
 * @returns {{statut:"ok"|"suspect"|"inconnu", message, preuve?, suspects?}}
 */
export const verdictToken = (observations = [], seuilS = SEUIL_APPEL_REEL_S) => {
  const exploitables = observations.filter((o) => o.etape && o.etape.duree_s !== null);
  const preuve = exploitables.find((o) => o.etape.duree_s >= seuilS);
  if (preuve) {
    return {
      statut: "ok",
      message: `token valide : ${preuve.wf} (${preuve.repo}) a parlé à Claude pendant ${preuve.etape.duree_s} s`,
      preuve: { repo: preuve.repo, wf: preuve.wf, duree_s: preuve.etape.duree_s, url: preuve.url },
    };
  }

  // Aucune preuve : des appels tous très courts ET en échec ressemblent à un rejet d'auth.
  const suspects = exploitables.filter((o) => o.etape.duree_s < seuilS && o.etape.conclusion === "failure");
  if (suspects.length) {
    return {
      statut: "suspect",
      message: `${suspects.length} appel(s) à Claude retombés en moins de ${seuilS} s sans jamais aboutir — ` +
        `CLAUDE_CODE_OAUTH_TOKEN probablement expiré ou révoqué. À régénérer (claude setup-token) ` +
        `puis reposer sur les repos concernés avant le prochain dispatch.`,
      suspects: suspects.map((o) => ({ repo: o.repo, wf: o.wf, duree_s: o.etape.duree_s, url: o.url })),
    };
  }

  return {
    statut: "inconnu",
    message: exploitables.length
      ? "appels trop courts pour conclure, mais aucun en échec — à revoir au prochain brief"
      : "aucun appel à Claude exploitable sur la période (crons sautés par leurs gardes ?)",
  };
};
