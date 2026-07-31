---
name: backlog
description: Vue agrégée des BACKLOG.md de toute la flotte (widget cliquable ou markdown), et gestes unitaires sur les items — traiter ici ou en issue `claude`, voir le détail, ajouter, supprimer, geler/dégeler, prioriser P1/P2/P3. Utiliser quand l'utilisateur dit « /backlog », « montre le backlog », « qu'est-ce qu'il reste à faire », « traite l'item N de <repo> », « fais la tâche N ici », « ajoute ça au backlog », « note cette idée », « supprime l'item N », « gèle cet item », « mets-le de côté », « montre les items gelés », « priorise le backlog », « montre le détail de l'item N ».
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
| `/backlog <repo> <n°> gele` | mettre l'item de côté : il sort de la vue, il reste dans le fichier |
| `/backlog <repo> <n°> degele` | le faire revenir dans la vue |
| `/backlog gelés` | la liste de ce qui est mis de côté |
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
- **Gel (convention flotte).** Marqueur `(gelé)` en tête, cumulable avec la priorité et dans
  n'importe quel ordre : `- [ ] (gelé) (P2) titre — …`. Un item gelé **reste un `- [ ]` à sa
  place dans le fichier** — il garde donc son n° — mais sort de la vue par défaut. C'est la
  réponse à « intéressant, mais pas maintenant » : ni un `- [x]` (mensonge : ce n'est pas
  fait), ni une suppression (perte des mesures qui ont coûté des sessions). Le gel n'est **pas
  un cimetière** : le compteur reste affiché en pied de vue, et un gelé n'est jamais
  dispatchable (ni `/dispatch`, ni mode cloud) tant qu'il n'est pas dégelé.
- **Anti-collision.** Avant tout traitement ou écriture : si une issue `claude` est ouverte sur
  le repo, le signaler (sa PR touchera aussi BACKLOG.md) et ne continuer qu'avec l'accord de
  l'utilisateur — bloquant en mode cloud (max 1 issue `claude` par repo).
- **Règle du clair** (socle global). Le **titre** d'un item se lit sans être technicien : ce que
  ça change pour l'utilisateur, en français courant, sans nom de fichier ni de fonction, sans sigle ni
  anglicisme non traduit — tout le jargon reste **après le tiret**, intact. Idem pour toute
  question posée ici : une ligne « en clair » d'abord, options décrites par leur **conséquence**
  (ce qu'il verra, ce que ça coûte) et non par leur mécanisme, détail technique en repli
  `<details>`. Vaut à l'écriture (`ajoute`) comme à la relecture : un titre existant illisible
  se reformule au passage, sans toucher au détail.
- **Marqueurs.** Un `📱` en fin d'item = promu depuis le codex FleetView (workflow
  `codex-cadrage.yml` de claude-ops) ; « ⚠️ hors-Actions » = infaisable en session Actions
  (accès web ou autre workflow requis) → jamais en mode cloud, traiter en local ou en session
  cloud interactive. Conserver ces marqueurs tels quels dans les réécritures.

## Vue — `/backlog` et `/backlog <repo>`

1. `git -C <clone claude-ops> pull` (registre à jour), puis **un seul appel** :
   `node <clone claude-ops>/scripts/backlog-collect.mjs --widget [<repo>]` → JSON prêt pour le widget
   `{repos:[{name,equipped,session,items:[{n,p,t}]}],empty:["repo (motif)"],frozen:[{repo,n,p,t}]}`.
   **Toujours `--widget` pour la vue** : les détails du terrain pèsent des milliers de caractères
   chacun et dominaient le coût (mesuré le 2026-07-31 : 27 175 caractères de sortie brute, dont
   la quasi-totalité en détails que le widget n'affichait pas). Sans le drapeau, les détails
   sortent coupés à 200 caractères ; `--complet` les rend intacts (diagnostic seulement).
   Le script fait tout **sans charger l'historique en contexte** : repos `statut == "actif"` du
   registre, fetch de chaque BACKLOG.md (raw via `gh api`), **filtrage des `- [x]` (historique
   laissé dans le repo, jamais lu ici — ~70 % de tokens économisés vs l'ancien fetch entier)**,
   parsing des marqueurs `(gelé)` / `(P1|P2|P3)` (ordre libre, gras toléré) / titre (1er « — »
   ou « : » **hors parenthèses**) / détail, et croisement des issues `claude` ouvertes →
   `session`. `n` = position parmi **tous** les `- [ ]`, gelés compris (numérotation stable).
   `equipped == false` → badge « non équipé » (pas dispatchable cloud) ;
   `empty` = repos sans item ouvert **non gelé** (motif « à jour », « à jour · N gelés » ou
   « pas de BACKLOG.md ») ; `frozen` = les gelés de toute la flotte, hors de `repos[].items`.
   Erreur/indispo du script → repli manuel : `gh api …/contents/BACKLOG.md` par repo, ne parser
   que les `- [ ]` (jamais les `- [x]`), en écartant ceux marqués `(gelé)`.
2. **Rendu widget** (défaut quand `mcp__visualize__show_widget` est disponible — app desktop) :
   appeler `mcp__visualize__read_me` (module `interactive`) puis `show_widget` avec le contenu
   de `widget-template.html` (même dossier que cette skill), en remplaçant la ligne
   `const DATA={repos:[],empty:[],frozen:[]};` par `const DATA=<JSON>;`. Schéma : celui du
   script ci-dessus (`p` = "P1"|"P2"|"P3"|null ; `t` = titre).
   **Ne pas réécrire le template** : le lire et injecter les données — c'est le geste le moins
   cher (le lire une fois puis l'émettre coûte moins que de le faire produire par le script,
   qui obligerait à le lire ET à l'émettre en entier). Ses boutons renvoient les gestes via
   sendPrompt, et il affiche seul le pied « Gelés : … » à partir de `frozen`.
   **Le widget n'affiche aucun détail** : un titre cliqué envoie `voir`, qui rend l'item complet.
   `t`, `n` et `p` ne se résument jamais.
3. **Repli markdown** (outil indisponible, ex. CLI) : un bloc par repo avec items —
   `### <repo> · <badges>` puis table `n° | prio | titre` triée par priorité ; repos sans item
   regroupés sur une seule ligne en fin de vue, gelés en une ligne « Gelés : … ».
4. La prose (synthèse, signaux, rappel des gestes en une ligne) va dans la réponse,
   jamais dans le widget.

## `gelés` — ce qui est mis de côté

`/backlog gelés` (ou `/backlog <repo> gelés`) : même appel au collecteur, mais on affiche
`frozen` au lieu de `repos`. Table `repo | n° | titre`, plus une ligne de rappel du geste
`/backlog <repo> <n°> degele`. Aucune écriture.

## `voir` — détail d'un item

Relire le fichier au moment T, afficher : la ligne complète (prio, titre, contexte/DoD), puis
le **corps d'issue qui serait généré** en mode cloud (format `/dispatch` §5 : Contexte /
Objectif / Étapes suggérées / DoD / consigne BACKLOG). Aucune écriture.

## Écritures dans BACKLOG.md — `ajoute`, `suppr`, `gele`, `degele`, `prio`

Exception assumée à « jamais de push direct sur main » : ces gestes committent **BACKLOG.md
directement sur la branche par défaut** via l'API contents — une PR + CI pour une ligne de
métadonnées coûterait un run Actions pour rien. Périmètre strict : ce seul fichier, message en
français (`backlog : ajout « … »` / `backlog : retrait « … »` / `backlog : gel « … »` /
`backlog : dégel « … »` / `backlog : priorisation`).

Procédure commune : GET contents (contenu + `sha` au moment T) → modifier → `gh api -X PUT`
avec le `sha` (base64 : Node/Python/Git Bash). PUT refusé (branche protégée) → repli
branche + PR auto-merge. 409 → re-GET et rejouer.

- **`ajoute`** : reformater l'idée au format kit `titre — contexte/DoD` (une ligne), **titre en
  clair** (cf. règles transverses), et montrer la reformulation avant d'écrire ; repo non déductible du contexte → AskUserQuestion.
  **Grosse ambiguïté seulement** (la réponse changerait le périmètre, le repo cible ou le sens
  de l'item — pas un détail de formulation) → poser UNE question de précision (AskUserQuestion,
  ≤ 4 options) avant de reformuler ; jamais systématique : au doute léger, deviner et laisser
  corriger. Pas de BACKLOG.md → proposer de le créer (format kit). Prio donnée → marqueur
  `(Pn)` et insertion au rang correspondant ; sinon fin de liste.
- **`suppr`** : afficher l'item complet et demander une confirmation explicite — jamais de
  retrait sans elle. Retirer **le bloc entier** (la ligne `- [ ]` et ses lignes de continuation
  indentées, jusqu'au prochain item ou à la prochaine entête) ; ne jamais toucher aux `- [x]`.
  Un item mérite souvent mieux que la corbeille : si la raison invoquée est « pas maintenant »
  plutôt que « sans objet », proposer `gele` avant de supprimer.
- **`gele` / `degele`** : insérer ou retirer le marqueur `(gelé)` en tête du titre, **après le
  `- [ ] ` et avant une éventuelle `(Pn)`**. Ne toucher à rien d'autre : ni le titre, ni le
  détail, ni la position dans le fichier — c'est ce qui rend le geste réversible à l'identique.
  Pas de confirmation nécessaire (rien n'est perdu), mais afficher le titre traité. Plusieurs
  gels sur le même repo → **un seul commit**.
- **`prio`** : lister les items ouverts du repo (pas de repo → le demander). Recueillir les
  priorités par AskUserQuestion en lots de 4 max (1 question = 1 item ; options P1 / P2 / P3 /
  Sans) — ou accepter une réponse libre (« 1:P1 2:P3 … »). Puis réécrire le bloc d'items
  ouverts trié P1 → P2 → P3 → sans (les cochés restent en place), **un seul commit par repo**.

## Traiter ici — `/backlog <repo> <n°>`

1. Relire le BACKLOG.md au moment T, afficher l'item retenu (cf. numérotation stable).
2. Anti-collision (cf. règles transverses).
3. Clone : `~\Documents\vos-repos\<repo>` ; absent → proposer `gh repo clone`.
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
5. Restituer : lien de l'issue + rappel « 1 commentaire = 1 lot » (pour les retours groupés ;
   répondre à une question de la session reste le cas normal). Suivi : FleetView.

## Garde-fous

- Budget : le mode cloud consomme une session Actions — pour plusieurs items, préférer
  `/dispatch` (plafond 5, tri par taille, anti-collision géré).
- Un item ambigu ou gros ne part pas en cloud fire-and-forget : le traiter ici ou via une
  session cloud interactive (bouton 🌩 de FleetView), qui permettent le dialogue.
- Les écritures directes sur la branche par défaut ne concernent QUE BACKLOG.md via les gestes
  de cette skill — tout le reste suit branche + PR.
