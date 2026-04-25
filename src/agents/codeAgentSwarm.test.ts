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
    role: "implementation",
    thread: "1234567890",
    user: "9876543210"
  });
  if (!session) throw new Error("Expected swarm session config");
  assert.equal(session.serverName, "swarm-bus");
  assert.equal(session.scope, "C:\\repo");
  assert.equal(session.fileRoot, "C:\\repo\\packages\\app");
  assert.equal(
    session.label,
    "origin:clanky provider:codex-cli role:implementer thread:1234567890 user:9876543210"
  );
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
  assert.match(session.firstTurnPreamble, /role:planner/i);
  assert.match(session.firstTurnPreamble, /generalist/i);
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

  assert.equal(
    session.label,
    "origin:clanky provider:claude-code role:reviewer thread:dm user:anon"
  );
  assert.match(session.firstTurnPreamble, /shared checkout/i);
  assert.doesNotMatch(session.firstTurnPreamble, /disposable git worktree/i);
});

test("buildCodeAgentSwarmSessionConfig omits the role token when no role is provided", () => {
  const runtime = resolveCodeAgentSwarmRuntimeConfig({
    enabled: true,
    serverName: "swarm",
    command: "bun",
    args: ["run", "C:\\Users\\volpe\\swarm-mcp\\src\\index.ts"],
    appendCoordinationPrompt: false
  });
  if (!runtime) throw new Error("Expected swarm runtime config");

  const session = buildCodeAgentSwarmSessionConfig({
    runtime,
    workspace,
    provider: "codex-cli",
    role: null
  });
  if (!session) throw new Error("Expected swarm session config");

  assert.equal(session.label, "origin:clanky provider:codex-cli thread:dm user:anon");
});

test("buildCodeAgentSwarmSessionConfig sanitizes thread and user tokens", () => {
  const runtime = resolveCodeAgentSwarmRuntimeConfig({
    enabled: true,
    serverName: "swarm",
    command: "bun",
    args: ["run", "/tmp/swarm-mcp/src/index.ts"],
    appendCoordinationPrompt: false
  });
  if (!runtime) throw new Error("Expected swarm runtime config");

  const session = buildCodeAgentSwarmSessionConfig({
    runtime,
    workspace,
    provider: "claude-code",
    role: "implementation",
    thread: " Channel 42! ",
    user: "VolpeStyle@Discord"
  });
  if (!session) throw new Error("Expected swarm session config");

  assert.equal(
    session.label,
    "origin:clanky provider:claude-code role:implementer thread:channel-42 user:volpestyle-discord"
  );
});

test("buildCodeAgentSwarmSessionConfig falls back to dm/anon when thread/user are blank", () => {
  const runtime = resolveCodeAgentSwarmRuntimeConfig({
    enabled: true,
    serverName: "swarm",
    command: "bun",
    args: ["run", "/tmp/swarm-mcp/src/index.ts"],
    appendCoordinationPrompt: false
  });
  if (!runtime) throw new Error("Expected swarm runtime config");

  const session = buildCodeAgentSwarmSessionConfig({
    runtime,
    workspace,
    provider: "codex-cli",
    role: "research",
    thread: "   ",
    user: undefined
  });
  if (!session) throw new Error("Expected swarm session config");

  assert.equal(
    session.label,
    "origin:clanky provider:codex-cli role:researcher thread:dm user:anon"
  );
});

test("applyCodeAgentFirstTurnPreamble preserves the task body", () => {
  const combined = applyCodeAgentFirstTurnPreamble("Fix the failing tests.", "Use swarm first.");
  assert.equal(combined, "Use swarm first.\n\nTask:\nFix the failing tests.");
});
