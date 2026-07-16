---
name: dispatch
description: Distribue les items de backlog de la flotte en issues GitHub labellisées `claude` (1 item = 1 issue = 1 session Actions = 1 PR), les ajoute au Project « Flotte », et suit l'avancement. Utiliser quand l'utilisateur dit « dispatch », « /dispatch », « distribue le backlog », « lance les chantiers », ou « dispatch status » / « où en sont les sessions ».
---

# /dispatch [status | <repo> | « les N meilleurs »] — le backlog devient exécutable

Convention : **1 item de backlog = 1 issue = 1 session Actions = 1 PR.**
Registre : `claude-ops/fleet/fleet.json` (jamais de liste de repos en dur).
Kanban : GitHub Project utilisateur **« Flotte »** (actuellement n° 1). Owner : `VOTRE-COMPTE`.
Contrainte machine : scripts en **Node ou Python** (jamais PowerShell).

## Mode par défaut — dispatcher

### 1. Collecte (sans clones)
- Lire `fleet/fleet.json`. Repos candidats : `statut == "actif"` **et** `kit_version != null`
  (un repo non équipé n'a pas le workflow `claude.yml` — le signaler, proposer `/equiper`).
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

### 4. Tri par taille — issue API, ou interactif (cloud / local)
Item **dispatchable en Actions** : périmètre clair, ≤ ~40 tours, DoD vérifiable par une commande.
Item **trop gros** (refonte, conception, ambiguïté forte) : NE PAS créer d'issue — une session
Actions plafonnée échouera sans PR (vécu : session tuée par `max_turns`). Deux replis, au choix de
l'utilisateur : **local** → `/backlog <repo> <n°>` dans sa session courante ; **cloud
interactif** → générer `chantiers/dispatch/<AAAA-MM-JJ>-<repo>-<slug>.md` (handoff autonome à
coller dans une session claude.ai/code, format de `/handoff`) et le dire en restitution.
Le budget API (5 €/mois) est réservé aux items courts.

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
  <commande(s) à lancer + résultat attendu ; « verify passe » si le repo en a un>
  ## En fin de PR
  Cocher cet item dans BACKLOG.md (même PR) + lien de la PR.
  ```

### 6. Ajout au Project « Flotte »
- Résoudre le Project par titre (`gh project list --owner VOTRE-COMPTE --format json` → « Flotte »),
  ne pas supposer que le n° 1 est stable.
- `gh project item-add <num> --owner VOTRE-COMPTE --url <issue-url>` puis passer le Status à
  **« À faire »** : `gh project item-edit --id <item-id> --project-id <project-id>
  --field-id <status-field-id> --single-select-option-id <id-À-faire>`
  (IDs via `gh project field-list <num> --owner VOTRE-COMPTE --format json`).

### 7. Restituer
Table : repo · item · issue (lien) · modèle · Project. + les items en repli handoff Cloud,
+ les items reportés (anti-collision), + les repos non équipés rencontrés.

## Mode `status` — pilotage

1. Issues ouvertes : `gh search issues --owner VOTRE-COMPTE --label claude --state open`.
2. Pour chacune, croiser :
   - **PR liée** : `gh api graphql` sur `closedByPullRequestsReferences` de l'issue
     (ou `gh pr list --repo <repo> --search "Closes #<n>"`), état + checks
     (`statusCheckRollup`).
   - **Run Actions** : `gh run list --repo <repo> --event issues --limit 5` — un run en cours =
     session active ; un run échoué sans PR = session plantée (donner le lien du run).
3. **Réconcilier le Project** : run en cours → « En session » ; PR ouverte → « PR ouverte » ;
   PR mergée/issue fermée → « Mergé » (item-edit comme ci-dessus). Le kanban reste honnête
   sans drag-and-drop manuel.
4. Rendre la table : repo · item · issue · PR · checks · état. **Signaler en priorité** : une PR
   encore ouverte alors que ses checks sont verts depuis un moment (l'auto-merge a probablement
   échoué — permission, conflit, ou `allow auto-merge` non activé sur le repo), une PR ouverte
   avec checks rouges (attend une vraie relecture), une PR sur un repo en `.claude/no-auto-merge`
   (relecture voulue, normal qu'elle attende), et une issue sans PR ni run actif depuis > 1 h
   (probable échec).

## Garde-fous
- Ne jamais dispatcher vers un repo dont `github.actor` ne serait pas VOTRE-COMPTE (non applicable
  en pratique : `gh` est authentifié VOTRE-COMPTE — c'est la garde du workflow côté fleet-kit).
- Secrets : si `CLAUDE_CODE_OAUTH_TOKEN` manque sur un repo candidat (`gh secret list`),
  le signaler et proposer `/equiper` au lieu de créer une issue qui échouera.
- Jamais plus de **5 issues** par dispatch (le budget API 5 €/mois reste le vrai goulot — les
  PR se mergent seules dès que la CI est verte, cf. `fleet-kit` v1.1.0+, donc ce n'est plus la
  relecture humaine qui limite). Rappeler le plafond si le mois semble chargé.
- **1 commentaire = 1 lot** : si l'utilisateur veut renvoyer des retours sur une PR/issue,
  lui rappeler de les grouper en UN seul commentaire `@claude` — chaque commentaire relance
  une session Actions complète (recontextualisation payée à chaque réplique).
