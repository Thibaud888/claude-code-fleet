# scripts — entretien automatique

> **Convention** : les scripts destinés à être lancés **par les sessions Claude** sont en
> **Node (.mjs)** — PowerShell est bloqué pour Claude sur cette machine. PowerShell reste OK
> pour les tâches planifiées Windows lancées par l'humain (hygiène).

## `fleet.mjs` — registre de flotte

Rafraîchit `fleet/fleet.json` par auto-découverte (`gh repo list`) : type, visibilité, branche
par défaut, `.kit-version` installée, workflows planifiés (crons). Préserve les champs édités
à la main (`type`, `statut`, `notes`). C'est **LA** liste des repos que lisent `/dispatch`,
le brief quotidien, la veille mensuelle et l'hygiène — aucune liste en dur ailleurs.

```bash
node scripts/fleet.mjs
```

## `kit-propager.mjs` — propager le kit vers la flotte

Aligne les repos équipés sur la dernière version du kit, sans clone ni `/equiper` repo par repo.
Ne propage **que ce que le kit possède et fait évoluer** : les skills de session
(`templates/common/.claude/skills/`) et `.kit-version`. Ne touche jamais un skill maison, le
CLAUDE.md, l'allowlist ni les workflows — ceux-là restent du ressort de `/equiper`, qui fusionne
avec jugement.

Pour chaque repo actif en retard au registre : 1 commit (API Git Data), 1 PR, puis **merge dès
CI verte**. Ce n'est pas `--auto` : l'auto-merge natif de GitHub suppose `allow_auto_merge`
activé sur le repo, ce qui n'est pas le défaut — le script attend donc les checks lui-même.
CI rouge → PR laissée ouverte. Repo portant `.claude/no-auto-merge` → PR laissée pour relecture.
**Idempotent** : un repo à jour est ignoré, sans diff ni PR.

```bash
node scripts/kit-propager.mjs --dry-run      # aperçu, n'écrit rien
node scripts/kit-propager.mjs                # propage vers toute la flotte
node scripts/kit-propager.mjs --repo <nom>   # un seul repo
node scripts/kit-propager.mjs --no-merge     # PRs ouvertes, sans merge
```

> Le **déclenchement** est automatisé par `examples/workflows/kit-propagation.yml` (hebdo). Ce
> workflow agit sur d'autres repos que le sien : le `github.token` d'un run ne voit que son
> propre dépôt, il lui faut donc un PAT cross-repo (`FLEET_GH_TOKEN`) avec le droit de créer
> des PR.

## `brief-data.mjs` — toutes les données du brief en un appel

Collecte l'état de la flotte (PRs ouvertes, workflows en échec, issues `claude`, Healthchecks)
et la semaine écoulée (PRs mergées, sessions cloud, tokens locaux), et sort **un JSON compact** :
la session de brief ne fait plus que rédiger, au lieu d'enchaîner ~30-45 appels `gh`.

```bash
node scripts/brief-data.mjs        # BRIEF_CLOUD=1 en Actions : saute le bloc ccusage local
```

### Suivi de dispatch — `dispatch_en_rade` (+ `brief-rade.mjs`)

Le contrôle de sortie du workflow de dispatch ne juge que le run : **un run vert ne prouve pas
que le travail a atterri**. Deux silences restaient donc sans témoin, et c'est ce que ce volet
remonte :

| `type` | Cas | Quoi faire |
|---|---|---|
| `issue` | issue `claude` ouverte > 1 h, aucune PR liée, aucune session en cours sur le repo | la session a échoué avant de pousser → relancer le dispatch |
| `pr` | PR de session ouverte alors que rien ne la bloque (checks verts > 1 h ; repo sans CI > 12 h) | le travail est fait mais pas livré → il ne manque qu'un merge |

Deux garde-fous contre le bruit : une session **en cours** (< 3 h) absout l'issue du repo, et une
PR n'est « de session » que si sa branche est `claude/issue-<n>` ou qu'un bot l'a poussée — une
branche `claude/…` poussée à la main est du travail local en cours, pas un dispatch en rade.
La logique est isolée dans `brief-rade.mjs` pour être testable sans réseau :

```bash
node scripts/brief-rade.test.mjs   # 32 cas, dont la DoD et les non-régressions de bruit
```

### Canari de token — `token_claude` (+ `token-canari.mjs`)

`fleet.mjs` vérifie que le secret `CLAUDE_CODE_OAUTH_TOKEN` **existe** — l'API ne livre que des
noms de secrets, jamais leur valeur. Elle ne dit donc pas s'il **fonctionne**. Un token révoqué
laisse le registre au vert pendant que chaque session échoue au premier tour, et ça reste
invisible jusqu'au prochain dispatch.

Le canari ne déclenche **rien** : il relit la durée de l'étape d'appel des runs **déjà passés**
(pas de run témoin à payer — les crons d'une flotte équipée appellent Claude plusieurs fois par
jour, ce qui suffit). Un rejet d'authentification revient en 1-2 s ; un appel réel prend des
dizaines de secondes — d'où le seuil à 15 s. **La couleur du run ne suffit pas** : un échec peut
venir d'ailleurs, et un rejet d'auth peut très bien sortir vert.

Il s'arrête à la première **preuve** — un appel assez long pour que l'auth soit forcément passée ;
plafond de 6 runs examinés, car beaucoup de runs `MAP` sont court-circuités par leur garde. Le
verdict `suspect` ne tombe que si des appels courts **et** en échec s'accumulent sans aucune preuve.

```bash
node scripts/token-canari.test.mjs   # 17 cas, sur des durées d'étapes réellement observées
```

## `tokens-hebdo.mjs` — bilan tokens hebdomadaire

Mesure deux mondes sur 7 jours glissants : le **local** (via `ccusage` : total par jour, par
modèle, ratio de cache, top sessions) et le **cloud** (via `gh` : runs Claude/MAP/Self-heal par
repo, avec l'effet des gardes et le compteur de relances par commentaire `@claude`).

### Coût par automatisme

Le bloc `cloud.automatismes` répond à « **qu'est-ce qui coûte, chez moi ?** » — dispatch,
relances, MAP, self-heal, brief, cadrage, propagation. C'est la base d'arbitrage quand il faut
décider quoi couper, ou s'il vaut le coup de changer de forfait.

Deux sources, dans cet ordre :

1. **Le coût réel, lu dans le log du run.** `claude-code-action` écrit le JSON de résultat de la
   session dans le log : on y relit `total_cost_usd`. Même chose pour un workflow headless qui
   lance son `claude -p` en **`--output-format json`** — c'est la seule raison d'utiliser ce
   format, et ça vaut la peine de le faire partout.
2. **Un forfait calibré, en repli run par run.** Pour les runs qui ne loguent pas leur coût
   (workflow pas encore passé en JSON, log tronqué). Les valeurs de `FORFAITS_USD` sont
   calibrées sur une flotte réelle : **réadapte-les à la tienne**.

Chaque poste expose `chiffrees` / `au_forfait` : on voit donc en un coup d'œil quelle part du
chiffre est mesurée et quelle part est estimée. Un poste à `au_forfait` élevé est une invitation
à passer le workflow correspondant en `--output-format json`.

> ⚠️ **La couleur du run ne suffit pas, ici non plus.** Un run `skipped` (garde du stub :
> commentaire sans `@claude`, auteur non autorisé) n'est ni une session ni un échec : il est
> sorti du comptage, sans quoi les gardes gonflaient les chiffres. Et une session `failure`
> **sans coût logué** a planté *avant* la session (setup, auth) — comptée en échec, pas en
> session : un vrai run de session logue son coût même quand il échoue.

Les sessions cloud **web** (claude.ai/code) ne sont pas mesurées ici. Leur coût réel est dans
l'archive `harvest` (`result.total_cost_usd` par tour) — donc estimable, mais à la revue
mensuelle, au rythme de cette archive.

L'instantané part dans `rapport/tokens/data/<AAAA-SNN>.json`, **versionné** : c'est la mémoire
longue du bilan, ce qui permet de comparer une semaine à l'autre. Comme la fenêtre mesurée est
de 7 jours **glissants**, une exécution un autre jour produirait la même semaine ISO sur une
fenêtre décalée — donc une archive fausse. D'où la garde :

| Exécution | Écrit dans |
|---|---|
| dimanche (run nominal), ou `--force` | `<AAAA-SNN>.json` — l'archive versionnée |
| tout autre jour | `<AAAA-SNN>.local.json` — fichier de travail, ignoré par git |

Un test se lance donc sans précaution ; `--force` sert au rattrapage d'un dimanche manqué. Le
JSON de sortie porte `archive.nominale` pour que la session de bilan sache ce qu'elle lit.

## Hooks du socle — branchés dans `~/.claude/settings.json`

| Script | Hook | Rôle |
|---|---|---|
| `guard.mjs` | PreToolUse (Bash) | Bloque le push direct sur `main` des repos projet (sauf claude-ops/fleet-kit) et les commits/commandes contenant un motif de secret. exit 2 = refus expliqué à Claude. Le repo est résolu depuis le `cd <chemin>` en tête de commande ou le `git -C <chemin>` (sinon le cwd de session), un worktree est rattaché à son repo principal, et le motif `main`/`master` n'est cherché que derrière un `git push` (pas dans les `-m`/`--comment`). |
| `check.mjs` | PostToolUse (Edit\|Write) | Lance le check du projet touché — script npm `claude:check` (opt-in) ou `ruff` sur le fichier `.py` — et n'injecte **que les échecs**. Vérification à 0 token. |

> Le hook Stop `notify.mjs` (notif ntfy de fin de session locale) a été retiré le 2026-07-11 :
> l'app Claude Code notifie déjà nativement sur le téléphone (`agentPushNotifEnabled`), la notif
> ntfy en plus faisait doublon et trop de bruit. ntfy reste utilisé pour ce qui n'a pas d'autre
> canal : self-heal (cron cassé) et le brief quotidien (uniquement s'il y a du 🔴/🟡).

Tous **fail-open** : un hook cassé ne bloque jamais une session. Vérif de `guard.mjs` :
`node scripts/guard.test.mjs` (repos git jetables + rejeu d'entrées de hook, 17 cas). Test manuel :
`echo '{"tool_input":{"command":"git push origin main"},"cwd":"<repo projet>"}' | node scripts/guard.mjs`
⚠️ Chemin `cwd` avec des **slashs** (`C:/…`) : des backslashes = JSON invalide → fail-open « autorisé ».

## `hygiene.ps1` — hygiène GitHub hebdomadaire

Nettoie les branches `claude/*` du compte **VOTRE-COMPTE** et signale ce qui traîne.

> ⚠️ **À lancer en local.** Le sandbox Cloud n'a pas les droits de suppression de branches
> (403) — d'où l'exécution locale. Un agent Claude planifié (Cloud) ne pourrait
> que *signaler*, pas supprimer.

### Ce que fait le script
- **Supprime** les branches `claude/*` déjà intégrées, détectées via **deux** critères
  (pour couvrir aussi les *squash-merges*) :
  - `ahead_by == 0` vs la branche par défaut, **ou**
  - la branche est la **tête d'une PR déjà mergée**.
- **Ne touche jamais** : une branche par défaut (tronc), ni la tête d'une **PR ouverte**.
- **Signale sans toucher** : branches non mergées inactives > 30 j, PRs ouvertes inactives > 14 j,
  et la **dérive de kit de flotte** (`.kit-version` des repos vs `fleet-kit/VERSION`
  → relancer `/equiper` sur les retardataires). Les repos de type `meta` en sont exclus : ils
  *portent* le kit sans l'installer, les lister en retard chaque semaine n'était que du bruit.
- **Synchronise le socle** en fin de passe, via `socle-sync.mjs` (`~/.claude` → `socle-local/`) :
  sans ce rendez-vous, la sauvegarde versionnée du socle dérive silencieusement.
- **Sortie** : rapport markdown daté dans `rapport/hygiene/hygiene-AAAA-MM-JJ.md`.

### Usage
```powershell
# Aperçu, sans rien supprimer :
powershell.exe -ExecutionPolicy Bypass -File scripts\hygiene.ps1 -DryRun

# Exécution réelle :
powershell.exe -ExecutionPolicy Bypass -File scripts\hygiene.ps1

# Paramètres : -Owner, -StaleBranchDays (30), -StalePrDays (14)
```
Prérequis : `gh` CLI authentifié (`gh auth status`).

## Planification — chaque lundi 9h (Planificateur de tâches Windows)

Enregistrée sous le nom **`ClaudeOps-HygieneGitHub`** (mode réel). Ouverture de session
**Interactive** : la tâche ne tourne que quand tu es connecté (nécessaire pour que `gh`
accède au trousseau Windows).

### (Re)créer la tâche
```powershell
$scriptPath = "$HOME\vos-repos\claude-ops\scripts\hygiene.ps1"
# Ping Healthchecks : une tâche planifiée n'hérite PAS des variables de ta console —
# poser l'URL au niveau utilisateur (sinon pas de ping, jamais d'alerte de retard) :
[Environment]::SetEnvironmentVariable("HEALTHCHECK_URL_HYGIENE", "<url hc-ping du check>", "User")
$action    = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""
$trigger   = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 9:00am
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName "ClaudeOps-HygieneGitHub" -Action $action -Trigger $trigger -Principal $principal -Force
```

### Inspecter / lancer à la main / supprimer
```powershell
Get-ScheduledTaskInfo -TaskName "ClaudeOps-HygieneGitHub"   # prochaine exécution, dernier résultat
Start-ScheduledTask   -TaskName "ClaudeOps-HygieneGitHub"   # forcer un run maintenant
Unregister-ScheduledTask -TaskName "ClaudeOps-HygieneGitHub" -Confirm:$false   # supprimer
```

> Équivalent `schtasks` (ligne de commande brute) :
> `schtasks /Create /TN ClaudeOps-HygieneGitHub /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"<chemin>\scripts\hygiene.ps1\"" /SC WEEKLY /D MON /ST 09:00 /IT /F`

## Les autres scripts — prérequis

| Script | Rôle | Prérequis |
|---|---|---|
| `brief-data.mjs` | collecte du brief en **1 appel** (PRs, workflows en échec, issues `claude`, Healthchecks, dispatch en rade, canari de token) | `gh` authentifié · `fleet/fleet.json` présent (généré par `fleet.mjs`) · clé API dans env `HEALTHCHECKS_API_KEY` ou fichier `~/.claude/healthchecks-api-key` · en local `npx ccusage` (réseau) pour le volet usage · `BRIEF_CLOUD=1` sur runner cloud (saute ce volet) |
| `brief-rade.mjs` · `token-canari.mjs` | volets de `brief-data.mjs`, isolés pour être testables sans réseau (`*.test.mjs`) | aucun — fonctions pures, on leur passe les données |
| `tokens-hebdo.mjs` | bilan tokens hebdo (local ccusage + cloud Actions) | `npx ccusage` (réseau) · `gh` authentifié · `fleet/fleet.json` |
| `kit-propager.mjs` | propage le kit vers les repos en retard (PR + merge) | `gh` authentifié avec le droit de créer des PR sur toute la flotte · `fleet/fleet.json` |
| `backlog-collect.mjs` | agrège les `BACKLOG.md` de la flotte en un JSON (lu par `/backlog`) | `gh` authentifié · `fleet/fleet.json` |
| `socle-sync.mjs` | recopie `~/.claude` → `socle-local/` pour que le socle versionné ne dérive pas | aucun — lit le socle local |
| `meta-ratio.mjs` | part du **méta** dans l'activité de la flotte (lu par la revue mensuelle) | `gh` authentifié · `fleet/fleet.json` |
| `ntfy.mjs` | notification téléphone (`node scripts/ntfy.mjs "titre" "corps"`) | topic dans env `NTFY_TOPIC` ou fichier `~/.claude/ntfy-topic` |
| `statusline.mjs` | statusline Claude Code (% de contexte) | aucun — lit le JSON du harness sur stdin |
| `gist-cleanup.mjs` | purge des gists de brief > 30 j | `gh` authentifié |

Tous : **Node ≥ 18** (fetch natif). La variable d'env **`FLEET_OWNER`** remplace le compte
par défaut de `fleet.mjs` / `brief-data.mjs` / `tokens-hebdo.mjs` **sans éditer les sources**.
Pings locaux : env `HEALTHCHECK_URL_HARVEST` (split-harvest) et `HEALTHCHECK_URL_HYGIENE`
(hygiène) — jamais d'URL hc-ping en dur.
