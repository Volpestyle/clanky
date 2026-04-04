import { test } from "bun:test";
import assert from "node:assert/strict";
import { MinecraftRuntime } from "./minecraftRuntime.ts";

test("MinecraftRuntime forwards caller abort signals to MCP tool fetches", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      if (!signal) {
        reject(new Error("missing signal"));
        return;
      }
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as typeof fetch;

  try {
    const runtime = new MinecraftRuntime("http://minecraft.test");
    const controller = new AbortController();
    const statusPromise = runtime.status(controller.signal);
    controller.abort(new Error("session cancelled"));

    await assert.rejects(statusPromise, /session cancelled/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
