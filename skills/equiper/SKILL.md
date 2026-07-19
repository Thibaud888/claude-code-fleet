---
name: equiper
description: Applique ou met à niveau le kit de flotte (fleet-kit) sur un repo — stubs de workflows réutilisables, CLAUDE.md, MAP.md initiale, BACKLOG.md, allowlist, labels, secrets, .kit-version — sans écraser l'existant, puis PR et mise à jour du registre. Utiliser quand l'utilisateur dit « équipe <repo> », « /equiper <repo> », « mets <repo> au kit », ou depuis /nouveau-projet.
---

# /equiper <repo> — pose ou met à niveau le kit de flotte (idempotent)

Kit : `VOTRE-COMPTE/fleet-kit` (public). Registre : `claude-ops/fleet/fleet.json`.
**Idempotent** : relancer sur un repo déjà à jour ne doit produire aucun diff.
Contrainte machine : scripts en **Node ou Python** (jamais PowerShell — bloqué pour les sessions).

## 0. Prérequis
- Clone local de fleet-kit à jour : `git -C "~/vos-repos/fleet-kit" pull`
  (le cloner là s'il manque). Lire sa `VERSION` → `$KIT`.
- Repo cible : clone local dans `vos-repos/<nom>` (sinon `gh repo clone` là-bas), à jour.
- Si `.kit-version` du repo == `$KIT` : dire « déjà à jour » et s'arrêter.

## 1. Déterminer le type
Dans l'ordre : entrée `type` de `fleet.json` → indices du repo (`index.html` racine → `static` ;
`package.json` + serveur → `service-node` ; workflow `schedule:` + Python → `cron-python` ;
lib/CLI → `lib` ; markdown seul → `contenu`). Si ambigu, demander. Types `meta`/`contenu` :
poser seulement CLAUDE.md, BACKLOG.md, `.kit-version` (pas de CI ni dispatch inutiles).

## 2. Poser les fichiers (branche `chore/kit-flotte-v$KIT`)
Copier depuis `fleet-kit/templates/common/` puis `templates/<type>/`, **sans écraser** :
- Fichier absent → copier tel quel.
- **CLAUDE.md existant** → merge doux : ajouter seulement la section « Règles de travail (flotte) »
  du template si absente ; ne pas toucher au reste. CLAUDE.md absent → partir de `CLAUDE.md.tpl`
  et remplir les `{{PLACEHOLDERS}}` en lisant le repo (README, package.json, workflows).
- **`.claude/settings.json` existant** → fusionner les listes `allow`/`deny` (union, sans doublons).
- **`.claude/skills/` (skills de session)** → copier les skills du kit (`bilan`, `handoff`,
  `reprends`) depuis `templates/common/.claude/skills/`. C'est ce qui les rend disponibles en
  **session Cloud** (elles sont alors versionnées dans le repo, pas seulement en local). Idempotent :
  écraser la version existante de **ces trois skills du kit** (elles évoluent avec le kit), mais
  **ne jamais toucher** à un skill maison propre au repo (tout skill de nom différent).
- **Stubs de workflows** (`map.yml`, `claude.yml`, `self-heal.yml`, `pr-ready.yml`, `ci.yml`/`pages.yml`) →
  remplacer uniquement si le fichier existant commence par `# Stub flotte` (c'est une ancienne
  version du kit) ; sinon le laisser et le signaler dans la restitution.
- **`self-heal.yml`** : seulement si le repo a des crons ; remplacer `<NOM_DU_WORKFLOW_CRON>`
  par les `name:` réels des workflows planifiés du repo.
- **`.claude/no-auto-merge`** : ne JAMAIS le créer ni le supprimer ici — c'est le choix explicite
  de toi pour ce repo (posé à la création ou à la main). `/equiper` ne touche pas à ce fichier.
- **`dependabot.yml`** : ajouter l'écosystème `npm` (types node) ou `pip` (types python) au template.
- **`MAP.md` initiale** : la générer toi-même ici (structure imposée par
  `fleet-kit/.github/workflows/map.yml` : quoi / arborescence annotée / points d'entrée /
  flux / commandes / pièges, ≤ 150 lignes, français). Le workflow l'entretiendra ensuite.
- **`.kit-version`** = `$KIT`.

## 3. Labels + secrets + réglage Actions
- **Réglage « Actions peut créer des PRs »** (sinon la session dispatch fait le travail mais
  ne peut pas ouvrir la PR — constaté sur notes-bac #13). Le classifieur **refuse que Claude
  le fasse** (élévation de privilège) → donner la commande à toi, qui la lance lui-même :
  `gh api -X PUT repos/VOTRE-COMPTE/<nom>/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true`
  Vérifier ensuite : `gh api repos/VOTRE-COMPTE/<nom>/actions/permissions/workflow`.
- `gh label create claude --repo VOTRE-COMPTE/<nom> --color 7C3AED --force` ; idem `claude:haiku`
  (couleur `C4B5FD`) et `self-heal` (couleur `DC2626`).
- `gh secret list --repo VOTRE-COMPTE/<nom>` ; s'il manque `CLAUDE_CODE_OAUTH_TOKEN` (ou à défaut
  `ANTHROPIC_API_KEY`) et `NTFY_TOPIC` : les copier depuis un repo déjà équipé est impossible
  (les secrets ne se lisent pas) → demander la valeur à l'utilisateur UNE fois par session,
  la poser avec `gh secret set <NOM> --repo ... --body -` (via stdin, ne jamais l'afficher ni
  la logger), puis réutiliser pour les repos suivants de la même session.
- Si l'utilisateur n'a pas encore de token : lui indiquer `claude setup-token` (abonnement)
  ou console Anthropic (clé plafonnée 5 €/mois) et continuer sans bloquer (le noter en restitution).

## 4. Livrer
- Commit(s) en français, push, **PR** « chore: kit de flotte v$KIT » (base = branche par défaut).
  Exception : repo tout neuf issu de /nouveau-projet → commit direct dans le bootstrap initial.
- Mettre à jour le registre : `node scripts/fleet.mjs` dans claude-ops (ajuste aussi `type` à la
  main dans `fleet.json` si la découverte s'était trompée), commit claude-ops sur main.

## 5. Restituer
Lien PR · fichiers posés / laissés tels quels · secrets posés / manquants · actions manuelles
restantes. Si plusieurs repos à équiper : proposer de continuer avec le suivant.
