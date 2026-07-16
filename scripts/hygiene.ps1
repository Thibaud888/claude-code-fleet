#Requires -Version 5.1
<#
.SYNOPSIS
    Hygiène GitHub hebdomadaire pour le compte VOTRE-COMPTE.

.DESCRIPTION
    À lancer EN LOCAL (le sandbox Cloud n'a pas les droits de suppression de branches — 403).
    Pour chaque repo non archivé du compte :
      - Supprime les branches claude/* déjà intégrées, détectées via DEUX critères :
          * ahead_by == 0 vs la branche par défaut (merge classique / fast-forward), OU
          * la branche est la tête d'une PR déjà MERGÉE (couvre les squash-merges).
      - Ne supprime JAMAIS : une branche par défaut (tronc), ni la tête d'une PR OUVERTE.
      - Signale (sans toucher) les branches claude/* non mergées inactives > StaleBranchDays,
        et les PRs ouvertes inactives > StalePrDays.
    Pour chaque clone local sous le dossier de repos (hors repos sans remote ou hors
    compte $Owner) :
      - git pull --ff-only si strictement en retard sur son origin.
      - Ne touche JAMAIS un clone avec des commits locaux non poussés, une divergence,
        ou des modifications non commitées (signalé, jamais de merge/rebase auto).
    Écrit un rapport markdown daté dans rapport/hygiene/.

.PARAMETER DryRun
    N'effectue AUCUNE suppression : liste seulement ce qui serait supprimé.

.EXAMPLE
    pwsh scripts/hygiene.ps1 -DryRun
    powershell.exe -ExecutionPolicy Bypass -File scripts\hygiene.ps1

.NOTES
    Prérequis : gh CLI authentifié (gh auth status). Aucune dépendance externe.
#>
[CmdletBinding()]
param(
    [string]$Owner = "VOTRE-COMPTE",
    [switch]$DryRun,
    [int]$StaleBranchDays = 30,
    [int]$StalePrDays = 14
)


# "Continue", pas "Stop" : git/gh écrivent parfois sur stderr en fonctionnement normal
# (ex. "no such remote"). Avec "Stop", PowerShell 5.1 promeut ce texte en erreur bloquante
# MEME derrière un "2>$null" — tout le script repose sur des checks $LASTEXITCODE explicites,
# c'est ce mécanisme-là qui doit trancher, pas une promotion silencieuse en exception.
$ErrorActionPreference = "Continue"

# --- Prérequis : gh authentifié ---
& gh auth status *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Error "gh CLI n'est pas authentifié. Lance 'gh auth login' puis relance ce script."
    exit 1
}

# --- Chemins ---
$RepoRoot  = Split-Path -Parent $PSScriptRoot           # .../claude-ops
$ReportDir = Join-Path $RepoRoot "rapport\hygiene"
if (-not (Test-Path $ReportDir)) { New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null }
$Now        = Get-Date
$Stamp      = $Now.ToString("yyyy-MM-dd")
$ReportPath = Join-Path $ReportDir "hygiene-$Stamp.md"

# --- Accumulateurs ---
$deleted  = @()   # branches supprimées         {Repo, Branch, Reason}
$wouldDel = @()   # dry-run : à supprimer        {Repo, Branch, Reason}
$failed   = @()   # échecs de suppression        {Repo, Branch}
$staleBr  = @()   # branches non mergées âgées   {Repo, Branch, Days, LastCommit}
$stalePr  = @()   # PRs ouvertes âgées           {Repo, Number, Title, Days, Updated, Draft}
$drift    = @()   # dérive de kit de flotte      {Repo, Installed, Current}
$scanned  = 0

Write-Host "Hygiène GitHub ($Owner)$(if ($DryRun) {' — DRY-RUN'})..." -ForegroundColor Cyan

$repos = & gh repo list $Owner --limit 200 --json name,defaultBranchRef,isArchived | ConvertFrom-Json

foreach ($repo in $repos) {
    if ($repo.isArchived) { continue }
    $name = $repo.name
    $def  = if ($repo.defaultBranchRef) { $repo.defaultBranchRef.name } else { $null }
    if (-not $def) { continue }   # repo vide, pas de branche par défaut

    $branchesRaw    = & gh api "repos/$Owner/$name/branches" --paginate --jq ".[].name" 2>$null
    $claudeBranches = @($branchesRaw | Where-Object { $_ -like "claude/*" })
    if ($claudeBranches.Count -eq 0) { continue }
    $scanned++

    # PRs ouvertes (têtes à préserver + candidates au signalement)
    $openPrs = @()
    $op = & gh pr list --repo "$Owner/$name" --state open --json number,headRefName,title,createdAt,updatedAt,isDraft --limit 200 | ConvertFrom-Json
    if ($op) { $openPrs = @($op) }
    $openHeads = @($openPrs | ForEach-Object { $_.headRefName })

    # PRs mergées (têtes = branches intégrées, y compris squash)
    $mergedHeads = @()
    $mp = & gh pr list --repo "$Owner/$name" --state merged --json headRefName --limit 400 | ConvertFrom-Json
    if ($mp) { $mergedHeads = @($mp | ForEach-Object { $_.headRefName }) }

    foreach ($br in $claudeBranches) {
        if ($br -eq $def)               { continue }   # tronc : jamais
        if ($openHeads -contains $br)   { continue }   # PR ouverte : on garde

        # Intégrée ?
        $integrated = $false; $reason = ""
        if ($mergedHeads -contains $br) {
            $integrated = $true; $reason = "PR mergée"
        }
        else {
            $ahead = & gh api "repos/$Owner/$name/compare/$def...$br" --jq ".ahead_by" 2>$null
            if ($ahead -eq "0") { $integrated = $true; $reason = "mergée (ahead=0)" }
        }

        if ($integrated) {
            if ($DryRun) {
                $wouldDel += [pscustomobject]@{ Repo = $name; Branch = $br; Reason = $reason }
            }
            else {
                & gh api -X DELETE "repos/$Owner/$name/git/refs/heads/$br" 2>$null | Out-Null
                if ($LASTEXITCODE -eq 0) { $deleted += [pscustomobject]@{ Repo = $name; Branch = $br; Reason = $reason } }
                else                     { $failed  += [pscustomobject]@{ Repo = $name; Branch = $br } }
            }
        }
        else {
            # Non mergée : âge du dernier commit
            $d = & gh api "repos/$Owner/$name/commits/$br" --jq ".commit.committer.date" 2>$null
            if ($d) {
                $age = [int]((Get-Date) - [datetime]$d).TotalDays
                if ($age -gt $StaleBranchDays) {
                    $staleBr += [pscustomobject]@{ Repo = $name; Branch = $br; Days = $age; LastCommit = ([datetime]$d).ToString("yyyy-MM-dd") }
                }
            }
        }
    }

    # PRs ouvertes inactives
    foreach ($pr in $openPrs) {
        $age = [int]((Get-Date) - [datetime]$pr.updatedAt).TotalDays
        if ($age -gt $StalePrDays) {
            $stalePr += [pscustomobject]@{ Repo = $name; Number = $pr.number; Title = $pr.title; Days = $age; Updated = ([datetime]$pr.updatedAt).ToString("yyyy-MM-dd"); Draft = [bool]$pr.isDraft }
        }
    }
}

# --- Synchronisation des clones locaux (git pull --ff-only) ---
# Ne touche jamais un clone avec des commits locaux non poussés ou des modifs non commitées :
# on rapatrie seulement ce qui est strictement en retard, jamais de merge/rebase auto.
$LocalRoot      = Split-Path -Parent $RepoRoot   # .../<dossier de repos>
$localDone      = @()   # pull réel effectué             {Repo, Branch, Behind}
$localWouldPull = @()   # dry-run : serait rapatrié       {Repo, Branch, Behind}
$localFlagged   = @()   # commits locaux ou divergence — jamais touché {Repo, Branch, Ahead, Behind}
$localSkipped   = @()   # sans remote / hors compte / modifs locales  {Repo, Reason}
$localFailed    = @()   # fetch/pull en échec             {Repo, Reason}

Get-ChildItem -Path $LocalRoot -Directory | ForEach-Object {
    $dir  = $_.FullName
    $name = $_.Name
    if (-not (Test-Path (Join-Path $dir ".git"))) { return }

    Push-Location $dir
    try {
        $originUrl = & git remote get-url origin 2>$null
        if (-not $originUrl) { $localSkipped += [pscustomobject]@{ Repo = $name; Reason = "sans remote" }; return }
        if ($originUrl -notmatch "github\.com[:/]$Owner/") { $localSkipped += [pscustomobject]@{ Repo = $name; Reason = "remote hors compte $Owner" }; return }

        $dirty = & git status --porcelain --untracked-files=no 2>$null
        if ($dirty) { $localSkipped += [pscustomobject]@{ Repo = $name; Reason = "modifications locales non commitées" }; return }

        & git fetch --prune --quiet origin 2>$null
        if ($LASTEXITCODE -ne 0) { $localFailed += [pscustomobject]@{ Repo = $name; Reason = "fetch échoué" }; return }

        $upstream = & git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $upstream) { $localSkipped += [pscustomobject]@{ Repo = $name; Reason = "pas de branche amont configurée" }; return }

        $branch    = & git rev-parse --abbrev-ref HEAD 2>$null
        $aheadRaw  = & git rev-list --count "$upstream..HEAD" 2>$null
        $behindRaw = & git rev-list --count "HEAD..$upstream" 2>$null
        $ahead = 0; $behind = 0
        [void][int]::TryParse("$aheadRaw", [ref]$ahead)
        [void][int]::TryParse("$behindRaw", [ref]$behind)

        if ($ahead -gt 0) {
            $localFlagged += [pscustomobject]@{ Repo = $name; Branch = $branch; Ahead = $ahead; Behind = $behind }
        }
        elseif ($behind -gt 0) {
            if ($DryRun) {
                $localWouldPull += [pscustomobject]@{ Repo = $name; Branch = $branch; Behind = $behind }
            } else {
                & git pull --ff-only --quiet 2>$null
                if ($LASTEXITCODE -eq 0) { $localDone += [pscustomobject]@{ Repo = $name; Branch = $branch; Behind = $behind } }
                else                     { $localFailed += [pscustomobject]@{ Repo = $name; Reason = "pull --ff-only échoué sur $branch" } }
            }
        }
    }
    catch {
        $localFailed += [pscustomobject]@{ Repo = $name; Reason = "erreur inattendue : $($_.Exception.Message)" }
    }
    finally { Pop-Location }
}
$localSyncList = if ($DryRun) { $localWouldPull } else { $localDone }

# --- Dérive de kit de flotte (fleet.json vs fleet-kit/VERSION) ---
$FleetPath = Join-Path $RepoRoot "fleet\fleet.json"
$kitCurrent = $null
if (Test-Path $FleetPath) {
    $kvRaw = & gh api "repos/$Owner/fleet-kit/contents/VERSION" --jq ".content" 2>$null
    if ($LASTEXITCODE -eq 0 -and $kvRaw) {
        $kitCurrent = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($kvRaw -replace "\s", ""))).Trim()
        $fleet = Get-Content $FleetPath -Raw | ConvertFrom-Json
        foreach ($f in $fleet.repos) {
            if ($f.statut -ne "actif") { continue }
            if ($f.type -in @("contenu")) { continue }
            if (-not $f.kit_version -or $f.kit_version -ne $kitCurrent) {
                $installed = if ($f.kit_version) { $f.kit_version } else { "non installé" }
                $drift += [pscustomobject]@{ Repo = $f.repo; Installed = $installed; Current = $kitCurrent }
            }
        }
    }
}

# --- Rapport markdown ---
$sb = New-Object System.Text.StringBuilder
function Add-Line([string]$t = "") { [void]$sb.AppendLine($t) }

$mode = if ($DryRun) { "DRY-RUN (aucune suppression effectuée)" } else { "exécution réelle" }
Add-Line "# Rapport d'hygiène GitHub — $Stamp"
Add-Line ""
Add-Line "> Généré par ``scripts/hygiene.ps1`` — mode : **$mode**."
Add-Line "> Compte : ``$Owner`` · repos avec branches claude/* scannés : **$scanned**."
Add-Line ""
Add-Line "## Résumé"
Add-Line ""
Add-Line "| Métrique | Valeur |"
Add-Line "|---|---|"
if ($DryRun) { Add-Line "| Branches intégrées à supprimer (dry-run) | $($wouldDel.Count) |" }
else         { Add-Line "| Branches intégrées supprimées | $($deleted.Count) |" }
Add-Line "| Échecs de suppression | $($failed.Count) |"
Add-Line "| Branches non mergées inactives > $StaleBranchDays j (signalées) | $($staleBr.Count) |"
Add-Line "| PRs ouvertes inactives > $StalePrDays j (signalées) | $($stalePr.Count) |"
Add-Line "| Repos en retard de kit de flotte | $($drift.Count) |"
if ($DryRun) { Add-Line "| Clones locaux à synchroniser (dry-run) | $($localSyncList.Count) |" }
else         { Add-Line "| Clones locaux synchronisés (pull ff-only) | $($localSyncList.Count) |" }
Add-Line "| Clones locaux à surveiller (commits non poussés / divergence) | $($localFlagged.Count) |"
Add-Line ""

$delList = if ($DryRun) { $wouldDel } else { $deleted }
$delTitle = if ($DryRun) { "Branches intégrées qui SERAIENT supprimées" } else { "Branches intégrées supprimées" }
Add-Line "## $delTitle"
Add-Line ""
if ($delList.Count -eq 0) { Add-Line "_Aucune._" }
else {
    Add-Line "| Repo | Branche | Détection |"
    Add-Line "|---|---|---|"
    foreach ($x in ($delList | Sort-Object Repo, Branch)) { Add-Line "| $($x.Repo) | ``$($x.Branch)`` | $($x.Reason) |" }
}
Add-Line ""

if ($failed.Count -gt 0) {
    Add-Line "## ⚠️ Échecs de suppression"
    Add-Line ""
    Add-Line "| Repo | Branche |"
    Add-Line "|---|---|"
    foreach ($x in $failed) { Add-Line "| $($x.Repo) | ``$($x.Branch)`` |" }
    Add-Line ""
}

$localSyncTitle = if ($DryRun) { "Clones locaux qui SERAIENT synchronisés" } else { "Clones locaux synchronisés" }
Add-Line "## 🔄 $localSyncTitle (pull --ff-only, $LocalRoot)"
Add-Line ""
if ($localSyncList.Count -eq 0) { Add-Line "_Aucun._" }
else {
    Add-Line "| Repo | Branche | Commits rapatriés |"
    Add-Line "|---|---|---|"
    foreach ($x in ($localSyncList | Sort-Object Repo)) { Add-Line "| $($x.Repo) | ``$($x.Branch)`` | $($x.Behind) |" }
}
Add-Line ""

if ($localFlagged.Count -gt 0) {
    Add-Line "## ⚠️ Clones locaux avec commits non poussés ou divergents — jamais touché"
    Add-Line ""
    Add-Line "| Repo | Branche | En avance | En retard |"
    Add-Line "|---|---|---|---|"
    foreach ($x in ($localFlagged | Sort-Object Repo)) { Add-Line "| $($x.Repo) | ``$($x.Branch)`` | $($x.Ahead) | $($x.Behind) |" }
    Add-Line ""
}

if ($localFailed.Count -gt 0) {
    Add-Line "## ⚠️ Échecs de synchronisation locale"
    Add-Line ""
    Add-Line "| Repo | Raison |"
    Add-Line "|---|---|"
    foreach ($x in $localFailed) { Add-Line "| $($x.Repo) | $($x.Reason) |" }
    Add-Line ""
}

Add-Line "## ⏳ Branches non mergées inactives (> $StaleBranchDays j) — à décider"
Add-Line ""
if ($staleBr.Count -eq 0) { Add-Line "_Aucune._" }
else {
    Add-Line "| Repo | Branche | Dernier commit | Âge (j) |"
    Add-Line "|---|---|---|---|"
    foreach ($x in ($staleBr | Sort-Object Days -Descending)) { Add-Line "| $($x.Repo) | ``$($x.Branch)`` | $($x.LastCommit) | $($x.Days) |" }
}
Add-Line ""

Add-Line "## 🧰 Dérive de kit de flotte — relancer /equiper"
Add-Line ""
if (-not $kitCurrent) { Add-Line "_fleet.json ou fleet-kit/VERSION introuvable — section sautée._" }
elseif ($drift.Count -eq 0) { Add-Line "_Toute la flotte est au kit v$kitCurrent._" }
else {
    Add-Line "Kit courant : **v$kitCurrent**."
    Add-Line ""
    Add-Line "| Repo | Kit installé |"
    Add-Line "|---|---|"
    foreach ($x in ($drift | Sort-Object Repo)) { Add-Line "| $($x.Repo) | $($x.Installed) |" }
}
Add-Line ""

Add-Line "## 📬 PRs ouvertes inactives (> $StalePrDays j) — à traiter"
Add-Line ""
if ($stalePr.Count -eq 0) { Add-Line "_Aucune._" }
else {
    Add-Line "| Repo | PR | Titre | MàJ | Âge (j) | Draft |"
    Add-Line "|---|---|---|---|---|---|"
    foreach ($x in ($stalePr | Sort-Object Days -Descending)) { Add-Line "| $($x.Repo) | #$($x.Number) | $($x.Title) | $($x.Updated) | $($x.Days) | $($x.Draft) |" }
}
Add-Line ""

Set-Content -Path $ReportPath -Value $sb.ToString() -Encoding UTF8

# --- Sortie console ---
Write-Host ""
if ($DryRun) { Write-Host ("À supprimer (dry-run) : {0} · " -f $wouldDel.Count) -NoNewline }
else         { Write-Host ("Supprimées : {0} · " -f $deleted.Count) -NoNewline }
Write-Host ("échecs : {0} · branches périmées : {1} · PRs périmées : {2} · retards de kit : {3}" -f $failed.Count, $staleBr.Count, $stalePr.Count, $drift.Count)
Write-Host ("Clones locaux : {0} synchronisés · {1} à surveiller · {2} ignorés · {3} échecs" -f $localSyncList.Count, $localFlagged.Count, $localSkipped.Count, $localFailed.Count)
Write-Host ("Rapport : {0}" -f $ReportPath) -ForegroundColor Green

# --- Chien de garde Healthchecks : signale que l hygiene a bien tourne ---
# En cas d echec du script avant cette ligne, l absence de ping declenchera l alerte (grace 6h).
# URL de ping = secret -> jamais en dur : variable d environnement HEALTHCHECK_URL_HYGIENE
# (a poser sur la tache planifiee). Absente = pas de ping.
if ($env:HEALTHCHECK_URL_HYGIENE) {
    try { Invoke-RestMethod -Uri $env:HEALTHCHECK_URL_HYGIENE -Method Post -TimeoutSec 10 | Out-Null } catch { }
}
