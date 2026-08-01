---
name: projets
description: Vue d'ensemble des projets de la flotte — ce qui existe, à quoi ça sert, où c'est en ligne et où ça en est (en cours / livré / terminé), en widget cliquable ou en markdown. Permet aussi d'interroger la doc d'un projet en langage courant et de changer son état. Utiliser quand l'utilisateur dit « /projets », « mes projets », « qu'est-ce que j'ai comme projets », « c'est quoi déjà ce projet », « donne-moi le lien du site de <projet> », « où est déployé <projet> », « l'URL de <projet> », « est-ce qu'on a mis <option> dans <projet> », « je me rappelle plus si <projet> fait <chose> », « <projet> est terminé », « mets <projet> en pause », « ce projet est livré ».
---

# /projets — ce que j'ai construit : à quoi ça sert, où c'est, où ça en est

Complément de `/backlog` : le backlog dit ce qu'il **reste à faire**, ceci dit ce qui **existe**.
Source unique : `claude-ops/fleet/fleet.json` — jamais une seconde liste de projets ailleurs.
**Portée : le répertoire courant de la session n'influence JAMAIS la vue.**

La vue se veut **instantanée** : elle ne fait aucun appel réseau. Elle vaut ce que vaut le
registre — d'où le `git pull` en tête. Seuls les gestes d'interrogation vont chercher au loin.

## Les trois états d'un projet

| Ce qu'on lit | Dans le registre | Ce que ça veut dire | Conséquences |
|---|---|---|---|
| 🟢 **En cours** | `actif` | je code dessus en ce moment | visible dans `/backlog` et `/dispatch`, maintenu à jour par le kit |
| 🔵 **Livré** | `veille` | v1 sortie et en service ; plus de dev, mais je peux rouvrir | **sort de `/backlog` et de `/dispatch`** · ne reçoit plus les mises à jour du kit |
| ⚪ **Terminé** | `archivé` | fini ou abandonné, je n'y reviens pas | sort de tout le reste aussi |

C'est le sens de l'outil : passer un projet en 🔵 ou ⚪ le **fait disparaître du backlog sans
vider son BACKLOG.md**. Les items restent dans le repo, simplement invisibles ; repasser le
projet en 🟢 les fait tous revenir. Rien n'est jamais perdu.

**La surveillance, elle, ne suit PAS le statut — elle suit ce qui tourne.** Un projet ⚪ terminé
dont le cron continue de tourner reste dans le brief et dans le bilan de tokens : c'est souvent
tout ce qui reste de lui, et une panne doit remonter. Le cas typique est un projet fini dont
tout l'intérêt est justement que son cron parte chaque semaine — « je n'y touche plus » ne veut
pas dire « je me fiche qu'il casse ». En cas de panne : le repasser en 🟢 le temps de le
réparer. Ce que le statut coupe vraiment, c'est le **travail** — items de backlog, dispatch, PR
de maintenance du kit, et les PR remontées par le brief.

Les repos de `type` **meta** ou **contenu** (claude-ops, fleet-kit, claude-code-fleet, notes de
cours…) ne sont pas des projets : ils vivent dans un pied « Outillage & notes », hors des trois
états. Ne jamais les compter comme des projets en cours.

## Gestes

| Geste | Effet |
|---|---|
| `/projets` | la vue : tous les projets par état, avec description et lien vers le site |
| `/projets <repo>` | la fiche d'un projet |
| `/projets <repo> <question>` | interroger la doc du projet en langage courant |
| `/projets statut [<repo>] [<état>]` | changer l'état d'un projet |

**Résolution du repo — ne jamais exiger le nom exact.** `node scripts/projets.mjs <filtre>`
résout déjà : nom exact prioritaire, sinon sous-chaîne, casse ignorée. Sortie en erreur =
plusieurs candidats ou aucun → AskUserQuestion avec les candidats (≤ 4).

## Vue — `/projets`

1. `git -C <clone claude-ops> pull`, puis **un seul appel, zéro réseau** :
   `node <clone claude-ops>/scripts/projets.mjs --widget` →
   `{cours:[{n,p,u,t}],livre:[…],termine:[…],outillage:["nom",…]}`
   (`n` nom · `p` description en clair · `u` URL du site · `t` type).
   Le script lit le registre, écarte les types meta/contenu vers `outillage`, et range tout
   statut inconnu dans `termine` — un projet qu'on ne sait pas classer doit rester visible.
   **Ne jamais lire `fleet.json` directement pour la vue** : le registre entier pèse ~4× la
   sortie du script, pour la même information.
2. **Rendu widget** (défaut quand `mcp__visualize__show_widget` est disponible) : appeler
   `mcp__visualize__read_me` (module `interactive`) puis `show_widget` avec le contenu de
   `widget-template.html` (même dossier que cette skill), en remplaçant la ligne
   `const DATA={cours:[],livre:[],termine:[],outillage:[]};` par `const DATA=<JSON>;`.
   **Ne pas réécrire le template** : le lire et injecter les données — c'est le geste le moins
   cher. Il gère seul les sections vides, le pied « Outillage » et les liens externes.
3. **Repli markdown** (outil indisponible, ex. CLI) : `node scripts/projets.mjs` sans drapeau
   sort déjà le markdown attendu — l'afficher tel quel.
4. Si des projets sortent « à décrire » ou sans lien, le **signaler en une ligne** sous la vue,
   avec le geste pour combler : renseigner *Description* et *Website* du repo sur GitHub (repris
   au prochain `node scripts/fleet.mjs`), ou écrire `pitch` / `site` dans `fleet.json`.

## Fiche — `/projets <repo>`

`node scripts/projets.mjs <repo>` : état, description, lien, technique (type, branche,
visibilité, kit, dispatch), crons, notes. Y ajouter dans la réponse, si c'est utile : le nombre
d'items ouverts (`node scripts/backlog-collect.mjs --widget <repo>`) et la dernière activité
(`gh repo view <owner>/<repo> --json pushedAt`). Aucune écriture.

## Interroger — `/projets <repo> <question>`

Le cas d'usage : « je ne me rappelle plus si on a mis telle option dans ce projet ». La réponse
doit arriver **vite**, et dire **d'où elle sort**.

1. **La doc d'abord** (~3 s, 2 appels) : `MAP.md` puis, si besoin, `README.md` du repo —
   `gh api repos/<owner>/<repo>/contents/MAP.md -H "Accept: application/vnd.github.raw"`.
   Répondre dès que la réponse y est, en nommant le fichier.
2. **Le code en repli seulement** : annoncer qu'on y passe (« pas dans la doc, je regarde le
   code »), puis chercher — clone local `~\Documents\vos-repos\<repo>` s'il
   existe (Grep, le plus rapide), sinon `gh search code --repo <owner>/<repo> <termes>`.
   Cibler : quelques termes, pas une lecture intégrale. ~30 s.
3. **Ne jamais inventer.** Rien trouvé = le dire (« ni dans la doc ni dans le code, sur ces
   termes-là »), et proposer les termes voisins essayés. Une réponse fausse coûte plus cher que
   l'absence de réponse : c'est un outil de mémoire, il doit être fiable.

Pas de sous-agent, pas d'exploration large, pas de clone : ce geste doit rester court. Une
question qui demande une vraie investigation n'est plus une question de `/projets` — le dire et
proposer d'ouvrir un chantier.

## Changer l'état — `/projets statut <repo> <état>`

État manquant ou ambigu → AskUserQuestion (3 options, décrites par leur **conséquence** : cf.
la table des trois états ci-dessus, jamais par le nom technique).

Écriture de `fleet/fleet.json` : `statut` et rien d'autre. `claude-ops` est un repo méta, le
commit direct sur `main` y est autorisé — pas de PR pour une ligne de registre.

- **En session locale** : éditer le fichier dans le clone, `git pull` d'abord, puis commit +
  push (message `registre : <repo> passe en <état>`). **Vérifier `branch --show-current` et
  `status` avant de commiter** — les clones sont partagés entre sessions.
- **En session cloud** : API contents. **Re-fetch du fichier distant juste avant le PUT**
  (`fleet.json` est aussi écrit par d'autres sessions et par `fleet-refresh.yml` du lundi — on
  a déjà écrasé du travail comme ça). Passer le corps par `gh api --input <fichier>`, jamais en
  argument de ligne de commande. 409 → re-GET et rejouer.

Après un passage en 🔵 ou ⚪, **dire en une ligne ce qui disparaît** : « N items de backlog
sortent de la vue, ils restent dans le repo » — c'est l'effet recherché, il doit être annoncé.

FleetView sait déjà faire ce geste depuis le téléphone (il écrit le même champ) : les deux
chemins sont interchangeables.

## Garde-fous

- **Un seul domicile pour la liste des projets.** Toute information durable sur un projet va
  dans `fleet.json` (`pitch`, `site`, `statut`, `notes`) — jamais dans un fichier annexe, jamais
  en dur dans cette skill. C'est la règle qui a évité un second backlog concurrent.
- Ne jamais changer `type` ni `statut` « au passage » pendant un autre geste : ces champs sont
  manuels, ils se changent sur demande explicite.
- La vue ne dit pas la santé (pannes, PR bloquées) : ça, c'est le brief. Ne pas la dupliquer ici.
