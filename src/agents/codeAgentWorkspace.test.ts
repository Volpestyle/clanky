import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { provisionCodeAgentWorkspace } from "./codeAgentWorkspace.ts";

function normalizePath(value: string) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function git(args: string[], cwd: string) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8"
  }).trim();
}

function createTempRepo() {
  const root = mkdtempSync(path.join(tmpdir(), "clanker-code-agent-worktree-test-"));
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

test("provisionCodeAgentWorkspace creates an isolated worktree rooted at the containing repo", () => {
  const fixture = createTempRepo();
  let workspace: ReturnType<typeof provisionCodeAgentWorkspace> | null = null;

  try {
    workspace = provisionCodeAgentWorkspace({
      cwd: fixture.nestedCwd,
      provider: "codex-cli",
      scopeKey: "guild:channel",
      mode: "isolated_worktree"
    });

    assert.equal(workspace.repoRoot, fixture.repoRoot);
    assert.equal(workspace.mode, "isolated_worktree");
    if (workspace.mode !== "isolated_worktree") {
      throw new Error("Expected isolated worktree workspace");
    }
    assert.equal(workspace.baseRef, "main");
    assert.ok(workspace.worktreePath !== fixture.repoRoot);
    assert.equal(workspace.cwd, path.join(workspace.worktreePath, "packages", "app"));
    assert.equal(workspace.canonicalCwd, fixture.nestedCwd);
    assert.equal(workspace.relativeCwd, path.join("packages", "app"));
    assert.ok(existsSync(path.join(workspace.cwd, "hello.txt")));

    writeFileSync(path.join(workspace.cwd, "hello.txt"), "worktree only\n", "utf8");
    assert.equal(readFileSync(path.join(fixture.nestedCwd, "hello.txt"), "utf8"), "live tree\n");

    const activeWorktrees = git(["worktree", "list", "--porcelain"], fixture.repoRoot);
    assert.ok(normalizePath(activeWorktrees).includes(normalizePath(workspace.worktreePath)));
  } finally {
    workspace?.cleanup();
    if (workspace?.mode === "isolated_worktree") {
      assert.equal(existsSync(workspace.worktreePath), false);
      assert.equal(git(["branch", "--list", workspace.branch], fixture.repoRoot), "");
    }
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("provisionCodeAgentWorkspace rejects non-git directories", () => {
  const root = mkdtempSync(path.join(tmpdir(), "clanker-code-agent-non-git-test-"));
  try {
    assert.throws(
      () =>
        provisionCodeAgentWorkspace({
          cwd: root,
          provider: "claude-code",
          scopeKey: "guild:channel",
          mode: "isolated_worktree"
        }),
      /not inside a git repo/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provisionCodeAgentWorkspace can reuse the shared checkout directly", () => {
  const fixture = createTempRepo();

  try {
    const workspace = provisionCodeAgentWorkspace({
      cwd: fixture.nestedCwd,
      provider: "claude-code",
      scopeKey: "guild:channel",
      mode: "shared_checkout"
    });

    assert.equal(workspace.mode, "shared_checkout");
    assert.equal(workspace.repoRoot, fixture.repoRoot);
    assert.equal(workspace.cwd, fixture.nestedCwd);
    assert.equal(workspace.canonicalCwd, fixture.nestedCwd);
    assert.equal(workspace.relativeCwd, path.join("packages", "app"));

    workspace.cleanup();
    assert.equal(existsSync(path.join(fixture.nestedCwd, "hello.txt")), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
