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

const mkRepo = (name, tronc = "main") => {
  const dir = join(root, name);
  sh(`git init -q -b ${tronc} "${dir}"`);
  sh(`git -C "${dir}" -c user.email=guard@test -c user.name=guard commit -q --allow-empty -m init`);
  return dir;
};

// « fleetview » joue le repo projet (règle branche + PR), « claude-ops » le repo méta.
// « site-demo » joue un repo projet dont le tronc s'appelle `master` (cas réel du 5e faux
// positif : c'est le nom de la branche courante qui déclenchait la garde).
const proj = mkRepo("fleetview");
const meta = mkRepo("claude-ops");
const projMaster = mkRepo("site-demo", "master");
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

// --- faux positif n° 4 du 2026-07-31 : supprimer une branche distante depuis le tronc ---
// `git push origin --delete <branche>` ne publie rien ; la garde concluait pourtant sur HEAD
// (= main) et refusait le rangement des branches mortes (contourné à l'époque par gh api).
checkout(proj, "main");
expect("suppression d'une branche distante depuis main", false, "git push origin --delete chore/vieille", proj);
expect("suppression courte (-d) d'une branche distante depuis main", false, "git push origin -d chore/vieille", proj);
expect("suppression par refspec ancienne (:branche) depuis main", false, "git push origin :chore/vieille", proj);
expect(
  "plusieurs suppressions enchaînées depuis main",
  false,
  "git push origin --delete chore/a && git push origin --delete chore/b",
  proj
);
// Contrôle positif du même geste : supprimer le TRONC distant doit rester bloqué.
expect("suppression de main distante (--delete main)", true, "git push origin --delete main", proj);
expect("suppression de master distante (--delete master)", true, "git push origin --delete master", proj);
expect("suppression de main distante (-d main)", true, "git push origin -d main", proj);
expect(
  "suppression légitime PUIS vrai push nu depuis main",
  true,
  "git push origin --delete chore/a && git push",
  proj
);

// --- faux positif n° 5 du 2026-07-31 : « git push » en PROSE, depuis une branche `master` ---
// Une commande qui n'invoque aucun git (heredoc, message de commit) était refusée dès lors
// qu'elle contenait les mots « git … push » ET que la branche courante s'appelait main/master.
expect(
  "heredoc contenant « git push » dans un commentaire de code (branche master)",
  false,
  "cat > /tmp/x.mjs <<'EOF'\n// le hook guard.mjs interdit `git push` sur master\nconsole.log(1);\nEOF\nnode /tmp/x.mjs",
  projMaster
);
expect(
  "message de commit citant « git push origin main » (branche master)",
  false,
  `git commit -m "doc : rappeler que git push origin main est interdit"`,
  projMaster
);
expect(
  "prose « git push » sans aucune commande git (branche master)",
  false,
  `gh issue comment 7 --body "le hook a refusé mon git push sur master"`,
  projMaster
);
// Contrôle positif du même geste : depuis ce même repo `master`, un VRAI push reste bloqué.
expect("push nu depuis le tronc master (contrôle positif)", true, "git push", projMaster);
expect("push explicite vers master (contrôle positif)", true, "git push origin master", projMaster);
expect(
  "heredoc en prose PUIS vrai push nu depuis master",
  true,
  "cat > /tmp/x.mjs <<'EOF'\n// git push sur master est interdit\nEOF\ngit push",
  projMaster
);

// --- non-régression ---
checkout(proj, "feat/x");
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
