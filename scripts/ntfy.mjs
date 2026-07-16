#!/usr/bin/env node
// Notification ntfy, factorisée hors des tâches planifiées (3e récurrence : brief quotidien,
// revue mensuelle, bilan tokens hebdo — cf. règle « écris l'outil, pas l'output »).
//
// Toujours invoqué comme `node scripts/ntfy.mjs` : ça matche l'allow global
// "Bash(node:*)" de ~/.claude/settings.json, donc AUCUNE approbation à chaque run — contrairement
// à un curl à la main, qui n'est pas dans l'allowlist et redemande l'approbation (la commande
// change de contenu à chaque envoi, donc ne matche jamais l'approbation précédente).
//
// Usage : node scripts/ntfy.mjs "<titre>" "<corps>" [--priority=high] [--tags=rotating_light]
//         [--click=https://...] [--markdown]
// Fail-open : topic absent, réseau en échec → n'écrit rien de bloquant, exit 0 dans tous les cas
// (une notif ratée ne doit jamais faire échouer la tâche planifiée qui l'appelle).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [titre, corps, ...reste] = process.argv.slice(2);
const option = (nom, defaut) =>
  reste.find((a) => a.startsWith(`--${nom}=`))?.slice(nom.length + 3) ?? defaut;

if (!titre || !corps) {
  console.error("Usage : node scripts/ntfy.mjs \"<titre>\" \"<corps>\" [--priority=high] [--tags=...]");
  process.exit(0); // fail-open : mauvais appel ≠ raison de casser la tâche appelante
}

try {
  // Env d'abord (secret NTFY_TOPIC en cloud/GitHub Actions), fichier local en repli (sessions locales).
  const topic = (process.env.NTFY_TOPIC ?? readFileSync(join(homedir(), ".claude", "ntfy-topic"), "utf8")).trim();
  if (!topic) throw new Error("topic vide");

  const headers = { Title: titre, Priority: option("priority", "default") };
  const tags = option("tags", null);
  if (tags) headers.Tags = tags;
  const click = option("click", null);
  if (click) headers.Click = click;
  if (reste.includes("--markdown")) headers.Markdown = "yes";

  const rep = await fetch(`https://ntfy.sh/${topic}`, {
    method: "POST",
    headers,
    body: corps,
    signal: AbortSignal.timeout(10_000),
  });
  if (!rep.ok) throw new Error(`HTTP ${rep.status}`);
  console.log(`ntfy : notification envoyée (« ${titre} »).`);
} catch (e) {
  console.error(`ntfy : notification non envoyée — ${e.message}`);
}
process.exit(0);
