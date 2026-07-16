// split-harvest.mjs — decoupe les bundles claude-cloud-harvest-part*.json en fichiers par session
// + digests markdown lisibles + inventaire enrichi.
// Usage : node split-harvest.mjs   (depuis harvest/)
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ARCHIVE = path.join(HERE, 'archive');
const SESS_DIR = path.join(ARCHIVE, 'sessions');
const DIG_DIR = path.join(ARCHIVE, 'digests');
fs.mkdirSync(SESS_DIR, { recursive: true });
fs.mkdirSync(DIG_DIR, { recursive: true });

// Tri NUMÉRIQUE des parts : les moissons incrémentales (harvest-console.js) sont horodatées
// (part1752…), elles doivent passer APRÈS part1-6 pour que leurs sessions/events (plus
// récents) écrasent les anciens — un tri lexicographique les mettrait avant part2.
const parts = fs.readdirSync(ARCHIVE)
  .filter(f => /^claude-cloud-harvest-part\d+\.json$/.test(f))
  .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
let sessionsMeta = null;
const allEvents = {};
for (const p of parts) {
  const j = JSON.parse(fs.readFileSync(path.join(ARCHIVE, p), 'utf8'));
  if (j.sessions) sessionsMeta = j.sessions;
  Object.assign(allEvents, j.events);
  console.log(`${p}: ${Object.keys(j.events).length} sessions`);
}
if (!sessionsMeta) throw new Error('métadonnées sessions introuvables (part1)');

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const texts = content.filter(b => b.type === 'text' && b.text).map(b => b.text);
  return texts.length ? texts.join('\n') : null;
};

const digest = (meta, events) => {
  const lines = [];
  const repo = meta.config?.sources?.[0]?.url?.replace('https://github.com/', '') || 'aucun repo';
  lines.push(`# ${meta.title || meta.id}`);
  lines.push('');
  lines.push(`- **Session** : ${meta.id}`);
  lines.push(`- **Repo** : ${repo}`);
  lines.push(`- **Créée** : ${meta.created_at} · dernier event : ${meta.last_event_at || '?'}`);
  lines.push(`- **Statut** : ${meta.status} · messages utilisateur : ${meta.user_message_count ?? '?'} · events : ${events.length}`);
  const pts = meta.external_metadata?.post_turn_summary;
  if (pts?.status_detail) lines.push(`- **Résumé final** : ${pts.status_detail}`);
  lines.push('');
  for (const ev of events) {
    const msg = ev.payload?.message;
    if (!msg) continue;
    if (ev.event_type === 'user') {
      const isToolResult = Array.isArray(msg.content) && msg.content.every(b => b.type === 'tool_result');
      if (isToolResult) continue;
      const t = textOf(msg.content);
      if (t && t.trim()) { lines.push('## 🧑 Utilisateur', '', t.trim(), ''); }
    } else if (ev.event_type === 'assistant') {
      const t = textOf(msg.content);
      if (t && t.trim()) { lines.push('## 🤖 Claude', '', t.trim(), ''); }
    }
  }
  return lines.join('\n');
};

let userMsgTotal = 0, evTotal = 0;
const inventory = [];
for (const meta of sessionsMeta) {
  const evObj = allEvents[meta.id];
  const events = evObj?.data || [];
  evTotal += events.length;
  fs.writeFileSync(path.join(SESS_DIR, `${meta.id}.json`), JSON.stringify({ meta, events }));
  fs.writeFileSync(path.join(DIG_DIR, `${meta.id}.md`), digest(meta, events));
  const userMsgs = events.filter(e => e.event_type === 'user' && e.payload?.message &&
    !(Array.isArray(e.payload.message.content) && e.payload.message.content.every(b => b.type === 'tool_result'))).length;
  userMsgTotal += userMsgs;
  inventory.push({
    sessionId: meta.id,
    title: meta.title || null,
    repo: meta.config?.sources?.[0]?.url?.replace('https://github.com/', '') || null,
    createdAt: meta.created_at,
    lastEventAt: meta.last_event_at || null,
    status: meta.status,
    userMessages: userMsgs,
    events: events.length,
    error: evObj?.__error || null,
    harvested: !evObj?.__error,
  });
}
inventory.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
fs.writeFileSync(path.join(HERE, 'inventory.json'), JSON.stringify(inventory, null, 2));
console.log(`\n${inventory.length} sessions | ${evTotal} events | ${userMsgTotal} messages utilisateur`);
console.log(`→ ${SESS_DIR}\n→ ${DIG_DIR}\n→ inventory.json réécrit (enrichi)`);

// Chien de garde Healthchecks : signale que la moisson a tourné (hc-ping).
// URL de ping = secret → jamais en dur : variable d'env HEALTHCHECK_URL_HARVEST. Absente = pas de ping.
const HC_URL = process.env.HEALTHCHECK_URL_HARVEST;
if (HC_URL) {
  try { await fetch(HC_URL, { method: "POST", signal: AbortSignal.timeout(5000) }); } catch { /* jamais bloquant */ }
}
