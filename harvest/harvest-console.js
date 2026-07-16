// harvest-console.js — moisson incrémentale des sessions Cloud SANS session Claude (0 token).
//
// Aucun modèle dans la boucle : c'est TOI qui colles ce script dans la console du navigateur.
//
// Mode d'emploi (dimanche soir) :
//   1. Ouvre https://claude.ai/code dans Chrome (connecté à ton compte).
//   2. F12 → onglet Console → colle TOUT ce fichier → Entrée.
//      (Si Chrome bloque : taper « allow pasting » puis recoller. Autoriser les
//      téléchargements multiples quand il le demande.)
//   3. Les fichiers claude-cloud-harvest-part<horodatage>.json arrivent dans Téléchargements :
//      déplace-les dans harvest/archive/.
//   4. Termine par : node harvest/split-harvest.mjs   (il pingue Healthchecks à la fin).
//
// Réglage : DEPUIS_JOURS = fenêtre incrémentale (8 = filet pour une moisson hebdo).
// Si tu as sauté des semaines, augmente-le (ex. 30) avant de coller.
(async () => {
  const DEPUIS_JOURS = 8;
  const TAILLE_MAX_PART = 35 * 1024 * 1024; // ~35 MB par fichier téléchargé
  const H = { "anthropic-version": "2023-06-01" };
  const dodo = (ms) => new Promise((r) => setTimeout(r, ms));
  const getJson = async (url) => {
    const r = await fetch(url, { headers: H, credentials: "include" });
    if (!r.ok) throw new Error(`HTTP ${r.status} sur ${url}`);
    return r.json();
  };

  // ---- 1. Liste complète des sessions (4 statuts, pagination) ----
  console.log("🌾 Moisson : inventaire des sessions…");
  const parId = new Map();
  for (const statut of ["active", "paused", "completed", "archived"]) {
    let cursor = null;
    do {
      const u = new URL("https://claude.ai/v1/code/sessions");
      u.searchParams.set("statuses", statut);
      u.searchParams.set("limit", "100");
      if (cursor) u.searchParams.set("cursor", cursor);
      const j = await getJson(u);
      for (const s of j.data ?? j.sessions ?? []) parId.set(s.id, s);
      cursor = j.next_cursor ?? null;
      await dodo(200); // prudence : compte perso, pas une API publique
    } while (cursor);
  }
  const sessions = [...parId.values()];
  console.log(`   ${sessions.length} sessions au total.`);

  // ---- 2. Cibles incrémentales : activité dans la fenêtre ----
  const cutoff = Date.now() - DEPUIS_JOURS * 864e5;
  const cibles = sessions.filter((s) => {
    const dernier = s.last_event_at ?? s.created_at;
    return dernier && Date.parse(dernier) > cutoff;
  });
  console.log(`   ${cibles.length} sessions actives depuis ${DEPUIS_JOURS} j → à moissonner.`);

  // ---- 3. Events par session (limit=500 + pagination), découpage en parts ----
  let events = {};
  let tailleCourante = 0;
  let partsTelechargees = 0;
  const telecharger = () => {
    if (!Object.keys(events).length) return;
    // Le bundle embarque TOUTE la liste de sessions (split-harvest s'en sert comme
    // inventaire) + les events du lot courant. Nom horodaté : jamais de collision
    // avec les parts déjà dans archive/, et tri numérique = toujours le plus récent.
    const bundle = JSON.stringify({ sessions, events });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bundle], { type: "application/json" }));
    a.download = `claude-cloud-harvest-part${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    partsTelechargees += 1;
    console.log(`   💾 ${a.download} (${Object.keys(events).length} sessions, ${(tailleCourante / 1e6).toFixed(0)} MB)`);
    events = {};
    tailleCourante = 0;
  };

  let evTotal = 0;
  for (let i = 0; i < cibles.length; i++) {
    const s = cibles[i];
    try {
      const data = [];
      let cursor = null;
      do {
        const u = new URL(`https://claude.ai/v1/code/sessions/${s.id}/events`);
        u.searchParams.set("limit", "500");
        if (cursor) u.searchParams.set("cursor", cursor);
        const j = await getJson(u);
        data.push(...(j.data ?? []));
        cursor = j.next_cursor ?? null;
        await dodo(200);
      } while (cursor);
      events[s.id] = { data };
      evTotal += data.length;
      tailleCourante += JSON.stringify(events[s.id]).length;
      console.log(`   [${i + 1}/${cibles.length}] ${s.id} : ${data.length} events`);
    } catch (e) {
      events[s.id] = { data: [], __error: String(e) };
      console.warn(`   [${i + 1}/${cibles.length}] ${s.id} : ÉCHEC — ${e}`);
    }
    if (tailleCourante > TAILLE_MAX_PART) telecharger();
  }
  telecharger();

  console.log(`🌾 Terminé : ${cibles.length} sessions, ${evTotal} events, ${partsTelechargees} fichier(s).`);
  console.log("→ Déplace les fichiers de Téléchargements vers harvest/archive/,");
  console.log("→ puis lance : node harvest/split-harvest.mjs");
})();
