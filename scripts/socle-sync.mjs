#!/usr/bin/env node
// Synchronise ~/.claude (socle vivant) vers socle-local/ (copie versionnée, filet de
// sécurité) — appelé par l'hygiène hebdo (scripts/hygiene.ps1), lançable à la main.
// Sans ça, la sauvegarde dérive (constaté 2026-07-19 : 6 jours de retard, mémoire divergée).
// Copie CLAUDE.md, settings.json et memory/*.md ; supprime de socle-local/memory les fiches
// disparues ; commit direct sur main (repo méta), STRICTEMENT limité aux chemins socle-local/.
import { execFileSync } from "node:child_process";
import { copyFileSync, readdirSync, rmSync, existsSync, mkdirSync } from "node:fs";
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
const srcMem = join(SRC, "projects", "C--Users-vous-Documents-vos-repos", "memory");
const dstMem = join(DST, "memory");
mkdirSync(dstMem, { recursive: true });
const fiches = existsSync(srcMem) ? readdirSync(srcMem).filter((f) => f.endsWith(".md")) : [];
for (const f of fiches) copyFileSync(join(srcMem, f), join(dstMem, f));
for (const f of readdirSync(dstMem).filter((f) => f.endsWith(".md")))
  if (!fiches.includes(f)) rmSync(join(dstMem, f));

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
