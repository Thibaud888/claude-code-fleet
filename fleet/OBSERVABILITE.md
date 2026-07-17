# Observabilité de la flotte

> Principe : **plus rien ne meurt en silence.** Trois étages, du moins au plus grave :
> notification simple (ntfy) → chien de garde des crons (Healthchecks) → auto-réparation (self-heal).

## 1. ntfy — les notifications téléphone

- **Topic privé** : dans `~/.claude/ntfy-topic` (non versionné) + secret `NTFY_TOPIC` sur les
  repos qui notifient. Abonnement : app ntfy → Subscribe to topic.
- **Qui émet** — volontairement réduit au 2026-07-11 à ce qui n'a pas d'autre canal (l'app
  Claude Code notifie déjà nativement sur le téléphone pour les sessions locales, donc pas
  besoin d'un doublon ntfy) :
  - le self-heal (échec de cron → « Claude est dessus ») ;
  - le brief quotidien (8h45), **seulement s'il y a du 🔴 ou du 🟡** — silence si tout est ✅ RAS.
- ⚠️ Canal **à sens unique** : écrire dans le topic ne déclenche rien. Pour donner un ordre
  depuis le téléphone → issue GitHub labellisée `claude`.

## 2. Healthchecks.io — le chien de garde des crons

Un check par tâche planifiée. La tâche **pingue** son URL à chaque run (succès, ou `/fail`) ;
si le ping n'arrive pas dans les temps (retard, cron désactivé par GitHub après 60 j
d'inactivité, machine éteinte…), Healthchecks alerte. Grâce : 6 h (24 h pour la moisson hebdo).

| Check | Planning | Pingé par |
|---|---|---|
| `mon-cron-node/publish` | tous les jours 14h30 UTC | job `ping` du workflow |
| `mon-cron-python/veille` | lundi + jeudi 10h UTC | job `ping` du workflow |
| `mon-autre-cron/weekly-digest` | mardi 7h UTC | job `ping` du workflow |
| `claude-ops/hygiene-hebdo` | lundi 9h (Europe/Paris) | fin de `scripts/hygiene.ps1` (env `HEALTHCHECK_URL_HYGIENE`) |
| `claude-ops/harvest-hebdo` | dimanche 22h (grâce 24 h) | fin de `harvest/split-harvest.mjs` (env `HEALTHCHECK_URL_HARVEST`) |

- **Ajouter un check** (nouveau cron) : API v3 avec la clé (Settings → API access),
  `POST https://healthchecks.io/api/v3/checks/` avec `{"name","schedule","tz","grace":21600,
  "channels":"*","unique":["name"]}` → poser l'URL de ping en secret `HEALTHCHECK_URL` du repo
  → ajouter le job `ping` en fin de workflow (modèle : le `veille.yml` d'un cron,
  via l'action `VOTRE-COMPTE/fleet-kit/actions/notify@main`).
- **Alertes** : `channels: "*"` = tous les canaux configurés côté Healthchecks. Brancher
  l'intégration **ntfy** dans l'UI Healthchecks (Integrations) pour recevoir ces alertes
  sur le téléphone ; sinon e-mail par défaut.

## 3. Self-heal — l'auto-réparation

Stub `self-heal.yml` sur chaque repo à cron, câblé sur le **nom** réel du workflow planifié.
Échec du cron → dans le même run : issue ouverte/mise à jour avec les logs (label `self-heal`),
notification ntfy, puis **session Claude CLI** qui diagnostique et — si c'est un bug du repo —
ouvre une PR de fix (`claude/self-heal-<issue>`). Cause externe (API tierce, quota, secret) :
commentaire de diagnostic, pas de code. Testé de bout en bout sur un repo à cron.

## Pièges appris (ne pas re-tomber dedans)

- `claude-code-action` **refuse les événements `push` et `workflow_run`** → map.yml et
  self-heal.yml passent par le **CLI** (`npm i -g @anthropic-ai/claude-code` + `claude -p`).
  L'action reste utilisée pour le dispatch (`issues`/`issue_comment`, supportés).
- `gh secret set` en stdin interactif peut créer un secret **vide** → toujours passer la valeur
  par `--body`/pipe et vérifier par un run.
- Les workflows réutilisables re-lancés (`gh run rerun`) gardent l'ANCIENNE version du workflow
  appelé — après un fix dans fleet-kit, déclencher un **nouveau** run (`gh workflow run`).
- Le réglage « Actions peut créer des PRs » est **par repo** (fait sur les 10 le 2026-07-10) ;
  tout nouveau repo devra l'activer (commande dans la skill `/equiper`, à lancer par toi).
