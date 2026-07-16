#!/usr/bin/env node
// Statusline Claude Code : modèle · repo@branche · % de contexte utilisé.
// Le % de contexte visible en continu change les habitudes (savoir quand /clear ou /compact)
// — pilier de l'« hygiène tokens » du CLAUDE.md global. 0 token (hook d'affichage).
//
// Branché dans ~/.claude/settings.json → "statusLine". Reçoit sur stdin le JSON du harness ;
// le % est estimé depuis le dernier usage du transcript (input + cache), fenêtre 200k.
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";

const FENETRE = 200_000;

let entree = {};
try {
  entree = JSON.parse(readFileSync(0, "utf8"));
} catch { /* stdin illisible → statusline minimale */ }

// --- Modèle ---
const modele = entree.model?.display_name ?? entree.model?.id ?? "Claude";

// --- Dossier + branche git ---
const dossier = entree.workspace?.current_dir ?? entree.cwd ?? process.cwd();
let repoBranche = basename(dossier);
try {
  const branche = execFileSync("git", ["-C", dossier, "rev-parse", "--abbrev-ref", "HEAD"],
    { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  if (branche) repoBranche += `@${branche}`;
} catch { /* pas un repo git */ }

// --- % de contexte : dernier `usage` d'un message assistant du transcript ---
// On ne lit que la fin du fichier (les transcripts font parfois des dizaines de Mo et la
// statusline tourne à chaque message).
let ctx = null;
try {
  const chemin = entree.transcript_path;
  const taille = statSync(chemin).size;
  const LIRE = 262_144; // 256 KB de fin de fichier
  const fd = openSync(chemin, "r");
  const buf = Buffer.alloc(Math.min(LIRE, taille));
  readSync(fd, buf, 0, buf.length, Math.max(0, taille - buf.length));
  closeSync(fd);
  const lignes = buf.toString("utf8").split("\n");
  for (let i = lignes.length - 1; i >= 0; i--) {
    let u;
    try { u = JSON.parse(lignes[i])?.message?.usage; } catch { continue; }
    if (u?.input_tokens !== undefined) {
      ctx = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      break;
    }
  }
} catch { /* pas de transcript (début de session) */ }

const morceaux = [`\x1b[36m${modele}\x1b[0m`, `\x1b[2m${repoBranche}\x1b[0m`];
if (ctx !== null) {
  const pct = Math.min(100, Math.round((ctx / FENETRE) * 100));
  const couleur = pct >= 75 ? "\x1b[31m" : pct >= 50 ? "\x1b[33m" : "\x1b[32m";
  const conseil = pct >= 75 ? " → /clear ou /compact" : "";
  morceaux.push(`${couleur}ctx ${pct}% (${Math.round(ctx / 1000)}k)${conseil}\x1b[0m`);
}
process.stdout.write(morceaux.join("  ·  "));
