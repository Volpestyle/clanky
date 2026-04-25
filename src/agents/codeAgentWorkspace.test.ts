import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveCodeAgentWorkspace } from "./codeAgentWorkspace.ts";

function git(args: string[], cwd: string) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8"
  }).trim();
}

function createTempRepo() {
  const root = mkdtempSync(path.join(tmpdir(), "clanker-code-agent-workspace-test-"));
  const repoRoot = path.join(root, "repo");
  mkdirSync(repoRoot, { recursive: true });
  git(["init"], repoRoot);
  git(["checkout", "-b", "main"], repoRoot);
  git(["config", "user.name", "Clanker Tests"], repoRoot);
  git(["config", "user.email", "clanker-tests@example.com"], repoRoot);

  const nestedCwd = path.join(repoRoot, "packages", "app");
  mkdirSync(nestedCwd, { recursive: true });
  writeFileSync(path.join(nestedCwd, "hello.txt"), "live tree\n", "utf8");
  git(["add", "."], repoRoot);
  git(["commit", "-m", "Initial commit"], repoRoot);

  return {
    root,
    repoRoot: realpathSync(repoRoot),
    nestedCwd: realpathSync(nestedCwd)
  };
}

test("resolveCodeAgentWorkspace resolves the shared checkout repo context", () => {
  const fixture = createTempRepo();

  try {
    const workspace = resolveCodeAgentWorkspace({ cwd: fixture.nestedCwd });

    assert.equal(workspace.repoRoot, fixture.repoRoot);
    assert.equal(workspace.cwd, fixture.nestedCwd);
    assert.equal(workspace.canonicalCwd, fixture.nestedCwd);
    assert.equal(workspace.relativeCwd, path.join("packages", "app"));
    assert.equal(existsSync(path.join(fixture.nestedCwd, "hello.txt")), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("resolveCodeAgentWorkspace rejects non-git directories", () => {
  const root = mkdtempSync(path.join(tmpdir(), "clanker-code-agent-non-git-test-"));
  try {
    assert.throws(
      () => resolveCodeAgentWorkspace({ cwd: root }),
      /not inside a git repo/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
