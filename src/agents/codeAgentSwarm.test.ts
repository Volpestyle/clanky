import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  applyCodeAgentFirstTurnPreamble,
  buildCodeAgentSwarmSessionConfig,
  resolveCodeAgentSwarmRuntimeConfig
} from "./codeAgentSwarm.ts";
import type { CodeAgentWorkspaceLease } from "./codeAgentWorkspace.ts";

const workspace: CodeAgentWorkspaceLease = {
  mode: "isolated_worktree",
  repoRoot: "C:\\repo",
  worktreePath: "C:\\temp\\worktree-123",
  cwd: "C:\\temp\\worktree-123\\packages\\app",
  canonicalCwd: "C:\\repo\\packages\\app",
  relativeCwd: "packages\\app",
  branch: "clanker/codex-cli/test",
  baseRef: "main",
  cleanup() {}
};

test("resolveCodeAgentSwarmRuntimeConfig returns null when swarm is disabled", () => {
  assert.equal(resolveCodeAgentSwarmRuntimeConfig({ enabled: false }), null);
  assert.equal(resolveCodeAgentSwarmRuntimeConfig(null), null);
});

test("buildCodeAgentSwarmSessionConfig creates stable canonical registration info", () => {
  const runtime = resolveCodeAgentSwarmRuntimeConfig({
    enabled: true,
    serverName: "Swarm Bus",
    command: "bun",
    args: ["run", "C:\\Users\\volpe\\swarm-mcp\\src\\index.ts"],
    dbPath: "C:\\shared\\swarm.db",
    appendCoordinationPrompt: true
  });
  if (!runtime) throw new Error("Expected swarm runtime config");

  const session = buildCodeAgentSwarmSessionConfig({
    runtime,
    workspace,
    provider: "codex-cli",
    role: "implementation"
  });
  if (!session) throw new Error("Expected swarm session config");
  assert.equal(session.serverName, "swarm-bus");
  assert.equal(session.scope, "C:\\repo");
  assert.equal(session.fileRoot, "C:\\repo\\packages\\app");
  assert.deepEqual(session.env, {
    SWARM_DB_PATH: "C:\\shared\\swarm.db"
  });
  assert.equal(
    session.codexConfigOverrides[0],
    "mcp_servers.swarm-bus.command='bun'"
  );
  assert.equal(
    session.codexConfigOverrides[1],
    "mcp_servers.swarm-bus.args=['run', 'C:\\Users\\volpe\\swarm-mcp\\src\\index.ts']"
  );
  assert.equal(
    session.claudeMcpConfig,
    JSON.stringify({
      "swarm-bus": {
        type: "stdio",
        command: "bun",
        args: ["run", "C:\\Users\\volpe\\swarm-mcp\\src\\index.ts"],
        env: {
          SWARM_DB_PATH: "C:\\shared\\swarm.db"
        }
      }
    })
  );
  assert.match(session.firstTurnPreamble, /"file_root": "C:\\\\repo\\\\packages\\\\app"/);
  assert.match(session.firstTurnPreamble, /disposable git worktree/i);
});

test("buildCodeAgentSwarmSessionConfig describes shared checkout sessions directly", () => {
  const runtime = resolveCodeAgentSwarmRuntimeConfig({
    enabled: true,
    serverName: "swarm",
    command: "bun",
    args: ["run", "C:\\Users\\volpe\\swarm-mcp\\src\\index.ts"],
    appendCoordinationPrompt: true
  });
  if (!runtime) throw new Error("Expected swarm runtime config");

  const sharedWorkspace: CodeAgentWorkspaceLease = {
    mode: "shared_checkout",
    repoRoot: "C:\\repo",
    cwd: "C:\\repo\\packages\\app",
    canonicalCwd: "C:\\repo\\packages\\app",
    relativeCwd: "packages\\app",
    cleanup() {}
  };
  const session = buildCodeAgentSwarmSessionConfig({
    runtime,
    workspace: sharedWorkspace,
    provider: "claude-code",
    role: "review"
  });
  if (!session) throw new Error("Expected swarm session config");

  assert.match(session.firstTurnPreamble, /shared checkout/i);
  assert.doesNotMatch(session.firstTurnPreamble, /disposable git worktree/i);
});

test("applyCodeAgentFirstTurnPreamble preserves the task body", () => {
  const combined = applyCodeAgentFirstTurnPreamble("Fix the failing tests.", "Use swarm first.");
  assert.equal(combined, "Use swarm first.\n\nTask:\nFix the failing tests.");
});
