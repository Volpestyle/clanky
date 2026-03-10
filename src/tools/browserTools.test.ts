import { test } from "bun:test";
import assert from "node:assert/strict";
import type { BrowserManager } from "../services/BrowserManager.ts";
import { executeBrowserTool } from "./browserTools.ts";

test("executeBrowserTool delegates browser_screenshot with the step timeout", async () => {
  const calls: Array<{ sessionKey: string; timeoutMs: number | undefined }> = [];
  const browserManager = {
    async screenshot(sessionKey: string, timeoutMs?: number) {
      calls.push({ sessionKey, timeoutMs });
      return "data:image/png;base64,Zm9v";
    }
  } as BrowserManager;

  const result = await executeBrowserTool(
    browserManager,
    "session-1",
    "browser_screenshot",
    {},
    9_999
  );

  assert.equal(result.text, "Browser screenshot captured and attached for visual inspection.");
  assert.deepEqual(result.imageInputs, [
    {
      mediaType: "image/png",
      dataBase64: "Zm9v"
    }
  ]);
  assert.deepEqual(calls, [{ sessionKey: "session-1", timeoutMs: 9_999 }]);
});
