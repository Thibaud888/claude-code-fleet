# 🛠️ claude-ops — piloter une flotte de repos avec Claude Code

> **La tour de contrôle d'un usage de Claude Code.** Un seul dépôt qui décrit comment on
> travaille, liste ses projets, outille ses sessions (permissions, hooks, commandes maison),
> lance et surveille du travail automatique sur toute une **flotte de repos**, et en archive
> les traces. Objectif affiché : **passer de « une session à la fois, tout retapé à la main »
> à « chef d'orchestre d'une flotte briefée, automatisée et surveillée ».**

> ℹ️ **Ce dépôt est un extrait anonymisé, publié comme modèle.** C'est le vrai système d'une
> personne, dont on a retiré l'état privé (registre réel, backlog, rapports, mémoire, dépense)
> pour ne garder que **la méthode et l'outillage réutilisables**. Deux jetons se remplacent
> partout par un simple find/replace : `VOTRE-COMPTE` (ton compte GitHub) et `~/vos-repos`
> (ton dossier de clones) ; quelques champs libres utilisent `<…>`. Les fichiers de
> configuration personnelle sont livrés en `*.example`. Voir [Adapter à ton usage](#-adapter-à-ton-usage).

> 📖 **Commence ici :** le [**mode d'emploi complet (GUIDE.md)**](GUIDE.md) — tous les acteurs,
> les schémas Mermaid, les 10 bonnes pratiques. Ce README n'est que l'index.

## 🎯 Pour qui, avec quoi

Pour toi si tu utilises **Claude Code** sur **plusieurs repos GitHub** et veux passer du
« une session à la fois » au pilotage d'ensemble. Prérequis : Claude Code (abonnement OAuth ou
clé API), `gh` CLI authentifié, Node ≥ 18, un compte GitHub. Optionnels : [ntfy](https://ntfy.sh)
et [Healthchecks.io](https://healthchecks.io) (observabilité) ; **Windows** requis uniquement
pour `scripts/hygiene.ps1` (tâche planifiée) — le reste est portable.

> ⚠️ Garde **ton instance adaptée en privé** : ton `fleet/fleet.json` généré révèle la liste
> de tes repos (y compris privés), ton backlog et tes rapports décrivent ta vie de projets.

## 🗺️ Carte du dépôt

```
README.md                ← tu es ici (index)
GUIDE.md                 ← mode d'emploi complet (acteurs, schémas, bonnes pratiques)
LICENSE                  ← MIT
fleet/
  fleet.example.json     ← schéma du registre de flotte (source unique : types, crons, kit, statut)
  OBSERVABILITE.md       ← ntfy / Healthchecks / self-heal en détail
scripts/
  fleet.mjs              ← rafraîchit le registre (auto-découverte GitHub via gh)
  guard.mjs · check.mjs  ← hooks de session (anti push-main/secrets ; vérif post-édition)
  guard.test.mjs         ← tests du hook guard
  brief-data.mjs · tokens-hebdo.mjs · ntfy.mjs · statusline.mjs · gist-cleanup.mjs · hygiene.ps1
.claude/skills/          ← /backlog /dispatch (versionnées → dispo aussi en session Cloud)
skills/                  ← /equiper /nouveau-projet (locaux)
harvest/
  harvest-console.js     ← snippet console : moisson des sessions Cloud (0 token)
  split-harvest.mjs      ← range les fichiers moissonnés + ping Healthchecks
examples/workflows/      ← brief quotidien, entrée dispatch, cadrage codex (INERTES — à activer soi-même)
socle-local/             ← modèle de ~/.claude : CLAUDE.example.md, settings.example.json
```

## 🧩 Ce que tu trouves ici

- **Une méthode** documentée de bout en bout ([GUIDE.md](GUIDE.md)) : local vs Cloud, le
  registre unique, le dispatch (1 item de backlog = 1 issue = 1 session Cloud = 1 PR),
  l'observabilité (ntfy → Healthchecks → self-heal), la moisson des sessions Cloud.
- **Deux hooks** prêts à l'emploi : [`guard.mjs`](scripts/guard.mjs) (bloque le push direct sur
  `main` d'un repo projet + tout secret en clair) et [`check.mjs`](scripts/check.mjs) (relance le
  check du projet après chaque édition, réinjecte seulement les échecs). 0 token.
- **Des scripts d'orchestration** : auto-découverte du registre, collecte du brief en un appel,
  bilan tokens, notifications ntfy, purge de gists.
- **Des commandes maison (skills)** : `/backlog`, `/dispatch`, `/equiper`, `/nouveau-projet`.

> 🔗 **Dépôt compagnon :** [`fleet-kit`](https://github.com/Thibaud888/fleet-kit) (public)
> héberge les **workflows GitHub Actions réutilisables** + les templates posés sur chaque repo
> « équipé ». Améliorer une fois → toute la flotte en profite. Il n'est **pas inclus** dans cet
> extrait : **forke-le**, remplace la garde `github.actor` de son `dispatch.yml` par ton compte,
> et référence TON fork (`uses: <ton-compte>/fleet-kit/...`) dans les stubs.

## ⚡ Essai à blanc (2 minutes, sans rien configurer)

```bash
node scripts/guard.test.mjs                       # la suite du hook anti push-main / anti-secrets (17 cas)
FLEET_OWNER=<ton-compte> node scripts/fleet.mjs   # génère fleet/fleet.json depuis TES repos (gh requis)
```

## 🔧 Adapter à ton usage

Rien à faire tourner en aveugle : ce dépôt est un point de départ à personnaliser.

0. **Forke [`fleet-kit`](https://github.com/Thibaud888/fleet-kit)** (le dispatch en dépend) et
   remplace la garde `github.actor` de son `dispatch.yml` par ton compte.
1. **Remplace les placeholders** — un find/replace global suffit :
   `grep -rl VOTRE-COMPTE . | xargs sed -i 's/VOTRE-COMPTE/ton-compte/g'` (idem `~/vos-repos`).
   Les scripts d'orchestration acceptent aussi l'env `FLEET_OWNER` sans rien éditer.
   💡 Nomme ton clone **`claude-ops`** (ou ajoute son nom à `META_REPOS` dans
   `scripts/guard.mjs`) : le hook n'autorise le commit direct sur `main` qu'aux repos méta.
2. **Renomme les modèles** : `socle-local/CLAUDE.example.md` → ton `~/.claude/CLAUDE.md`,
   `socle-local/settings.example.json` → ton `~/.claude/settings.json`,
   `fleet/fleet.example.json` → `fleet/fleet.json` puis `node scripts/fleet.mjs`.
3. **Branche les hooks** avec des **chemins absolus** dans `settings.json` → `hooks` (un `~`
   entre guillemets n'est pas expansé → hook mort **silencieux**, ils sont fail-open).
   Vérifie : `node scripts/guard.test.mjs`, puis en conditions réelles :
   `echo '{"tool_input":{"command":"git push origin main"},"cwd":"<un repo projet>"}' | node scripts/guard.mjs`
4. **Prépare GitHub** : labels `claude` / `claude:haiku` / `idée` / `à-préciser` ; un Project
   utilisateur « Flotte » (kanban du dispatch) ; le réglage par repo « Actions peut créer des
   PR » ; un PAT fine-grained `FLEET_GH_TOKEN` (contents RW sur ta flotte) ; les secrets
   `CLAUDE_CODE_OAUTH_TOKEN` (via `claude setup-token`), `NTFY_TOPIC`, `HEALTHCHECKS_API_KEY`
   selon ce que tu actives. En local : env `HEALTHCHECK_URL_HARVEST` / `HEALTHCHECK_URL_HYGIENE`.
5. **Active les workflows** en dernier : copie `examples/workflows/*.yml` vers
   `.github/workflows/` (livrés inertes exprès — un cron actif sans secrets = runs rouges
   quotidiens ; voir [examples/workflows/README.md](examples/workflows/README.md)).

## 📏 Conventions

- Ce repo est lisible par toutes les sessions (Cloud et locales) : la source de vérité sur
  *comment tu travailles avec Claude Code*.
- Chaque session qui termine un chantier met à jour le `BACKLOG.md` (statut + lien PR).
- Scripts destinés aux sessions : **Node ou Python** (pas de PowerShell — réservé aux tâches
  planifiées humaines, ex. `scripts/hygiene.ps1`).

## 📄 Licence

[MIT](LICENSE). Fais-en ce que tu veux — attribution appréciée, aucune garantie.
