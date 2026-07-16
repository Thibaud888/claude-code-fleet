#!/usr/bin/env node
// Hook PostToolUse (Edit|Write) : vérification déterministe à 0 token.
// Lance le check rapide du projet touché et n'injecte QUE les échecs dans le contexte
// (exit 2 + stderr). Silencieux si rien n'est configuré ou si tout passe.
//
// Opt-in par repo :
//   - Node   : script npm "claude:check" dans package.json (ex: "eslint . && vitest run")
//   - Python : ruff configuré (ruff.toml ou [tool.ruff] dans pyproject.toml) → check du fichier édité
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, parse } from "node:path";

const SKIP_EXT = new Set([".md", ".txt", ".json", ".yml", ".yaml", ".csv", ".svg", ".html", ".css", ".lock"]);

let input = "";
try {
  input = readFileSync(0, "utf8");
} catch {
  process.exit(0);
}

let filePath;
try {
  filePath = JSON.parse(input)?.tool_input?.file_path;
} catch {
  process.exit(0);
}
if (!filePath || SKIP_EXT.has(extname(filePath).toLowerCase())) process.exit(0);

// Racine du projet : remonte jusqu'à package.json / pyproject.toml / .git
let root = dirname(filePath);
while (true) {
  if (["package.json", "pyproject.toml", ".git"].some((f) => existsSync(join(root, f)))) break;
  const up = dirname(root);
  if (up === root || root === parse(root).root) process.exit(0);
  root = up;
}

const fail = (label, out) => {
  const tail = out.split("\n").slice(-30).join("\n");
  process.stderr.write(`[hook check] ${label} en échec :\n${tail}\n`);
  process.exit(2);
};

try {
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (pkg.scripts?.["claude:check"]) {
      try {
        execSync("npm run claude:check", { cwd: root, timeout: 90_000, stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        fail("npm run claude:check", `${e.stdout ?? ""}${e.stderr ?? ""}`);
      }
    }
    process.exit(0);
  }

  if (extname(filePath).toLowerCase() === ".py") {
    const hasRuff =
      existsSync(join(root, "ruff.toml")) ||
      (existsSync(join(root, "pyproject.toml")) &&
        readFileSync(join(root, "pyproject.toml"), "utf8").includes("[tool.ruff]"));
    if (hasRuff) {
      try {
        execSync(`python -m ruff check "${filePath}"`, { cwd: root, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
        // ruff non installé sur la machine → fail-open (seules les VRAIES violations bloquent)
        if (out.includes("No module named")) process.exit(0);
        fail("ruff", out);
      }
    }
  }
} catch {
  // fail-open : un hook cassé ne doit jamais bloquer une session
}
process.exit(0);
