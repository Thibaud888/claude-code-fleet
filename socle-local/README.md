# socle-local — sauvegarde versionnée du socle `~/.claude`

> **Filet de sécurité, pas une source auto-chargée.** Ce dossier est une **copie** du socle
> global de cette machine (`~/.claude`). Claude Code ne lit *pas* ce dossier : il lit
> `~/.claude`. On le versionne uniquement pour ne rien perdre si la machine change.

## Portée (important)
- Ce socle n'est vu **que par les sessions locales** de la machine où `~/.claude` est configuré.
- Les **sessions Cloud ne lisent pas `~/.claude`** (environnement éphémère isolé qui ne voit
  que le repo cloné). Pour briefer le Cloud : un **CLAUDE.md par repo** (posé par le kit).

## Contenu
| Fichier | Origine | Rôle |
|---|---|---|
| `CLAUDE.example.md` | `~/.claude/CLAUDE.md` | Modèle du brief global chargé dans chaque session locale. |
| `settings.example.json` | `~/.claude/settings.json` | Modèle : prefs + **allowlist de permissions** + branchement des hooks. |

> Non versionnés : `~/.claude/.credentials.json` (secret), les caches/sessions, et le dossier
> `memory/` (fiches mémoire persistantes = données personnelles — laissées hors de cet extrait public).

## Restaurer / initialiser sur une machine
```powershell
# depuis la racine du repo claude-ops — renomme les modèles en retirant .example
Copy-Item socle-local\CLAUDE.example.md     $HOME\.claude\CLAUDE.md -Force
Copy-Item socle-local\settings.example.json $HOME\.claude\settings.json -Force
# puis remplace dans ces deux fichiers les placeholders VOTRE-COMPTE et ~/vos-repos.
```

Après restauration, ouvrir une session neuve et demander « qui suis-je et comment je travaille ? » :
la réponse doit venir sans contexte fourni à la main.
