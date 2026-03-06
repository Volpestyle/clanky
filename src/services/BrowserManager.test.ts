import { test } from "bun:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { BrowserManager, buildAgentBrowserArgs } from "./BrowserManager.ts";

test("buildAgentBrowserArgs prefixes the agent-browser session flag", () => {
  assert.deepEqual(
    buildAgentBrowserArgs("session-1", ["open", "https://example.com"]),
    ["--session", "session-1", "open", "https://example.com"]
  );
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
