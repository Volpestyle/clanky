#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

const submodules = [
  { path: "mcp-servers/swarm-mcp", install: ["bun", "install"] }
];

for (const sub of submodules) {
  const dir = path.join(repoRoot, sub.path);
  if (!existsSync(path.join(dir, "package.json"))) {
    console.warn(
      `[install-submodule-deps] Skipping ${sub.path}: not initialized. Run \`git submodule update --init --recursive\` first.`
    );
    continue;
  }
  console.log(`[install-submodule-deps] Installing dependencies in ${sub.path}...`);
  const result = spawnSync(sub.install[0], sub.install.slice(1), {
    cwd: dir,
    stdio: "inherit"
  });
  if (result.status !== 0) {
    console.error(`[install-submodule-deps] ${sub.path} install failed (exit ${result.status}).`);
    process.exit(result.status ?? 1);
  }
}
