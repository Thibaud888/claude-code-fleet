#!/usr/bin/env node
// Vérif autonome de guard.mjs (pas de cadre de test dans ce repo) : monte des repos git
// jetables dans un dossier temporaire, rejoue des entrées de hook comme le ferait le
// harness (JSON sur stdin), et compare bloqué/autorisé à l'attendu.
// Usage : node scripts/guard.test.mjs   (exit 0 si tout passe, 1 sinon)
import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GUARD = join(dirname(fileURLToPath(import.meta.url)), "guard.mjs");
const root = mkdtempSync(join(tmpdir(), "guard-test-"));
const sh = (c) => execSync(c, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });

const mkRepo = (name) => {
  const dir = join(root, name);
  sh(`git init -q -b main "${dir}"`);
  sh(`git -C "${dir}" -c user.email=guard@test -c user.name=guard commit -q --allow-empty -m init`);
  return dir;
};

// « fleetview » joue le repo projet (règle branche + PR), « claude-ops » le repo méta.
const proj = mkRepo("fleetview");
const meta = mkRepo("claude-ops");
sh(`git -C "${proj}" branch feat/x`);
mkdirSync(join(proj, "sub"));
const wtProj = join(root, "wt-proj");
const wtMeta = join(root, "wt-meta");
sh(`git -C "${proj}" worktree add -q "${wtProj}" -b claude/wt-proj`);
sh(`git -C "${meta}" worktree add -q "${wtMeta}" -b claude/wt-meta`);
const checkout = (dir, branch) => sh(`git -C "${dir}" checkout -q ${branch}`);

// Jeton factice construit à l'exécution pour que ce fichier ne contienne pas le motif.
const fakeToken = "ghp_" + "0123456789".repeat(4);

let failures = 0;
const expect = (label, blocked, command, cwd) => {
  const res = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_input: { command }, cwd }),
    encoding: "utf8",
    timeout: 30_000,
  });
  const got = res.status === 2 ? "bloqué" : "autorisé";
  const want = blocked ? "bloqué" : "autorisé";
  const ok = got === want;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} → ${got} (attendu : ${want})`);
};

// --- cas légitimes : doivent RESTER bloqués ---
expect("push main depuis un repo projet", true, "git push origin main", proj);
expect("push nu sur main depuis un repo projet", true, "git push", proj);
expect("push main depuis un sous-dossier du repo projet", true, "git push origin main", join(proj, "sub"));
checkout(proj, "feat/x");
expect("refspec feat/x:main depuis un repo projet", true, "git push origin feat/x:main", proj);
expect("suppression de main distante (refspec :main)", true, "git push origin :main", proj);
expect("cd vers un repo projet + push main (session ailleurs)", true, `cd "${proj}" && git push origin main`, meta);
expect("git -C repo projet push main (session ailleurs)", true, `git -C "${proj}" push origin main`, meta);
expect("push HEAD:main depuis un worktree de repo projet", true, "git push origin HEAD:main", wtProj);

// --- faux positifs du 2026-07-13 : doivent passer ---
expect("cd vers le repo méta + push HEAD (session dans un repo projet)", false, `cd "${meta}" && git push origin HEAD`, proj);
expect("cd vers le repo méta + push main explicite", false, `cd "${meta}" && git push origin main`, proj);
expect("git -C repo méta push main", false, `git -C "${meta}" push origin main`, proj);
expect(
  "« main » en prose après le push (gh pr close --comment)",
  false,
  `git push -u origin feat/x && gh pr close 7 --comment "obsolète : rebasée sur main à jour"`,
  proj
);
expect(
  "« main » en prose avant le push",
  false,
  `gh pr close 7 --comment "rebasée sur main à jour" && git push -u origin feat/x`,
  proj
);
expect("push HEAD:main depuis un worktree du repo méta", false, "git push origin HEAD:main", wtMeta);

// --- faux positif du 2026-07-17 : checkout -b en amont du push (HEAD lu avant exécution) ---
// proj est remis sur main : c'est le cas réel (session sur le tronc, la commande crée sa
// branche avant de pousser) — sans le correctif, HEAD (lu avant exécution) rend encore main.
checkout(proj, "main");
expect(
  "checkout -b <branche> puis push nu de cette branche",
  false,
  "git checkout -b chore/x && git commit -q --allow-empty -m x && git push -u origin chore/x",
  proj
);
expect(
  "switch -c <branche> puis push nu de cette branche",
  false,
  "git switch -c chore/y && git push -u origin chore/y",
  proj
);
checkout(proj, "feat/x");

// --- non-régression ---
expect("push d'une branche feature depuis un repo projet", false, "git push -u origin feat/x", proj);
expect(
  "checkout -b <branche> puis push explicite vers master (doit rester bloqué)",
  true,
  "git checkout -b chore/x && git push origin master",
  proj
);
expect("secret (token GitHub) dans la commande", true, `git commit -m "${fakeToken}"`, proj);
expect("commande sans git ni secret", false, "echo la main dans le sac", proj);

rmSync(root, { recursive: true, force: true });
console.log(failures ? `\n${failures} échec(s).` : "\nTout passe.");
process.exit(failures ? 1 : 0);
