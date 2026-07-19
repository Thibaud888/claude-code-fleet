#!/usr/bin/env node
// Vérif autonome de brief-rade.mjs (pas de cadre de test dans ce repo) : rejoue des états de
// flotte fabriqués — dont le cas de la DoD, « un dispatch de la veille laisse un item en
// rade » — et compare le verdict à l'attendu.
// Usage : node scripts/brief-rade.test.mjs   (exit 0 si tout passe, 1 sinon)
import { detecteRade, estPrDeSession, issueDeLaBranche, synthetiseChecks } from "./brief-rade.mjs";

let echecs = 0;
const verifie = (nom, obtenu, attendu) => {
  const ok = JSON.stringify(obtenu) === JSON.stringify(attendu);
  if (!ok) {
    echecs += 1;
    console.error(`✗ ${nom}\n    attendu : ${JSON.stringify(attendu)}\n    obtenu  : ${JSON.stringify(obtenu)}`);
  } else {
    console.log(`✓ ${nom}`);
  }
};

// ---------- synthetiseChecks ----------
verifie("checks : aucun check (repo sans CI)", synthetiseChecks([]), "aucun");
verifie("checks : rollup absent", synthetiseChecks(undefined), "aucun");
verifie("checks : tout vert",
  synthetiseChecks([{ status: "COMPLETED", conclusion: "SUCCESS" }]), "verts");
verifie("checks : SKIPPED/NEUTRAL comptent comme verts",
  synthetiseChecks([{ status: "COMPLETED", conclusion: "SKIPPED" },
    { status: "COMPLETED", conclusion: "NEUTRAL" }]), "verts");
verifie("checks : un rouge suffit",
  synthetiseChecks([{ status: "COMPLETED", conclusion: "SUCCESS" },
    { status: "COMPLETED", conclusion: "FAILURE" }]), "rouges");
verifie("checks : un run encore en cours",
  synthetiseChecks([{ status: "IN_PROGRESS" }, { status: "COMPLETED", conclusion: "SUCCESS" }]), "en_cours");
verifie("checks : rouge l'emporte sur en cours",
  synthetiseChecks([{ status: "IN_PROGRESS" }, { status: "COMPLETED", conclusion: "FAILURE" }]), "rouges");
verifie("checks : StatusContext (state, sans status)",
  synthetiseChecks([{ __typename: "StatusContext", state: "SUCCESS" }]), "verts");
verifie("checks : StatusContext en attente",
  synthetiseChecks([{ __typename: "StatusContext", state: "PENDING" }]), "en_cours");

// ---------- branches de session ----------
verifie("branche : claude/issue-42 → 42", issueDeLaBranche("claude/issue-42"), 42);
verifie("branche : claude/autre → null", issueDeLaBranche("claude/brief-abonnement"), null);
verifie("branche : feat/x → null", issueDeLaBranche("feat/x"), null);
const BOT = { is_bot: true, login: "app/github-actions" };
const MOI = { is_bot: false, login: "VOTRE-COMPTE" };
verifie("session : claude/issue-1 (branche de dispatch.yml)", estPrDeSession("claude/issue-1", MOI), true);
verifie("session : bot Actions sur une branche claude/", estPrDeSession("claude/correctif", BOT), true);
// Vécu : claude-ops#13, PR d'une session LOCALE poussée à la main — pas un dispatch en rade.
verifie("session : branche claude/ poussée par un humain n'en est pas une",
  estPrDeSession("claude/brief-abonnement-uniquement", MOI), false);
verifie("session : feat/x n'en est pas une", estPrDeSession("feat/x", MOI), false);
verifie("session : auteur absent (champ non collecté)", estPrDeSession("claude/x", undefined), false);

// ---------- detecteRade ----------
const nRade = (etat) => detecteRade(etat).map((r) => `${r.type}:${r.repo}#${r.n}`);

// DoD : un dispatch de la veille laisse un item en rade → il apparaît.
verifie("DoD : issue de la veille, aucune PR, aucune session → en rade",
  nRade({
    repos: [{ repo: "fleetview", prs: [], runs_actifs: [] }],
    issues: [{ repo: "fleetview", n: 7, titre: "…", age_h: 20, pr_liee: false }],
  }),
  ["issue:fleetview#7"]);

verifie("DoD : PR de session verte, jamais mergée → en rade",
  nRade({
    repos: [{
      repo: "bac-maths", runs_actifs: [],
      prs: [{ n: 61, titre: "…", age_h: 18, draft: false, session: true, issue: 59, checks: "verts" }],
    }],
    issues: [],
  }),
  ["pr:bac-maths#61"]);

verifie("PR de session sur repo sans CI, ouverte depuis une nuit → en rade",
  nRade({
    repos: [{
      repo: "claude-ops", runs_actifs: [],
      prs: [{ n: 21, titre: "…", age_h: 15, draft: false, session: true, checks: "aucun" }],
    }],
    issues: [],
  }),
  ["pr:claude-ops#21"]);

// Sans CI, rien ne prouve que le travail est fini : on laisse la session vivre sa journée.
verifie("PR de session sur repo sans CI, ouverte depuis 5 h : trop tôt",
  nRade({
    repos: [{
      repo: "claude-ops", runs_actifs: [],
      prs: [{ n: 21, age_h: 5, draft: false, session: true, checks: "aucun" }],
    }], issues: [],
  }), []);

// Non-régressions : ce qui NE doit PAS remonter.
verifie("issue fraîche (< 1 h) : la session a le droit de tourner",
  nRade({
    repos: [{ repo: "fleetview", prs: [], runs_actifs: [] }],
    issues: [{ repo: "fleetview", n: 7, age_h: 0, pr_liee: false }],
  }), []);

verifie("issue avec session en cours sur le repo",
  nRade({
    repos: [{ repo: "fleetview", prs: [], runs_actifs: ["Claude"] }],
    issues: [{ repo: "fleetview", n: 7, age_h: 20, pr_liee: false }],
  }), []);

verifie("issue avec PR liée : le travail a atterri",
  nRade({
    repos: [{ repo: "fleetview", prs: [], runs_actifs: [] }],
    issues: [{ repo: "fleetview", n: 7, age_h: 20, pr_liee: true }],
  }), []);

verifie("PR de session aux checks rouges : couverte par « à surveiller », pas ici",
  nRade({
    repos: [{
      repo: "bac-maths", runs_actifs: [],
      prs: [{ n: 61, age_h: 18, draft: false, session: true, checks: "rouges" }],
    }], issues: [],
  }), []);

verifie("PR de session dont la CI tourne encore",
  nRade({
    repos: [{
      repo: "bac-maths", runs_actifs: [],
      prs: [{ n: 61, age_h: 2, draft: false, session: true, checks: "en_cours" }],
    }], issues: [],
  }), []);

verifie("PR de session en draft : travail volontairement suspendu",
  nRade({
    repos: [{
      repo: "bac-maths", runs_actifs: [],
      prs: [{ n: 61, age_h: 18, draft: true, session: true, checks: "verts" }],
    }], issues: [],
  }), []);

verifie("PR humaine verte : ce n'est pas un dispatch en rade",
  nRade({
    repos: [{
      repo: "claude-ops", runs_actifs: [],
      prs: [{ n: 13, age_h: 48, draft: false, session: false, checks: "verts" }],
    }], issues: [],
  }), []);

verifie("flotte au repos : rien à signaler", nRade({ repos: [], issues: [] }), []);
verifie("état vide (script en repli) : pas de crash", detecteRade(), []);

// Un run actif sur un AUTRE repo n'absout pas l'issue.
verifie("session active ailleurs : l'issue reste en rade",
  nRade({
    repos: [{ repo: "fleetview", prs: [], runs_actifs: [] },
      { repo: "un-autre-repo", prs: [], runs_actifs: ["Claude"] }],
    issues: [{ repo: "fleetview", n: 7, age_h: 20, pr_liee: false }],
  }), ["issue:fleetview#7"]);

// Tri : le plus ancien d'abord (c'est le plus urgent).
verifie("tri du plus ancien au plus récent",
  nRade({
    repos: [{
      repo: "claude-ops", runs_actifs: [],
      prs: [{ n: 21, age_h: 14, draft: false, session: true, checks: "aucun" }],
    }],
    issues: [{ repo: "fleetview", n: 7, age_h: 30, pr_liee: false }],
  }),
  ["issue:fleetview#7", "pr:claude-ops#21"]);

console.log(echecs ? `\n${echecs} échec(s).` : "\nTout passe.");
process.exit(echecs ? 1 : 0);
