# harvest — l'archive des sessions Cloud

> Principe : chaque PR créée en session Cloud porte une URL `claude.ai/code/session_<id>` ;
> on peut donc inventorier puis rapatrier les transcripts pour une mémoire longue.

## Rythme — moisson hebdomadaire, dimanche soir — SANS session Claude (0 token)

> La moisson ne consomme aucun token : pas de modèle dans la boucle, juste un snippet console
> autonome ([`harvest-console.js`](harvest-console.js)) que tu colles toi-même.

1. Ouvrir `claude.ai/code` dans Chrome (connecté), **F12 → Console**.
2. Coller le contenu de `harvest/harvest-console.js` → Entrée. (Si Chrome bloque le collage :
   taper `allow pasting` puis recoller. Autoriser les téléchargements multiples si demandé.)
   Le snippet liste les sessions, moissonne celles actives depuis 8 jours (réglage
   `DEPUIS_JOURS` en tête de fichier si des semaines ont été sautées) et télécharge des
   `claude-cloud-harvest-part<horodatage>.json`.
3. Déplacer ces fichiers de `Téléchargements` vers `harvest/archive/`.
4. `node harvest/split-harvest.mjs` — qui **pingue Healthchecks**
   (check `claude-ops/harvest-hebdo`, dimanche 22h, grâce 24 h) : si la moisson est oubliée,
   alerte lundi soir. Le brief du lundi matin le rappelle aussi.

Plan B si l'API interne change : une session Claude ouverte sur `claude.ai/code` sait
re-découvrir les requêtes via l'onglet Réseau du navigateur, puis régénérer le snippet.

## Décisions durables

- **L'archive reste locale** (`archive/` est gitignorée) : les transcripts peuvent contenir
  des secrets collés en session. Pas de passe de redaction ni de push — la revue mensuelle
  (`revue-mensuelle-flotte`) tourne **en local** et peut donc la lire. (Alternative « archive
  redacted poussée » écartée : coût/bénéfice défavorable tant que la revue est locale.)
- **Angle mort connu** : les sessions Cloud **sans PR** ne figurent pas dans l'inventaire
  initial ; en cas de doute, comparer le compte de sessions sur claude.ai/code avec
  `inventory.json`, et repêcher via la procédure navigateur (statuts `active`/`paused`
  inclus dans les requêtes).
- Plafond de moisson : ~15 sessions par run (lisser la charge) ; les grosses sessions
  se paginent par 500 events.
