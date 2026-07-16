#!/usr/bin/env node
// Purge les gists secrets créés par le brief quotidien (SKILL.md brief-flotte-quotidien,
// étape 4a) une fois trop vieux — sans ça ils s'accumulent indéfiniment sur
// gist.github.com/VOTRE-COMPTE avec un lien qui reste valide pour toujours.
//
// Usage : node scripts/gist-cleanup.mjs ["<préfixe description>"] [joursRetention]
// Défaut : préfixe "Brief flotte", rétention 30 jours. Ne cible QUE les descriptions
// exactement au format « <préfixe> AAAA-MM-JJ » (garde-fou avant suppression).
// Fail-open : une erreur ne doit jamais faire échouer la tâche planifiée qui l'appelle.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);
const prefixe = process.argv[2] ?? "Brief flotte";
const joursRetention = Number(process.argv[3] ?? 30);
const limite = Date.now() - joursRetention * 86_400_000;

// N'accepte QUE les descriptions « <préfixe> AAAA-MM-JJ » (celles créées par le brief,
// étape 4a) : un simple startsWith risquerait de purger un gist « Brief flotte — notes »
// créé à la main. Le préfixe est échappé pour rester littéral dans la regex.
const échapper = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const motif = new RegExp(`^${échapper(prefixe)} \\d{4}-\\d{2}-\\d{2}$`);

try {
  const { stdout } = await pExecFile("gh", ["api", "gists?per_page=100"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  const gists = JSON.parse(stdout);
  const aSupprimer = gists.filter(
    (g) => motif.test(g.description ?? "") && Date.parse(g.created_at) < limite
  );

  let supprimes = 0;
  for (const g of aSupprimer) {
    try {
      await pExecFile("gh", ["gist", "delete", g.id, "--yes"], { timeout: 15_000 });
      supprimes += 1;
    } catch (e) {
      console.error(`gist-cleanup : échec suppression ${g.id} — ${e.message}`);
    }
  }
  console.log(`gist-cleanup : ${supprimes}/${aSupprimer.length} gist(s) supprimé(s) (> ${joursRetention} j, préfixe "${prefixe}").`);
} catch (e) {
  console.error(`gist-cleanup : non exécuté — ${e.message}`);
}
process.exit(0);
