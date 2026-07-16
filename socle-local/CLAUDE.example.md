# CLAUDE.md — socle global (EXEMPLE À ADAPTER)

> Modèle du `~/.claude/CLAUDE.md` global — chargé automatiquement dans **chaque session
> locale** de la machine. Remplace les valeurs entre `<…>` par les tiennes, reste concis.
> Sauvegarde versionnée : `claude-ops/socle-local/`. Les sessions **Cloud ne lisent PAS** ce fichier.

## Qui je suis
- `<ton prénom>`, profil `<dev / data / …>`.
- **Réponds-moi en français, au tutoiement**, style direct et concis. *(adapte langue et ton)*
- Budget outillage : **< 50 €/mois**. Les sessions GitHub Actions de la flotte tournent sur
  **l'abonnement Claude** (OAuth, cf. `fleet-kit/dispatch.yml`) — pas de crédits API ; l'API
  ne sert qu'aux apps qui ont leur propre clé.

## Règles d'efficacité (flotte)
- **MAP.md d'abord** : si le repo a une `MAP.md`, la lire AVANT toute exploration ;
  n'explorer que ce qu'elle ne couvre pas.
- **Vérifie avant de conclure** : `scripts/verify*` du repo (ou build + tests) — aucune
  session ne rend la main sans avoir vu son résultat tourner.
- **Écris l'outil, pas l'output** : à la 3e récurrence d'une même tâche, produire un script
  réutilisable (`scripts/`), pas juste le résultat.
- **Routage de modèles** : mécanique (cartes, backlogs, briefs, moisson) → Haiku ;
  code courant → Sonnet ; conception/architecture → gros modèle en session.
- **Scripts destinés aux sessions : Node ou Python uniquement** — jamais PowerShell
  (bloqué pour Claude sur cette machine ; PowerShell = tâches planifiées humaines, ex. hygiène).

## Hygiène tokens (économie sans rogner la qualité)
- **`/clear` entre deux tâches sans rapport** — l'ancien contexte est un poids mort payé à
  chaque tour. `/compact` manuel vers ~50 % de contexte plutôt que subir l'auto-compact.
- **Exploration lourde → sous-agent Explore** : il lit dans son propre contexte et ne rend
  que la conclusion (la session principale reste légère).
- **Plan mode pour les tâches incertaines** : évite les allers-retours essais-erreurs,
  le vrai gouffre à tokens.
- **Retours sur une PR/issue Cloud : UN seul commentaire `@claude` groupé** — chaque
  commentaire relance une session Actions complète (recontextualisation payée à chaque fois).
- **`/context` en cas de doute** ; la statusline affiche le % de contexte en continu.

## Comment je travaille
- Repos **projet** : **jamais de push direct sur `main`** → branche + PR (un hook le bloque).
  Exceptions : les repos méta **`claude-ops`** et **`fleet-kit`**.
- **PR mergée automatiquement dès que la CI est verte** (pas d'attente de relecture par défaut,
  depuis le 2026-07-11) — sauf repo marqué `.claude/no-auto-merge` (relecture obligatoire) ou
  CI rouge (la PR reste alors ouverte, jamais mergée à l'aveugle).
- Messages de commit **en français**.
- Déploiements habituels : **GitHub Pages**, **Render**, **GitHub Actions** (crons).
- Compte GitHub : **`<VOTRE-COMPTE>`** (`gh` déjà authentifié).
- **En fin de session significative** : mettre à jour le `BACKLOG.md` du repo concerné
  (statut + lien PR) — ou `/bilan`.

## Source de vérité & flotte
- **`<VOTRE-COMPTE>/claude-ops`** (privé) — clone local : `~/vos-repos/claude-ops`
  = comment je travaille avec Claude Code. Points d'entrée : `rapport/diagnostic.md`,
  `chantiers/BACKLOG.md`.
- **Registre de flotte** : `claude-ops/fleet/fleet.json` — **LA** liste de mes repos (types,
  crons, version du kit). Rafraîchir : `node scripts/fleet.mjs`. Ne jamais maintenir de liste
  de repos en dur ailleurs.
- **`<VOTRE-COMPTE>/fleet-kit`** (public) — workflows réutilisables + templates de la flotte.
  Un repo s'équipe/se met à niveau avec **`/equiper <repo>`** ; un projet naît équipé avec
  **`/nouveau-projet <nom>`**.
