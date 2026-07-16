# examples/workflows — livrés inertes, exprès

Ces workflows sont **volontairement hors de `.github/workflows/`** : actifs dès le push, les
crons `schedule` partiraient en échec quotidien (pas de secrets) ou consommeraient ton
abonnement chaque matin sans que tu l'aies décidé.

| Workflow | Déclencheur | Rôle | Prérequis |
|---|---|---|---|
| `brief-quotidien.yml` | cron 6h45 UTC | brief matinal de la flotte (Haiku, CLI headless) | secrets `CLAUDE_CODE_OAUTH_TOKEN`, `FLEET_GH_TOKEN`, `NTFY_TOPIC`, `HEALTHCHECKS_API_KEY` |
| `claude.yml` | issue labellisée `claude` | stub d'entrée du dispatch (appelle `fleet-kit`) | ton fork de `fleet-kit` référencé dans `uses:` |
| `codex-cadrage.yml` | cron 5h30 UTC + bouton | trie les issues « idée » vers les BACKLOG.md | secrets `CLAUDE_CODE_OAUTH_TOKEN`, `FLEET_GH_TOKEN` ; labels `idée`/`à-préciser` |

**Activer** : adapte les placeholders + pose les secrets (voir « Adapter à ton usage » du
[README](../../README.md)), puis déplace le fichier voulu vers `.github/workflows/`.
