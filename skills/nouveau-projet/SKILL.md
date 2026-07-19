---
name: nouveau-projet
description: Bootstrap complet d'un nouveau projet en une commande — repo GitHub, clone local, puis kit de flotte complet via /equiper (CLAUDE.md, MAP.md, stubs de workflows fleet-kit, allowlist, BACKLOG.md, labels, secrets), premier commit poussé, registre mis à jour. Utiliser quand l'utilisateur dit « nouveau projet », « démarre un projet », « /nouveau-projet <nom> ». Ne demander que le type de projet, sa visibilité, et si les PR doivent se merger automatiquement (défaut) ou rester en relecture obligatoire.
---

# /nouveau-projet <nom> — un repo qui naît équipé du kit de flotte

Cible du clone : `~/vos-repos\<nom>`.
Compte GitHub : **VOTRE-COMPTE**. Conventions : français, branche + PR sur les repos projet.
Le socle est posé par la skill **`/equiper`** (source unique : `VOTRE-COMPTE/fleet-kit`) —
c'est la garantie que tout repo futur naît avec le kit, sans divergence.

## 1. Demander le minimum (rien d'autre)
- **Type** : (a) `static` → GitHub Pages ; (b) `service-node` → Render ;
  (c) `cron-python` / `cron-node` → cron GitHub Actions ; (d) `lib` ; (e) `contenu`.
- **Visibilité** : privé (défaut) ou public.
- **Merge des PR** : auto (défaut — la PR se merge seule dès que la CI est verte) ou relecture
  obligatoire sur ce repo (pose un fichier vide `.claude/no-auto-merge` à la racine). Ne demander
  que si l'utilisateur n'a pas déjà tranché dans sa demande ; par défaut, auto.

`<nom>` vient de l'argument ; s'il manque, le demander.

## 2. Créer le repo + clone
```bash
cd "~/vos-repos"
gh repo create VOTRE-COMPTE/<nom> --private --clone      # ou --public
cd <nom>
```

## 3. Équiper (= tout le socle)
Appliquer la skill **`/equiper <nom>`** avec le type choisi. Repo neuf → mode bootstrap :
commit direct sur `main` (pas de PR), et remplir les `{{PLACEHOLDERS}}` du CLAUDE.md avec ce
que l'utilisateur a dit du projet (le reste : `TODO au premier chantier`). Ajouter un
**README.md** minimal (quoi + comment lancer) et, pour un `cron-*`, le workflow planifié
lui-même (`on: schedule` + `workflow_dispatch`) — le kit ne fournit
que la CI, le self-heal et le dispatch autour. Si l'utilisateur a demandé la **relecture
obligatoire** à l'étape 1 : créer un fichier vide `.claude/no-auto-merge` dans ce même commit.

## 4. Premier commit
Message en français, ex. `chore: bootstrap du projet (kit de flotte vX.Y.Z)`. Pousser.
`/equiper` termine en mettant à jour `claude-ops/fleet/fleet.json` (`node scripts/fleet.mjs`).

## 5. Restituer
Chemin du clone, URL du repo, secrets posés/manquants, et proposer un `/handoff` pour lancer
le premier chantier.

> Suppression d'un repo (ex. test jetable) : nécessite le scope `delete_repo`
> (`gh auth refresh -s delete_repo`) ou la web UI — `gh` ne l'a pas par défaut sur cette machine.
> À défaut, l'archivage (`gh repo archive`) est réversible et suffit souvent.
