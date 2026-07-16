# skills — skills Claude Code maison

Industrialisation de la méthode de travail (backlog, dispatch, handoff entre sessions) en skills
Claude Code, **installées dans `~/.claude/skills/` par jonction NTFS** (la source est vue
immédiatement par Claude Code local, sans copie).

## Où vit chaque skill (réparties par portée cloud)

Une session **Cloud** (claude.ai/code sur navigateur / téléphone) ne lit **pas** `~/.claude/` :
elle ne voit que le `.claude/skills/` du repo qu'elle ouvre. Les skills sont donc placées là où
le cloud saura les trouver :

| Skill | Source | Dispo en Cloud… |
|---|---|---|
| `/backlog`, `/dispatch` | `claude-ops/.claude/skills/` (ici même) | …en ouvrant **claude-ops** (tour de contrôle de la flotte) |
| `/bilan`, `/handoff`, `/reprends` | `fleet-kit/templates/common/.claude/skills/` → posées dans **chaque repo** par `/equiper` | …dans **tout repo équipé** (là où tu travailles) |
| `/equiper`, `/nouveau-projet` | `claude-ops/skills/` (ce dossier) | — outils **locaux** (gèrent des clones sur ta machine) |

## Installation locale (jonctions NTFS — déjà faite sur cette machine)

`~/.claude/skills/<name>` → dossier source (via `mklink /J`, sans droits admin). Cibles actuelles :
- `backlog`, `dispatch` → `claude-ops/.claude/skills/`
- `bilan`, `handoff`, `reprends` → `fleet-kit/templates/common/.claude/skills/`
- `equiper`, `nouveau-projet` → `claude-ops/skills/`

Sur une autre machine : recréer ces 7 jonctions après clone (`mklink /J <lien> <cible>`).
Les jonctions sont **locales** (comme tout `~/.claude` — cf. `socle-local/`).

## Format
Chaque skill = un dossier `<name>/SKILL.md` avec frontmatter YAML (`name`, `description`)
puis le corps en markdown. La `description` sert au déclenchement : la garder précise.
