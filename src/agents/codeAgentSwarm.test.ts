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

test("buildSwarmLauncherFirstTurnPreamble defaults to one-shot and reports usage via annotate", () => {
  const preamble = buildSwarmLauncherFirstTurnPreamble({
    serverName: "swarm",
    taskId: "task-abc"
  });
  assert.match(preamble, /auto-adopted you on boot/);
  assert.match(preamble, /Your task is reserved as id `task-abc`/);
  assert.match(preamble, /annotate\(file=<task_id>, kind="usage"/);
  assert.match(preamble, /Do not pack usage into `update_task\.metadata`/);
  assert.doesNotMatch(preamble, /Inbox-loop mode/);
});

test("buildSwarmLauncherFirstTurnPreamble appends inbox-loop instructions when requested", () => {
  const preamble = buildSwarmLauncherFirstTurnPreamble({
    taskId: "task-xyz",
    workerMode: "inbox_loop"
  });
  assert.match(preamble, /Inbox-loop mode/);
  assert.match(preamble, /do not exit/);
  assert.match(preamble, /wait_for_activity/);
  assert.match(preamble, /send_message/);
});

test("buildSwarmLauncherFirstTurnPreamble omits the task-id line when none is provided", () => {
  const preamble = buildSwarmLauncherFirstTurnPreamble();
  assert.match(preamble, /Read the task below and execute it directly/);
  assert.doesNotMatch(preamble, /reserved as id/);
});

test("buildSwarmLauncherFirstTurnPreamble appends the role coordination skill when provided", () => {
  const skillBody = "---\nname: swarm-implementer\n---\n\n# Swarm Implementer\n\nDo work.";
  const preamble = buildSwarmLauncherFirstTurnPreamble({
    taskId: "task-1",
    coordinationSkill: skillBody
  });
  assert.match(preamble, /## Swarm coordination skill/);
  assert.match(preamble, /authoritative guidance/);
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
