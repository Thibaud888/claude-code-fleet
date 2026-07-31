#!/usr/bin/env node
// Synchronise ~/.claude (socle vivant) vers socle-local/ (copie versionnée, filet de
// sécurité) — appelé par l'hygiène hebdo (scripts/hygiene.ps1), lançable à la main.
// Sans ça, la sauvegarde dérive (constaté 2026-07-19 : 6 jours de retard, mémoire divergée).
// Copie CLAUDE.md, settings.json et TOUS les magasins de mémoire ; supprime de socle-local les
// fiches disparues ; commit direct sur main (repo méta), STRICTEMENT limité aux chemins socle-local/.
//
// Mémoire : Claude Code range les fiches par RÉPERTOIRE DE SESSION
// (`~/.claude/projects/<clé>/memory/`). Jusqu'au 2026-07-26, ce script n'en sauvegardait qu'un
// seul — celui des sessions lancées depuis le dossier parent : 13 magasins de projet sur 14
// (74 fiches, un magasin par projet) n'avaient AUCUNE copie
// versionnée. Désormais : le magasin de flotte va à plat dans `socle-local/memory/`
// (continuité), chaque magasin de projet dans `socle-local/memory/<projet>/`.
// Les jonctions (plusieurs clés pointant sur le même dossier réel) ne sont copiées qu'une fois.
import { execFileSync } from "node:child_process";
import { copyFileSync, readdirSync, rmSync, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(homedir(), ".claude");
const DST = join(ROOT, "socle-local");
const git = (...args) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim();

for (const f of ["CLAUDE.md", "settings.json"]) {
  if (existsSync(join(SRC, f))) copyFileSync(join(SRC, f), join(DST, f));
}
const PROJETS = join(SRC, "projects");
const CLE_FLOTTE = "C--Users-vous-Documents-vos-repos";
const dstMem = join(DST, "memory");
mkdirSync(dstMem, { recursive: true });

// Nom du sous-dossier de sauvegarde : la clé de session privée de son préfixe machine.
const nomCourt = (cle) => (cle.startsWith(`${CLE_FLOTTE}-`) ? cle.slice(CLE_FLOTTE.length + 1) : cle);

const magasins = existsSync(PROJETS)
  ? readdirSync(PROJETS)
      .map((cle) => ({ cle, dir: join(PROJETS, cle, "memory") }))
      .filter((m) => existsSync(m.dir) && statSync(m.dir).isDirectory())
  : [];

const vus = new Set();
const dossiersAttendus = new Set();
let copiees = 0;
for (const m of magasins) {
  const reel = realpathSync(m.dir); // une jonction ne doit pas produire un doublon
  if (vus.has(reel)) continue;
  vus.add(reel);
  const flotte = m.cle === CLE_FLOTTE;
  const cible = flotte ? dstMem : join(dstMem, nomCourt(m.cle));
  if (!flotte) dossiersAttendus.add(nomCourt(m.cle));
  mkdirSync(cible, { recursive: true });
  const fiches = readdirSync(m.dir).filter((f) => f.endsWith(".md"));
  for (const f of fiches) copyFileSync(join(m.dir, f), join(cible, f));
  copiees += fiches.length;
  for (const f of readdirSync(cible).filter((f) => f.endsWith(".md")))
    if (!fiches.includes(f)) rmSync(join(cible, f)); // fiche supprimée en amont
}
// Magasin de projet disparu (repo archivé, dossier renommé) : on retire sa sauvegarde.
for (const d of readdirSync(dstMem))
  if (statSync(join(dstMem, d)).isDirectory() && !dossiersAttendus.has(d))
    rmSync(join(dstMem, d), { recursive: true, force: true });
console.log(`socle-sync : ${copiees} fiche(s) de mémoire depuis ${vus.size} magasin(s).`);

// Commit ciblé, seulement s'il y a un diff — clone partagé entre sessions : on ne commit
// jamais autre chose que socle-local/, et jamais hors de main.
if (git("branch", "--show-current") !== "main") {
  console.log("socle-sync : clone pas sur main — fichiers copiés, commit sauté.");
  process.exit(0);
}
git("add", "--", "socle-local");
if (!git("diff", "--cached", "--name-only", "--", "socle-local")) {
  console.log("socle-sync : déjà à jour.");
  process.exit(0);
}
git("commit", "-m", "socle : synchronisation (hygiène hebdo)", "--", "socle-local");
git("push");
console.log("socle-sync : socle-local synchronisé et poussé.");
