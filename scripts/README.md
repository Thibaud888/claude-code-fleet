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
  → relancer `/equiper` sur les retardataires).
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
| `brief-data.mjs` | collecte du brief quotidien en **1 appel** (PRs, échecs 24 h, issues `claude`, Healthchecks) | `gh` authentifié · `fleet/fleet.json` présent (généré par `fleet.mjs`) · clé API dans env `HEALTHCHECKS_API_KEY` ou fichier `~/.claude/healthchecks-api-key` · `BRIEF_CLOUD=1` sur runner cloud |
| `tokens-hebdo.mjs` | bilan tokens hebdo (local ccusage + cloud Actions) | `npx ccusage` (réseau) · `gh` authentifié · `fleet/fleet.json` |
| `ntfy.mjs` | notification téléphone (`node scripts/ntfy.mjs "titre" "corps"`) | topic dans env `NTFY_TOPIC` ou fichier `~/.claude/ntfy-topic` |
| `statusline.mjs` | statusline Claude Code (% de contexte) | aucun — lit le JSON du harness sur stdin |
| `gist-cleanup.mjs` | purge des gists de brief > 30 j | `gh` authentifié |

Tous : **Node ≥ 18** (fetch natif). La variable d'env **`FLEET_OWNER`** remplace le compte
par défaut de `fleet.mjs` / `brief-data.mjs` / `tokens-hebdo.mjs` **sans éditer les sources**.
Pings locaux : env `HEALTHCHECK_URL_HARVEST` (split-harvest) et `HEALTHCHECK_URL_HYGIENE`
(hygiène) — jamais d'URL hc-ping en dur.
