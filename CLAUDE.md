# CLAUDE.md — claude-ops

> **Le repo méta de la flotte** : il décrit et outille la façon dont l'utilisateur travaille avec
> Claude Code. Il ne produit aucune application — il porte le **registre** des repos, les
> **scripts de pilotage** (brief, dispatch, hygiène, propagation du kit), les **rapports**
> et les **skills** de session. Source de vérité ; les autres repos en dépendent.

## Règles de travail (flotte)
- **Lis `MAP.md` avant toute exploration** ; n'explore que ce qu'elle ne couvre pas.
  *(Ce repo n'en a pas encore : commence par `README.md` puis `GUIDE.md`.)*
- **Aucune session ne rend la main sans avoir vérifié** : lance `npm test` (les 7 suites des
  scripts de pilotage) et regarde le résultat avant de conclure.
- **Branche + PR** — ⚠️ **exception assumée sur CE repo** : c'est un repo **méta**, le commit
  direct sur `main` y est autorisé (comme sur `fleet-kit`), parce qu'une PR + CI pour une ligne
  de registre ou de rapport coûte plus qu'elle ne protège. Le hook `guard.mjs` le sait et laisse
  passer. Sur **tous les autres** repos, la règle reste branche + PR. Commits **en français**.
- **1 session = 1 item = 1 PR** — un item de `BACKLOG.md` par session ; mets à jour
  `BACKLOG.md` en fin de session.
- **Écris l'outil, pas l'output** — à la 3e récurrence d'une même tâche, écris un script
  réutilisable (`scripts/`), pas juste le résultat. C'est la règle qui a produit la moitié de
  `scripts/`.
- **La PR se merge automatiquement dès que la CI est verte** (pas d'attente de relecture par
  défaut). CI rouge → PR laissée ouverte, jamais mergée à l'aveugle. **Repo sans CI** : le
  merge auto exige une section `## Vérification` (commande + résultat) dans le corps de la PR.
  Pour forcer la relecture humaine sur CE repo : créer un fichier vide `.claude/no-auto-merge`.
- **Règle du clair** — l'utilisateur n'est pas technicien quand il te lit (souvent depuis son
  téléphone). Ce qui lui est destiné se comprend sans jargon ; la technique n'est pas retirée,
  elle passe **après**.
  - **Item de backlog** (`titre — contexte/DoD`) : le titre dit ce que ça change pour lui, en
    français courant — pas de nom de fichier ou de fonction, pas de sigle, pas d'anglicisme non
    traduit. Le jargon vit **après le tiret**, aussi précis que nécessaire.
  - **Question** : UNE seule à la fois, ouverte par une ligne en clair (le choix vu de son
    côté), puis un bloc `**Options :**` de 2 à 4 réponses numérotées (une ligne, < 140
    caractères) décrites par leur **conséquence** — ce qu'il verra, ce que ça coûte — et non par
    leur mécanisme, puis `**Recommandation :** option N — pourquoi`. Détail technique en repli
    `<details>` sous la question, jamais au-dessus. Il répond par un simple numéro.
  - Test : si quelqu'un qui ne code pas ne peut pas choisir en lisant la partie haute, c'est raté.

## Stack & commandes
- Stack : **Node pur**, sans dépendance (bibliothèque standard uniquement), scripts en `.mjs`.
- Test : `npm test` — les 7 suites (`backlog-collect`, `brief-rade`, `collecte`, `guard`,
  `projets`, `regles-flotte`, `token-canari`), sans réseau.
- Build : aucun.
- ⚠️ **Jamais de PowerShell** dans un script destiné aux sessions : il est bloqué pour Claude
  sur cette machine. Node ou Python. (`hygiene.ps1` est une tâche planifiée **humaine**, à part.)

## Architecture
- `fleet/fleet.json` — **le registre** : LA liste des repos, leurs crons, leur version de kit,
  leur `dispatchable`, et pour chacun son `statut` (`actif` / `veille` / `archivé`), son `pitch`
  et son `site`. Généré par `scripts/fleet.mjs` ; ne jamais tenir une liste de repos ailleurs.
  Le `statut` dit si on **développe** encore : un projet en `veille` (v1 sortie, plus de dev)
  sort de `/backlog` et de `/dispatch` sans qu'on vide son BACKLOG.md. Il ne dit pas ce qui est
  **en service** — la surveillance suit les `crons`, donc **tout repo ayant un cron reste dans le
  brief et le bilan de tokens, même `archivé`**. Voir `.claude/skills/projets/SKILL.md`.
- `scripts/` — le pilotage : `brief-data.mjs` (+ `brief-rade.mjs`), `tokens-hebdo.mjs`,
  `kit-propager.mjs` (+ `regles-flotte.mjs`), `backlog-collect.mjs`, `projets.mjs`,
  `publier-extrait.mjs`, `socle-sync.mjs`, `collecte.mjs` (helper réseau partagé),
  `guard.mjs` / `check.mjs` (hooks).
- `.github/workflows/` — 4 crons : `codex-cadrage` (quotidien), `brief-hebdo`, `fleet-refresh`,
  `kit-propagation` (lundi), plus `ci.yml`. ⚠️ Modifiables **en session locale seulement** :
  le token de l'app GitHub n'a pas la permission `workflows`.
- `rapport/` — diagnostic, audits, hygiène hebdomadaire, bilans de tokens. `chantiers/` — fiches
  de chantier et suivi. `socle-local/` — sauvegarde versionnée du socle et de la mémoire.
- `.claude/skills/` — `projets`, `backlog` et `dispatch` (skills de flotte, lues en session locale
  comme en session Cloud ouverte sur ce repo).

## Pièges connus
- **Le repo est privé, son miroir `claude-code-fleet` est public.** Toute modification d'un
  fichier publié doit rester anonymisable : `node scripts/publier-extrait.mjs --verifier` avant
  de conclure. Certains fichiers sont à **divergence assumée** — ne pas les resynchroniser
  mécaniquement.
- **Un seul backlog** : `BACKLOG.md` à la racine, notation `- [ ]`. C'est le seul fichier que
  lisent `backlog-collect.mjs`, `/backlog`, `/dispatch`, FleetView et le brief. Depuis le
  2026-07-31, `chantiers/BACKLOG.md` n'est plus qu'une **archive** de chantiers terminés — il
  portait 10 items en notation `🔲` que personne ne voyait. N'ouvre jamais de tâche ailleurs
  qu'à la racine.
- **`fleet.json` est aussi écrit par des sessions et par `fleet-refresh.yml`** : re-fetch la base
  distante avant tout `PUT` par l'API contents, sinon on écrase le travail d'une autre session.
- Un run vert ne prouve pas la livraison : vérifier les **artefacts** (PR, commit, fichier), pas
  la couleur du run.
