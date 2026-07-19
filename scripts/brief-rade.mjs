// Détection des dispatchs « en rade » — logique pure, sans appel réseau, pour être testable
// (cf. scripts/brief-rade.test.mjs). Utilisée par brief-data.mjs.
//
// Le contrôle de sortie de dispatch.yml (fleet-kit) ne couvre que le run lui-même : un run
// vert prouve que la session s'est terminée, pas que le travail a atterri. Restent deux
// silences, que personne ne remonte aujourd'hui :
//   1. une issue `claude` ouverte, sans PR liée et sans session en cours — la session a
//      échoué avant de pousser (ou n'a jamais démarré) ;
//   2. une PR de session (branche `claude/*`) ouverte alors que rien ne la bloque —
//      checks verts, ou repo sans CI : le merge auto ne s'est pas fait, l'item est fini
//      mais pas livré.
// Dans les deux cas, sans ce volet, l'item dort jusqu'à ce qu'un humain aille regarder.

const CONCLUSIONS_ROUGES = new Set([
  "FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED", "CANCELLED", "STALE",
  "ERROR", "FAILING", // StatusContext utilise `state` (ERROR/FAILURE/PENDING/SUCCESS)
]);

/**
 * Synthétise le `statusCheckRollup` d'une PR en un mot.
 * @returns {"verts"|"rouges"|"en_cours"|"aucun"}
 */
export const synthetiseChecks = (rollup) => {
  const checks = rollup ?? [];
  if (!checks.length) return "aucun"; // repo sans CI (claude-ops, fleet-kit…) : rien ne bloque
  let enCours = false;
  for (const c of checks) {
    // CheckRun : status + conclusion ; StatusContext : state seul.
    const etat = (c.status ?? "").toUpperCase();
    const verdict = (c.conclusion ?? c.state ?? "").toUpperCase();
    if (etat && etat !== "COMPLETED") { enCours = true; continue; }
    if (!verdict || verdict === "PENDING" || verdict === "EXPECTED") { enCours = true; continue; }
    if (CONCLUSIONS_ROUGES.has(verdict)) return "rouges"; // un rouge suffit
  }
  return enCours ? "en_cours" : "verts";
};

/** Numéro d'issue porté par une branche de session (`claude/issue-42`), sinon null. */
export const issueDeLaBranche = (headRefName) => {
  const m = /^claude\/issue-(\d+)$/.exec(headRefName ?? "");
  return m ? Number(m[1]) : null;
};

/**
 * PR produite par une session DISPATCHÉE (issue `claude` → run Actions) ?
 * Le seul préfixe `claude/` ne suffit pas : les sessions locales nomment aussi leurs branches
 * ainsi (ex. claude-ops#13 `claude/brief-abonnement-uniquement`, poussée à la main) et une PR
 * de travail en cours n'est pas un dispatch en rade. Signature d'un dispatch : la branche
 * `claude/issue-<n>` de dispatch.yml, ou un push par le bot Actions sur une branche `claude/`.
 */
export const estPrDeSession = (headRefName, auteur) =>
  issueDeLaBranche(headRefName) !== null ||
  (!!auteur?.is_bot && (headRefName ?? "").startsWith("claude/"));

/**
 * Croise l'état des repos et les issues `claude` ouvertes pour sortir les dispatchs en rade.
 *
 * @param repos  [{ repo, prs: [{n,titre,age_h,draft,session,checks,issue,url}], runs_actifs: [wf] }]
 * @param issues [{ repo, n, titre, age_h, url, pr_liee }]
 * @param seuilH âge minimum (heures) — en deçà, la session a le droit d'être encore en train de tourner
 * @param seuilSansCiH idem pour un repo sans CI : là, rien ne prouve que le travail est fini,
 *        la vérification est humaine — on laisse passer une nuit avant de crier au rade
 * @returns [{ type, repo, n, titre, age_h, motif, url }] trié du plus ancien au plus récent
 */
export const detecteRade = ({ repos = [], issues = [], seuilH = 1, seuilSansCiH = 12 } = {}) => {
  const rade = [];
  const parRepo = new Map(repos.map((r) => [r.repo, r]));

  for (const i of issues) {
    if (i.age_h < seuilH || i.pr_liee) continue;
    // Une session en cours sur le repo peut être la sienne : on ne crie pas trop tôt.
    if ((parRepo.get(i.repo)?.runs_actifs ?? []).length) continue;
    rade.push({
      type: "issue", repo: i.repo, n: i.n, titre: i.titre, age_h: i.age_h,
      motif: "aucune PR liée ni session en cours — la session a échoué avant de pousser",
      url: i.url,
    });
  }

  for (const r of repos) {
    for (const p of r.prs ?? []) {
      if (!p.session || p.draft) continue;
      if (p.checks !== "verts" && p.checks !== "aucun") continue; // rouge/en cours : déjà couvert ailleurs
      if (p.age_h < (p.checks === "verts" ? seuilH : seuilSansCiH)) continue;
      rade.push({
        type: "pr", repo: r.repo, n: p.n, titre: p.titre, age_h: p.age_h,
        issue: p.issue ?? undefined,
        motif: p.checks === "verts"
          ? "PR de session, checks verts, toujours ouverte — le merge auto n'a pas eu lieu"
          : "PR de session sur un repo sans CI, toujours ouverte — rien ne la bloque",
        url: p.url,
      });
    }
  }

  return rade.sort((a, b) => b.age_h - a.age_h);
};
