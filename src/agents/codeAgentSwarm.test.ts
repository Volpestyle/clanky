import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  applySwarmLauncherFirstTurnPreamble,
  buildSwarmLabel,
  buildSwarmLauncherFirstTurnPreamble,
  resolveCodeAgentSwarmRuntimeConfig
} from "./codeAgentSwarm.ts";

test("resolveCodeAgentSwarmRuntimeConfig returns null when swarm is disabled", () => {
  assert.equal(resolveCodeAgentSwarmRuntimeConfig({ enabled: false }), null);
  assert.equal(resolveCodeAgentSwarmRuntimeConfig(null), null);
});

test("resolveCodeAgentSwarmRuntimeConfig defaults direct child fallback off", () => {
  assert.deepEqual(resolveCodeAgentSwarmRuntimeConfig({
    enabled: true,
    serverName: "swarm",
    command: "bun",
    args: [],
    dbPath: ""
  }), {
    enabled: true,
    serverName: "swarm",
    command: "bun",
    args: [],
    dbPath: "",
    appendCoordinationPrompt: true,
    allowDirectChildFallback: false
  });
});

test("buildSwarmLabel emits stable role, thread, and user tokens", () => {
  assert.equal(
    buildSwarmLabel({
      provider: "codex-cli",
      role: "implementation",
      thread: " Channel 42! ",
      user: "VolpeStyle@Discord"
    }),
    "origin:clanky provider:codex-cli role:implementer thread:channel-42 user:volpestyle-discord"
  );
});

test("buildSwarmLabel falls back to dm/anon and omits blank role", () => {
  assert.equal(
    buildSwarmLabel({
      provider: "claude-code",
      role: null,
      thread: "   ",
      user: undefined
    }),
    "origin:clanky provider:claude-code thread:dm user:anon"
  );
});

test("applySwarmLauncherFirstTurnPreamble preserves the task body", () => {
  const combined = applySwarmLauncherFirstTurnPreamble("Fix the failing tests.", "Use swarm first.");
  assert.equal(combined, "Use swarm first.\n\nTask:\nFix the failing tests.");
});

test("buildSwarmLauncherFirstTurnPreamble emits the unified overlay block with annotate-based usage", () => {
  const preamble = buildSwarmLauncherFirstTurnPreamble({
    serverName: "swarm",
    taskId: "task-abc"
  });
  assert.match(preamble, /auto-adopted you on boot/);
  assert.match(preamble, /Your assigned task is `task-abc`/);
  assert.match(preamble, /override any conflicting generic skill guidance/);
  assert.match(preamble, /Do not call `register`/);
  assert.match(preamble, /annotate\(file=<task_id>, kind="usage"/);
  assert.match(preamble, /not in `update_task\.metadata`/);
  assert.match(preamble, /plain text — not structured JSON/);
  assert.match(preamble, /Do not commit, push, create pull requests/);
  // Single-mode listen-window stanza replaces the old inbox-loop branch.
  assert.match(preamble, /Follow-up listen window/);
  assert.match(preamble, /wait_for_activity/);
  assert.match(preamble, /send_message/);
  assert.match(preamble, /If no follow-up arrives in the window/);
  assert.doesNotMatch(preamble, /Inbox-loop mode/);
});

test("buildSwarmLauncherFirstTurnPreamble does not duplicate SKILL-covered guidance in the overlays", () => {
  const preamble = buildSwarmLauncherFirstTurnPreamble({ taskId: "task-1" });
  // SKILL.md is the source of truth for these — preamble shouldn't repeat them.
  assert.doesNotMatch(preamble, /Use `claim_task` on it before starting work/);
  assert.doesNotMatch(preamble, /lock_file before editing shared files/);
});

test("buildSwarmLauncherFirstTurnPreamble omits the task-id line when none is provided", () => {
  const preamble = buildSwarmLauncherFirstTurnPreamble();
  assert.match(preamble, /No task is pre-assigned/);
  assert.doesNotMatch(preamble, /Your assigned task is/);
});

test("buildSwarmLauncherFirstTurnPreamble appends the role coordination skill when provided", () => {
  const skillBody = "---\nname: swarm-implementer\n---\n\n# Swarm Implementer\n\nDo work.";
  const preamble = buildSwarmLauncherFirstTurnPreamble({
    taskId: "task-1",
    coordinationSkill: skillBody
  });
  assert.match(preamble, /## Swarm coordination skill/);
  assert.match(preamble, /name: swarm-implementer/);
  assert.match(preamble, /Do work\./);
});

test("buildSwarmLauncherFirstTurnPreamble omits the skill block when skill content is empty", () => {
  const preamble = buildSwarmLauncherFirstTurnPreamble({
    taskId: "task-1",
    coordinationSkill: ""
  });
  assert.doesNotMatch(preamble, /Swarm coordination skill/);
});

test("buildSwarmLauncherFirstTurnPreamble emits a discovery directive when skillReachableAt is set", () => {
  const preamble = buildSwarmLauncherFirstTurnPreamble({
    taskId: "task-1",
    coordinationSkill: "",
    skillReachableAt: "/Users/me/.agents/skills/swarm-mcp"
  });
  // Discovery directive points the harness at the on-disk skill.
  assert.match(preamble, /Coordination playbook/);
  assert.match(preamble, /\/Users\/me\/\.agents\/skills\/swarm-mcp/);
  assert.match(preamble, /Load it on your first turn/);
  // Full skill text is NOT inlined — that's the whole point of discovery.
  assert.doesNotMatch(preamble, /## Swarm coordination skill/);
});

test("buildSwarmLauncherFirstTurnPreamble prefers inlined skill over discovery directive when both are provided", () => {
  // Defensive: if a caller (e.g. a test, or a future bug) passes both, the
  // inlined fallback wins so the worker is never left without the playbook.
  const preamble = buildSwarmLauncherFirstTurnPreamble({
    taskId: "task-1",
    coordinationSkill: "FALLBACK SKILL CONTENT",
    skillReachableAt: "/some/path"
  });
  assert.match(preamble, /## Swarm coordination skill/);
  assert.match(preamble, /FALLBACK SKILL CONTENT/);
  assert.doesNotMatch(preamble, /Coordination playbook/);
});
