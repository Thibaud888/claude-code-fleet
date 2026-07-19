#!/usr/bin/env node
// Part du méta : PRs mergées sur l'outillage (claude-ops, fleet-kit, fleetview) vs les
// projets, sur N jours (défaut 31). Utilisé par la revue mensuelle pour répondre à « la
// flotte travaille-t-elle pour la flotte ? » ; seuil d'alerte indicatif : > 30 % sur un
// mois sans chantier méta assumé.
// Usage : node scripts/meta-ratio.mjs [--days 31]
import { execFileSync } from "node:child_process";

const OWNER = process.env.FLEET_OWNER ?? "VOTRE-COMPTE";
const META = new Set(["claude-ops", "fleet-kit", "fleetview"]);
const iDays = process.argv.indexOf("--days");
const days = iDays > -1 ? Number(process.argv[iDays + 1]) || 31 : 31;
const depuis = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

const raw = execFileSync("gh", ["search", "prs", "--owner", OWNER, "--merged", "--limit", "500",
  "--json", "repository,number", `merged:>=${depuis}`], { encoding: "utf8" });
const parRepo = {};
for (const p of JSON.parse(raw)) {
  const r = p.repository?.name ?? "?";
  parRepo[r] = (parRepo[r] ?? 0) + 1;
}
const total = Object.values(parRepo).reduce((a, b) => a + b, 0);
const meta = Object.entries(parRepo).filter(([r]) => META.has(r)).reduce((a, [, n]) => a + n, 0);
console.log(JSON.stringify({
  periode_jours: days, depuis, prs_mergees: total,
  meta, projets: total - meta,
  pct_meta: total ? Math.round((100 * meta) / total) : null,
  par_repo: Object.fromEntries(Object.entries(parRepo).sort((a, b) => b[1] - a[1])),
}, null, 1));
