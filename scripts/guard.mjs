#!/usr/bin/env node
// Hook PreToolUse (Bash) : garde-fous déterministes, à 0 token.
//   1. Bloque le push direct sur main/master des repos projet (branche + PR obligatoires).
//      Exceptions : claude-ops et fleet-kit (repos méta, commit direct autorisé).
//   2. Bloque un commit dont le diff stagé (ou la commande) contient un motif de secret.
// exit 2 = refuse la commande et explique à Claude quoi faire à la place. Fail-open sinon.
// Vérif : node scripts/guard.test.mjs
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

// ← Adapte à TES repos méta : les NOMS DE DOSSIER des clones autorisés à committer sur main.
//   Si tu clones ce modèle sous un autre nom que claude-ops, ajoute ce nom ici.
const META_REPOS = new Set(["claude-ops", "fleet-kit"]);
const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{20,}/, // clé API Anthropic
  /ghp_[A-Za-z0-9]{30,}/, // token GitHub classique
  /github_pat_[A-Za-z0-9_]{30,}/, // token GitHub fine-grained
  /AKIA[0-9A-Z]{16}/, // clé AWS
  /xox[bp]-[A-Za-z0-9-]{20,}/, // token Slack
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

let cmd = "";
let cwd = process.cwd();
try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  cmd = input?.tool_input?.command ?? "";
  cwd = input?.cwd ?? cwd;
} catch {
  process.exit(0);
}

// input.cwd est le répertoire de la session, pas forcément le repo que la commande cible :
// un `cd <chemin>` en tête de commande, sinon un `git -C <chemin>`, désigne le vrai repo.
const asPath = (m) => resolve(cwd, (m[1] ?? m[2] ?? m[3]).replace(/^~(?=$|[\\/])/, homedir()));
const cdHead = cmd.match(/^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/);
const dashC = cmd.match(/\bgit\s+-C\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/);
const runCwd = cdHead ? asPath(cdHead) : dashC ? asPath(dashC) : cwd;

const git = (args) => {
  try {
    return execSync(`git ${args}`, { cwd: runCwd, timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
};

const block = (msg) => {
  process.stderr.write(`[hook guard] ${msg}\n`);
  process.exit(2);
};

try {
  // --- 1. push direct sur main ---
  // Seule la portion qui suit chaque `git push` (jusqu'au séparateur suivant) est scannée :
  // le reste de la commande (--comment, -m…) peut contenir « main » en prose.
  const pushTails = [...cmd.matchAll(/\bgit\b[^&;|\n]*?\bpush\b([^&;|\n]*)/g)].map((m) => m[1]);
  if (pushTails.length) {
    // Nom du repo = dossier parent du git-dir commun (rattache un worktree à son repo principal).
    const commonDir = git("rev-parse --git-common-dir");
    const repo = commonDir ? basename(dirname(resolve(runCwd, commonDir))) : "";
    if (repo && !META_REPOS.has(repo)) {
      const branch = git("rev-parse --abbrev-ref HEAD");
      const pushesToTrunk =
        ["main", "master"].includes(branch) ||
        pushTails.some((tail) => /(\s|:)(main|master)(\s|$)/.test(tail));
      if (pushesToTrunk) {
        block(
          `push vers main/master interdit sur le repo projet « ${repo} » (règle : branche + PR). ` +
            `Crée une branche (git checkout -b <type>/<slug>), pousse-la et ouvre une PR avec gh pr create.`
        );
      }
    }
  }

  // --- 2. secrets dans un commit (diff stagé) ou dans la commande elle-même ---
  if (SECRET_PATTERNS.some((p) => p.test(cmd))) {
    block("la commande contient un motif de secret (clé/token). Ne l'écris jamais en clair : utilise un secret GitHub ou une variable d'environnement.");
  }
  if (/\bgit\b[\s\S]*\bcommit\b/.test(cmd)) {
    const staged = git("diff --cached --no-color");
    if (staged && SECRET_PATTERNS.some((p) => p.test(staged))) {
      block("le diff stagé contient un motif de secret (clé/token). Retire-le (git restore --staged <fichier>), remplace par un secret GitHub ou une variable d'environnement, puis recommite.");
    }
  }
} catch {
  // fail-open
}
process.exit(0);
