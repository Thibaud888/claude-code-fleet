---
name: backlog
description: Vue agrégée des BACKLOG.md de toute la flotte (widget cliquable ou markdown), et gestes unitaires sur les items — traiter ici ou en issue `claude`, voir le détail, ajouter, supprimer, prioriser P1/P2/P3. Utiliser quand l'utilisateur dit « /backlog », « montre le backlog », « qu'est-ce qu'il reste à faire », « traite l'item N de <repo> », « fais la tâche N ici », « ajoute ça au backlog », « note cette idée », « supprime l'item N », « priorise le backlog », « montre le détail de l'item N ».
---

# /backlog — les tâches de la flotte : consulter, lancer, gérer

Convention : **1 item de backlog = 1 session = 1 PR.**
Registre : `claude-ops/fleet/fleet.json`. Source des backlogs : **GitHub via `gh api`**, jamais
les clones locaux (partagés entre sessions, parfois en retard). Complément de `/dispatch`
(distribution en lot) : ici on consulte et on agit **à l'unité**.
**Portée : le répertoire courant de la session n'influence JAMAIS la vue.**

## Gestes

| Geste | Effet |
|---|---|
| `/backlog` | vue agrégée de toute la flotte |
| `/backlog <repo>` | vue restreinte à un repo |
| `/backlog <repo> <n°>` | traiter l'item **ici**, dans la session courante |
| `/backlog <repo> <n°> cloud` | déléguer en issue `claude` (session Actions) |
| `/backlog <repo> <n°> voir` | détail : item complet + prompt cloud qui serait généré |
| `/backlog <repo> <n°> suppr` | retirer l'item (confirmation obligatoire) |
| `/backlog ajoute [<repo>] <idée>` | ajouter un item — depuis n'importe quelle session |
| `/backlog prio [<repo>]` | passe de priorisation P1/P2/P3 |

## Règles transverses

- **Résolution du repo — ne jamais exiger le nom exact.** Correspondance approximative sur
  fleet.json (casse, tirets, fautes de frappe). Repo manquant ou ambigu → AskUserQuestion avec
  les candidats (≤ 4 : d'abord les repos ayant des items ouverts, triés par nombre d'items ;
  les autres via « Other »). Idem quand un geste arrive sans repo.
- **Numérotation stable.** n° = position de l'item parmi les `- [ ]` du fichier (ordre du
  fichier), même quand l'affichage trie par priorité. Ne **jamais** agir sur un n° sans relire
  le fichier au moment T ; si le contenu ne correspond plus à ce que l'utilisateur avait sous
  les yeux, confirmer avant d'agir.
- **Priorités (convention flotte).** Marqueur optionnel en tête d'item :
  `- [ ] (P1) titre — contexte/DoD`. P1 = urgent · P2 = important · P3 = un jour ·
  sans marqueur = non trié. Affichage trié P1 → P2 → P3 → sans.
- **Anti-collision.** Avant tout traitement ou écriture : si une issue `claude` est ouverte sur
  le repo, le signaler (sa PR touchera aussi BACKLOG.md) et ne continuer qu'avec l'accord de
  l'utilisateur — bloquant en mode cloud (max 1 issue `claude` par repo).
- **Marqueur de provenance.** Un `📱` en fin d'item = promu depuis le codex FleetView
  (workflow `codex-cadrage.yml` de claude-ops) ; le conserver tel quel dans les réécritures.

## Vue — `/backlog` et `/backlog <repo>`

1. `git -C <clone claude-ops> pull` puis lire `fleet/fleet.json` ; repos `statut == "actif"`
   (équipés ou non ; `kit_version == null` → badge « non équipé », pas dispatchable cloud).
2. Par repo : `gh api repos/VOTRE-COMPTE/<repo>/contents/BACKLOG.md --jq .content` → décoder
   base64 (Node/Python ou Git Bash — jamais PowerShell). 404 = pas de backlog.
3. Parser les `- [ ]` : prio éventuelle `(P1|P2|P3)`, titre (avant le premier « — »),
   détail (après). Les `- [x]` sont de l'historique : ignorés.
4. Croiser avec `gh search issues --owner VOTRE-COMPTE --label claude --state open --json
   repository,title,number` → badge « session en cours ».
5. **Rendu widget** (défaut quand `mcp__visualize__show_widget` est disponible — app desktop) :
   appeler `mcp__visualize__read_me` (module `interactive`) puis `show_widget` avec le contenu
   de `widget-template.html` (même dossier que cette skill), en remplaçant la ligne
   `const DATA={repos:[],empty:[]};` par `const DATA=<JSON>;`. Schéma :
   `{repos:[{name,equipped,session,items:[{n,p,t,d}]}],empty:["repo (motif)"]}`
   (`p` = "P1"|"P2"|"P3"|null ; `t` = titre ; `d` = détail). **Ne pas réécrire le template** :
   le lire et injecter les données. Ses boutons renvoient les gestes via sendPrompt.
6. **Repli markdown** (outil indisponible, ex. CLI) : un bloc par repo avec items —
   `### <repo> · <badges>` puis table `n° | prio | titre` triée par priorité ; repos sans item
   regroupés sur une seule ligne en fin de vue.
7. La prose (synthèse, signaux, rappel des gestes en une ligne) va dans la réponse,
   jamais dans le widget.

## `voir` — détail d'un item

Relire le fichier au moment T, afficher : la ligne complète (prio, titre, contexte/DoD), puis
le **corps d'issue qui serait généré** en mode cloud (format `/dispatch` §5 : Contexte /
Objectif / Étapes suggérées / DoD / consigne BACKLOG). Aucune écriture.

## Écritures dans BACKLOG.md — `ajoute`, `suppr`, `prio`

Exception assumée à « jamais de push direct sur main » : ces gestes committent **BACKLOG.md
directement sur la branche par défaut** via l'API contents — une PR + CI pour une ligne de
métadonnées coûterait un run Actions pour rien. Périmètre strict : ce seul fichier, message en
français (`backlog : ajout « … »` / `backlog : retrait « … »` / `backlog : priorisation`).

Procédure commune : GET contents (contenu + `sha` au moment T) → modifier → `gh api -X PUT`
avec le `sha` (base64 : Node/Python/Git Bash). PUT refusé (branche protégée) → repli
branche + PR auto-merge. 409 → re-GET et rejouer.

- **`ajoute`** : reformater l'idée au format kit `titre — contexte/DoD` (une ligne) et montrer
  la reformulation avant d'écrire ; repo non déductible du contexte → AskUserQuestion.
  **Grosse ambiguïté seulement** (la réponse changerait le périmètre, le repo cible ou le sens
  de l'item — pas un détail de formulation) → poser UNE question de précision (AskUserQuestion,
  ≤ 4 options) avant de reformuler ; jamais systématique : au doute léger, deviner et laisser
  corriger. Pas de BACKLOG.md → proposer de le créer (format kit). Prio donnée → marqueur
  `(Pn)` et insertion au rang correspondant ; sinon fin de liste.
- **`suppr`** : afficher l'item complet et demander une confirmation explicite — jamais de
  retrait sans elle. Retirer la ligne entière ; ne jamais toucher aux `- [x]`.
- **`prio`** : lister les items ouverts du repo (pas de repo → le demander). Recueillir les
  priorités par AskUserQuestion en lots de 4 max (1 question = 1 item ; options P1 / P2 / P3 /
  Sans) — ou accepter une réponse libre (« 1:P1 2:P3 … »). Puis réécrire le bloc d'items
  ouverts trié P1 → P2 → P3 → sans (les cochés restent en place), **un seul commit par repo**.

## Traiter ici — `/backlog <repo> <n°>`

1. Relire le BACKLOG.md au moment T, afficher l'item retenu (cf. numérotation stable).
2. Anti-collision (cf. règles transverses).
3. Clone : `~/vos-repos/<repo>` ; absent → proposer `gh repo clone`.
   Puis `git -C <clone> pull` ; **vérifier `branch --show-current` et `status` avant chaque
   commit** (clones partagés entre sessions).
4. Chantier de flotte standard : lire `MAP.md` + `CLAUDE.md` du repo, branche `<type>/<slug>`
   (jamais de push sur `main`), implémenter, **verify du repo avant de conclure**, PR en
   français, **cocher l'item dans BACKLOG.md avec le lien de la PR dans la même PR**.
5. Merge : politique de flotte (auto si CI verte ; pas de CI = merger après verify local OK ;
   `.claude/no-auto-merge` = laisser en relecture).

## Déléguer en cloud — `/backlog <repo> <n°> cloud`

1–2. Comme « traiter ici » (relecture au moment T + anti-collision, ici bloquante).
3. Vérifier repo équipé (`kit_version` non nul) et secret `CLAUDE_CODE_OAUTH_TOKEN` présent
   (`gh secret list`) — sinon proposer `/equiper`.
4. Créer l'issue comme `/dispatch` §5 : titre = l'item ; labels `claude` (+ `claude:haiku` si
   mécanique) posés **à la création** ; corps = handoff autonome (Contexte / Objectif / Étapes
   suggérées / DoD vérifiable / « En fin de PR : cocher cet item dans BACKLOG.md »).
5. Ajouter au Project « Flotte » (résolu par titre, statut « À faire ») comme `/dispatch` §6.
6. Restituer : lien de l'issue + rappel « 1 commentaire = 1 lot ».

## Garde-fous

- Budget : le mode cloud consomme une session Actions — pour plusieurs items, préférer
  `/dispatch` (plafond 5, tri par taille, anti-collision géré).
- Un item ambigu ou gros ne part pas en cloud fire-and-forget : le traiter ici ou via une
  session cloud interactive (bouton 🌩 de FleetView), qui permettent le dialogue.
- Les écritures directes sur la branche par défaut ne concernent QUE BACKLOG.md via les gestes
  de cette skill — tout le reste suit branche + PR.
