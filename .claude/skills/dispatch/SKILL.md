---
name: dispatch
description: Distribue les items de backlog de la flotte en issues GitHub labellisées `claude` (1 item = 1 issue = 1 session Actions = 1 PR) et suit l'avancement. Utiliser quand l'utilisateur dit « dispatch », « /dispatch », « distribue le backlog », « lance les chantiers », ou « dispatch status » / « où en sont les sessions ».
---

# /dispatch [status | <repo> | « les N meilleurs »] — le backlog devient exécutable

Convention : **1 item de backlog = 1 issue = 1 session Actions = 1 PR.**
Registre : `claude-ops/fleet/fleet.json` (jamais de liste de repos en dur).
Suivi visuel : **FleetView** (états, PRs, sessions) — pas de kanban GitHub Project à maintenir.
Contrainte machine : scripts en **Node ou Python** (jamais PowerShell).

## Mode par défaut — dispatcher

### 1. Collecte (sans clones)
- Lire `fleet/fleet.json`. Repos candidats : `statut == "actif"` **et** `dispatchable == true`
  (= une issue labellisée `claude` y lance une session qui peut livrer sa PR).
  Ne PAS filtrer sur `kit_version` : les repos méta (`claude-ops`, `fleet-kit`) dispatchent sans
  porter la version du kit. Ne pas se fier au stub `claude.yml` seul non plus : sans le secret
  `CLAUDE_CODE_OAUTH_TOKEN`, ou si Actions n'a pas le droit de créer des PR, la session brûle des
  tokens pour rien (elle échoue, ou travaille sans pouvoir livrer).
- Repo actif mais `dispatchable == false` → ne pas dispatcher ; dire ce que `dispatch_manque`
  contient, et le geste correspondant. Les deux réglages GitHub sont **à la main de toi**
  (le classifieur refuse que Claude pose un secret ou élève des privilèges) :
  - `claude.yml` → `/equiper <repo>` (ou, repo méta, poser le seul stub) ;
  - `CLAUDE_CODE_OAUTH_TOKEN` → `gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo VOTRE-COMPTE/<repo>` ;
  - `actions-peut-creer-des-PR` → `gh api -X PUT repos/VOTRE-COMPTE/<repo>/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true`.
  Après coup : `node scripts/fleet.mjs` pour rafraîchir le registre.
- Pour chaque candidat : `gh api repos/VOTRE-COMPTE/<repo>/contents/BACKLOG.md --jq .content | base64 -d`
  (404 = pas de backlog, ignorer). Items = lignes `- [ ]` (format kit : `titre — contexte/DoD`,
  marqueur de priorité optionnel en tête : `(P1|P2|P3)`).

### 2. Sélection
Présenter les items groupés par repo, avec une recommandation par item : gain probable,
effort estimé, et le modèle conseillé (mécanique/doc → `claude:haiku` ; code → défaut Sonnet).
Tenir compte des priorités quand elles existent : proposer les `(P1)` d'abord, puis `(P2)`.
L'utilisateur choisit (ou « les N meilleurs » → tu tranches et tu dis pourquoi).
Si l'utilisateur veut **traiter un item lui-même, maintenant, en dialoguant** (ambigu, gros,
besoin du socle local) : pas d'issue → le renvoyer vers **`/backlog <repo> <n°>`** (traitement
dans sa session courante). `/dispatch` = lot cloud ; `/backlog` = consultation + geste unitaire.

### 3. Anti-collision
**Max 1 issue dispatchée à la fois par repo** (la concurrence Actions ferait de toute façon la
queue, et deux branches parties du même main se marcheraient dessus). Les items surnuméraires
d'un même repo restent pour le dispatch suivant — le dire dans la restitution.
Repos différents = parallèle sans restriction.

### 4. Gate de dispatchabilité — quatre questions AVANT chaque issue
Un item portant le marqueur **« ⚠️ hors-Actions »** (posé par le cadrage du codex) est
non dispatchable d'office : le proposer en local (`/backlog <repo> <n°>`) ou en session
cloud interactive, sans re-dérouler le gate.
Cadrer depuis le texte du backlog sans le confronter au réel produit des issues mortes-nées
(vécu 3/5 le 2026-07-17). Item **dispatchable en Actions** = quatre oui :

1. **Faisable avec l'allowlist ?** La session n'a QUE : `git`, `gh issue`, `gh pr`, `npm`,
   `npx`, `node`, `python(3)`, `pip(3)`, `pytest`, Edit/Write/Read/Glob/Grep — donc **aucun
   accès web** (scraping, sonde de source, API externe), pas de `gh workflow run` ni `gh run`
   (impossible de lancer ou d'attendre un autre workflow), aucun aller-retour asynchrone.
   Tout item de scraping est non dispatchable en l'état (vécu : av#16, sonde infaisable,
   0,62 $ pour rien). Et : périmètre clair, ≤ ~40 tours.
2. **L'état décrit est-il encore vrai ?** Vérifier au moment T, contre le repo réel (`gh api`,
   quelques secondes) : le bug se reproduit, le fichier manque, les chiffres tiennent.
   Un backlog n'est pas une source de vérité, c'est une liste d'intentions datées
   (vécu : bac-maths#57, exercices livrés en mai, item jamais coché).
3. **La DoD est-elle une commande qui échoue aujourd'hui ?** Nommer LA commande exacte qui
   échoue maintenant et devra passer après. « verify passe » ne compte que si le verify teste
   réellement la chose ; sinon la session peut croire avoir fini sur un vert qui ne prouve
   rien (vécu : game-haiku#15, verify vert, 32 images mortes). Check inexistant → l'étape 1
   de l'issue est de l'écrire et de le brancher dans le verify du repo.
4. **L'item touche-t-il `.github/workflows/` ?** Le token de l'app GitHub des sessions Actions
   n'a pas la permission `workflows` : une session dispatchée sur un item modifiant
   `.github/workflows/` ne peut pas pousser sa branche, et le run sort **vert** malgré l'échec
   (seul le commentaire d'issue le dit ; vécu fleet-kit#5 le 2026-07-17). Si oui → pas d'issue
   `claude` : traitement local (`/backlog <repo> <n°>`) ou session cloud interactive (repli
   « trop gros » ci-dessous).

Item **trop gros** (refonte, conception, ambiguïté forte) : NE PAS créer d'issue — une session
Actions plafonnée échouera sans PR (vécu : fleetview#38, `max_turns`). Deux replis, au choix de
l'utilisateur : **local** → `/backlog <repo> <n°>` dans sa session courante ; **cloud
interactif** → générer `chantiers/dispatch/<AAAA-MM-JJ>-<repo>-<slug>.md` (handoff autonome à
coller dans une session claude.ai/code, format de `/handoff`) et le dire en restitution.
Les sessions Actions (plafonnées en tours) sont réservées aux items courts.

### 5. Création des issues
Une par item retenu, via `gh issue create --repo VOTRE-COMPTE/<repo>` :
- **Titre** = l'item du backlog.
- **Labels** : `claude` (+ `claude:haiku` si mécanique). Poser le label **à la création**
  (c'est l'événement `labeled` qui déclenche le workflow).
- **Corps** = handoff autonome :
  ```
  ## Contexte
  <2-3 lignes ; renvoyer à MAP.md et CLAUDE.md du repo>
  ## Objectif
  <quoi, pas comment>
  ## Étapes suggérées
  <3-6 puces, optionnel>
  ## Definition of done (vérifiable)
  <LA commande qui échoue aujourd'hui et devra passer (gate n°3) + « verify passe »>
  ## En fin de PR
  Cocher cet item dans BACKLOG.md (même PR) + lien de la PR.
  ```

#### 6. Restituer
Table : repo · item · issue (lien) · modèle. + les items en repli handoff Cloud,
+ les items reportés (anti-collision), + les repos actifs non dispatchables rencontrés.
Le suivi visuel se fait dans **FleetView** (issues + PRs + runs, rien d'autre à alimenter).

## Mode `status` — pilotage

1. Issues ouvertes : `gh search issues --owner VOTRE-COMPTE --label claude --state open`.
2. Pour chacune, croiser :
   - **PR liée** : `gh api graphql` sur `closedByPullRequestsReferences` de l'issue
     (ou `gh pr list --repo <repo> --search "Closes #<n>"`), état + checks
     (`statusCheckRollup`).
   - **Run Actions** : `gh run list --repo <repo> --event issues --limit 5` — un run en cours =
     session active ; un run échoué sans PR = session plantée (donner le lien du run).
3. Rendre la table : repo · item · issue · PR · checks · état. **Signaler en priorité** : une PR
   encore ouverte alors que ses checks sont verts depuis un moment (l'auto-merge a probablement
   échoué — permission, conflit, ou `allow auto-merge` non activé sur le repo), une PR ouverte
   avec checks rouges (attend une vraie relecture), une PR sur un repo en `.claude/no-auto-merge`
   (relecture voulue, normal qu'elle attende), et une issue sans PR ni run actif depuis > 1 h
   (probable échec). **Un run Actions vert ne prouve pas la livraison** (token sans permission
   `workflows` notamment, cf. gate n°4) : vérifier les artefacts réels — PR ouverte/mergée et
   branche poussée — pas la couleur du run.

## Garde-fous
- Ne jamais dispatcher vers un repo dont `github.actor` ne serait pas VOTRE-COMPTE (non applicable
  en pratique : `gh` est authentifié VOTRE-COMPTE — c'est la garde du workflow côté fleet-kit).
- Secrets : si `CLAUDE_CODE_OAUTH_TOKEN` manque sur un repo candidat (`gh secret list`),
  le signaler et proposer `/equiper` au lieu de créer une issue qui échouera.
- Plafond par défaut : **5 issues** par dispatch — pas une contrainte de budget (tout tourne
  sur l'abonnement), mais la taille de lot que toi peut absorber en retours/PRs.
  Ajustable s'il le demande explicitement.
- **1 commentaire = 1 lot** — pour les **retours de relecture** sur une PR/issue : les grouper
  en UN seul commentaire `@claude` (chaque commentaire relance une session Actions complète).
  Ne s'applique PAS aux réponses aux questions posées par une session (1 réponse = 1 relance,
  c'est le fonctionnement nominal).
