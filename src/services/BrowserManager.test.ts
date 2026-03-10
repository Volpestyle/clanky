import { test } from "bun:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { BrowserManager, buildAgentBrowserArgs, buildAgentBrowserSessionName } from "./BrowserManager.ts";

test("buildAgentBrowserArgs prefixes the agent-browser session flag with a short deterministic session name", () => {
  assert.deepEqual(
    buildAgentBrowserArgs("session-1", ["open", "https://example.com"]),
    ["--session", buildAgentBrowserSessionName("session-1"), "open", "https://example.com"]
  );
});

test("buildAgentBrowserArgs forwards headed mode for visible browser sessions", () => {
  assert.deepEqual(
    buildAgentBrowserArgs("session-1", ["open", "https://example.com"], { headed: true }),
    ["--session", buildAgentBrowserSessionName("session-1"), "--headed", "open", "https://example.com"]
  );
});

test("buildAgentBrowserSessionName shortens long logical session keys for agent-browser socket limits", () => {
  const logicalSessionKey = "reply:browser:866430493889134672:866430493889134675:1773135046681:1";
  const normalized = buildAgentBrowserSessionName(logicalSessionKey);

  assert.notEqual(normalized, logicalSessionKey);
  assert.ok(normalized.length <= 32);
  assert.match(normalized, /^ab-[a-f0-9]{16}(?:-[a-z0-9-]+)?$/);
  assert.equal(buildAgentBrowserSessionName(logicalSessionKey), normalized);
});

test("BrowserManager uses CLI commands that match agent-browser and forwards timeout", async () => {
  const manager = new BrowserManager();
  const calls: Array<{ sessionKey: string; args: string[]; timeoutMs: number }> = [];

  Reflect.set(
    manager,
    "runAgentBrowser",
    async (sessionKey: string, args: string[], timeoutMs = 0) => {
      calls.push({ sessionKey, args, timeoutMs });
      return { stdout: "ok", stderr: "" };
    }
  );

  await manager.type("session-1", "@e2", "hello", true, 4_321);
  await manager.scroll("session-1", "down", 800, 1_234);

  assert.deepEqual(calls, [
    { sessionKey: "session-1", args: ["type", "@e2", "hello"], timeoutMs: 4_321 },
    { sessionKey: "session-1", args: ["press", "Enter"], timeoutMs: 4_321 },
    { sessionKey: "session-1", args: ["scroll", "down", "800"], timeoutMs: 1_234 }
  ]);

  clearInterval(Reflect.get(manager, "staleTimer") as ReturnType<typeof setInterval>);
});

test("BrowserManager screenshot returns a base64 data URL", async () => {
  const manager = new BrowserManager();

  Reflect.set(
    manager,
    "runAgentBrowser",
    async (_sessionKey: string, args: string[]) => {
      const screenshotPath = args[1];
      await writeFile(screenshotPath, Buffer.from("png-bytes"));
      return { stdout: "", stderr: "" };
    }
  );

  const result = await manager.screenshot("session-1", 2_500);

  assert.ok(result.startsWith("data:image/png;base64,"));

  clearInterval(Reflect.get(manager, "staleTimer") as ReturnType<typeof setInterval>);
});

test("BrowserManager mouseDrag uses mouse down, move, and up", async () => {
  const manager = new BrowserManager();
  const calls: Array<{ sessionKey: string; args: string[]; timeoutMs: number }> = [];

  Reflect.set(
    manager,
    "runAgentBrowser",
    async (sessionKey: string, args: string[], timeoutMs = 0) => {
      calls.push({ sessionKey, args, timeoutMs });
      return { stdout: "ok", stderr: "" };
    }
  );

  await manager.mouseDrag("session-1", [{ x: 10, y: 20 }, { x: 30, y: 40 }, { x: 50, y: 60 }], 7_654);

  assert.deepEqual(calls, [
    { sessionKey: "session-1", args: ["mouse", "move", "10", "20"], timeoutMs: 7_654 },
    { sessionKey: "session-1", args: ["mouse", "down", "left"], timeoutMs: 7_654 },
    { sessionKey: "session-1", args: ["mouse", "move", "30", "40"], timeoutMs: 7_654 },
    { sessionKey: "session-1", args: ["mouse", "move", "50", "60"], timeoutMs: 7_654 },
    { sessionKey: "session-1", args: ["mouse", "up", "left"], timeoutMs: 7_654 }
  ]);

  clearInterval(Reflect.get(manager, "staleTimer") as ReturnType<typeof setInterval>);
});

test("BrowserManager applies configured per-session timeouts during stale cleanup", async () => {
  const manager = new BrowserManager({ sessionTimeoutMs: 60_000 });
  const calls: Array<{ sessionKey: string; args: string[] }> = [];

  Reflect.set(
    manager,
    "runAgentBrowser",
    async (sessionKey: string, args: string[]) => {
      calls.push({ sessionKey, args });
      return { stdout: "ok", stderr: "" };
    }
  );

  manager.configureSession("session-1", { sessionTimeoutMs: 5_000, headed: true });
  await manager.open("session-1", "https://example.com", 2_500);

  const sessions = Reflect.get(manager, "sessions") as Map<
    string,
    { lastActiveAt: number }
  >;
  const session = sessions.get("session-1");
  if (!session) {
    throw new Error("expected browser session to exist");
  }
  session.lastActiveAt = Date.now() - 10_000;

  const cleanupStaleSessions = Reflect.get(manager, "cleanupStaleSessions") as () => void;
  cleanupStaleSessions.call(manager);

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calls, [
    { sessionKey: "session-1", args: ["open", "https://example.com"] },
    { sessionKey: "session-1", args: ["close"] }
  ]);
  assert.equal(sessions.has("session-1"), false);

  clearInterval(Reflect.get(manager, "staleTimer") as ReturnType<typeof setInterval>);
});
