import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  buildCodexCliBrainArgs,
  buildCodexCliCodeAgentArgs,
  buildCodexCliResumeArgs,
  createCodexCliStreamSession,
  parseCodexCliJsonlOutput
} from "../llm.ts";

test("buildCodexCliBrainArgs includes json ephemeral flags", () => {
  const args = buildCodexCliBrainArgs({ model: "gpt-5.4", prompt: "hello" });
  assert.deepEqual(args.slice(0, 8), [
    "exec",
    "--json",
    "--ephemeral",
    "-m",
    "gpt-5.4",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "hello"
  ]);
});

test("buildCodexCliCodeAgentArgs includes cwd and workspace sandbox", () => {
  const args = buildCodexCliCodeAgentArgs({ model: "gpt-5.4", cwd: "/tmp/project", instruction: "fix it" });
  assert.equal(args.includes("--json"), true);
  assert.equal(args.includes("-s"), true);
  assert.equal(args[args.indexOf("-s") + 1], "workspace-write");
  assert.equal(args.includes("-C"), true);
  assert.equal(args[args.indexOf("-C") + 1], "/tmp/project");
  assert.equal(args[args.length - 1], "fix it");
});

test("buildCodexCliResumeArgs includes resume thread id", () => {
  const args = buildCodexCliResumeArgs({ model: "gpt-5.4", threadId: "thread-123", prompt: "continue" });
  assert.deepEqual(args.slice(0, 7), ["exec", "resume", "thread-123", "--json", "-m", "gpt-5.4", "--skip-git-repo-check"]);
  assert.equal(args[args.length - 1], "continue");
});

test("parseCodexCliJsonlOutput collects message text usage and thread id", () => {
  const raw = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
    JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Hello" } }),
    JSON.stringify({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: "World" } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 3, output_tokens: 5 } })
  ].join("\n");

  const parsed = parseCodexCliJsonlOutput(raw);
  assert.ok(parsed);
  assert.equal(parsed.text, "Hello\nWorld");
  assert.equal(parsed.threadId, "thread-123");
  assert.equal(parsed.isError, false);
  assert.deepEqual(parsed.usage, {
    inputTokens: 10,
    outputTokens: 5,
    cacheWriteTokens: 0,
    cacheReadTokens: 3
  });
});

test("createCodexCliStreamSession exposes stream-like API", () => {
  const session = createCodexCliStreamSession({ model: "gpt-5.4", cwd: "/tmp/test" });
  assert.ok(session);
  assert.equal(typeof session.run, "function");
  assert.equal(typeof session.close, "function");
  assert.equal(typeof session.isIdle, "function");
  session.close();
});
