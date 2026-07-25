# examples/workflows — livrés inertes, exprès

Ces workflows sont **volontairement hors de `.github/workflows/`** : actifs dès le push, les
crons `schedule` partiraient en échec quotidien (pas de secrets) ou consommeraient ton
abonnement chaque matin sans que tu l'aies décidé.

| Workflow | Déclencheur | Rôle | Prérequis |
|---|---|---|---|
| `brief-hebdo.yml` | cron 6h45 UTC (lundi) | brief hebdomadaire de la flotte (Haiku, CLI headless) | secrets `CLAUDE_CODE_OAUTH_TOKEN`, `FLEET_GH_TOKEN`, `NTFY_TOPIC`, `HEALTHCHECKS_API_KEY` |
| `claude.yml` | issue labellisée `claude` + commentaires `@claude` | stub d'entrée du dispatch (appelle `fleet-kit`) | ton fork de `fleet-kit` dans `uses:` ; secrets `CLAUDE_CODE_OAUTH_TOKEN` et `FLEET_GH_TOKEN` posés sur CE repo (transmis via `secrets: inherit`) |
| `codex-cadrage.yml` | cron 5h30 UTC + bouton + réponse sur une issue « idée » | trie les issues « idée » vers les BACKLOG.md | secrets `CLAUDE_CODE_OAUTH_TOKEN`, `FLEET_GH_TOKEN` ; labels `idée`/`à-préciser` |
| `fleet-refresh.yml` | cron lundi 5h30 UTC + bouton | rafraîchit le registre `fleet/fleet.json` — **0 token**, pur script Node | secret `FLEET_GH_TOKEN` |
| `kit-propagation.yml` | cron lundi 6h15 UTC + bouton | propage skills et `.kit-version` du kit vers les repos équipés | secret `FLEET_GH_TOKEN` |

**Activer** : adapte les placeholders + pose les secrets (voir « Adapter à ton usage » du
[README](../../README.md)), puis déplace le fichier voulu vers `.github/workflows/`.
