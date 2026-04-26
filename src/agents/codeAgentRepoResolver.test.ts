import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createTestSettings } from "../testSettings.ts";
import {
  assertCodeAgentCwdAllowed,
  parseGitHubRepoRef,
  resolveGitHubRepoCwdForCodeTask
} from "./codeAgentRepoResolver.ts";

function makeSettings(root: string) {
  return createTestSettings({
    permissions: {
      devTasks: {
        allowedUserIds: ["user-1"],
        allowedWorkspaceRoots: [root]
      }
    }
  });
}

function initRepo(dir: string, remoteUrl: string) {
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "--quiet"], { cwd: dir });
  spawnSync("git", ["remote", "add", "origin", remoteUrl], { cwd: dir });
}

async function withTempWorkspace(run: (root: string) => Promise<void>) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "clanky-repo-resolver-"));
  try {
    await run(tempDir);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test("parseGitHubRepoRef extracts owner and repo from issue URLs and remotes", () => {
  expect(parseGitHubRepoRef("https://github.com/Volpestyle/clanky/issues/25")?.canonical).toBe("volpestyle/clanky");
  expect(parseGitHubRepoRef("git@github.com:Volpestyle/swarm-mcp.git")?.canonical).toBe("volpestyle/swarm-mcp");
});

test("resolveGitHubRepoCwdForCodeTask finds a local clone under allowed roots", async () => {
  await withTempWorkspace(async (root) => {
    const repoDir = path.join(root, "nested", "clanky");
    initRepo(repoDir, "https://github.com/Volpestyle/clanky.git");

    const resolution = resolveGitHubRepoCwdForCodeTask({
      settings: makeSettings(root),
      task: "Fix https://github.com/Volpestyle/clanky/issues/25"
    });

    expect(resolution?.cwd).toBe(realpathSync(repoDir));
    expect(resolution?.githubRepo).toBe("volpestyle/clanky");
  });
});

test("assertCodeAgentCwdAllowed rejects directories outside approved roots", async () => {
  await withTempWorkspace(async (root) => {
    const allowedRepo = path.join(root, "allowed");
    const outsideRoot = mkdtempSync(path.join(tmpdir(), "clanky-outside-repo-"));
    try {
      initRepo(allowedRepo, "https://github.com/Volpestyle/allowed.git");
      initRepo(outsideRoot, "https://github.com/Volpestyle/outside.git");

      expect(assertCodeAgentCwdAllowed(makeSettings(root), allowedRepo)).toBe(realpathSync(allowedRepo));
      expect(() => assertCodeAgentCwdAllowed(makeSettings(root), outsideRoot)).toThrow(
        "outside allowed coding workspace roots"
      );
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });
});
