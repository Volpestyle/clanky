import { test } from "bun:test";
import assert from "node:assert/strict";
import type OpenAI from "openai";
import type { BrowserManager } from "../services/BrowserManager.ts";
import { runOpenAiComputerUseTask } from "./openAiComputerUseRuntime.ts";

test("runOpenAiComputerUseTask uses the GA computer tool and executes batched actions", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const browserCalls: string[] = [];
  const logs: Array<Record<string, unknown>> = [];

  const openai = {
    async post(_path: string, opts?: { body?: Record<string, unknown> }) {
      const body = opts?.body || {};
      requests.push(body);

      if (requests.length === 1) {
        return {
          id: "resp_1",
          output: [{
            id: "comp_1",
            call_id: "call_1",
            type: "computer_call",
            pending_safety_checks: [],
            actions: [
              { type: "move", x: 11, y: 22 },
              { type: "scroll", x: 11, y: 22, scroll_y: 300, scroll_x: 0 },
              { type: "drag", path: [{ x: 20, y: 30 }, { x: 40, y: 50 }] },
              { type: "keypress", keys: ["cmd", "a"] },
              { type: "type", text: "hello" },
              { type: "screenshot" }
            ]
          }],
          usage: {
            input_tokens: 100,
            output_tokens: 25,
            input_tokens_details: { cached_tokens: 0 }
          }
        };
      }

      return {
        id: "resp_2",
        output_text: "Done browsing.",
        output: [],
        usage: {
          input_tokens: 20,
          output_tokens: 10,
          input_tokens_details: { cached_tokens: 0 }
        }
      };
    }
  } as OpenAI;

  const browserManager = {
    async open(_sessionKey: string, url: string) {
      browserCalls.push(`open:${url}`);
      return "ok";
    },
    async screenshot() {
      browserCalls.push("screenshot");
      return "data:image/png;base64,c2NyZWVu";
    },
    async currentUrl() {
      browserCalls.push("currentUrl");
      return "https://example.com/current";
    },
    async mouseMove(_sessionKey: string, x: number, y: number) {
      browserCalls.push(`move:${x},${y}`);
      return "ok";
    },
    async mouseWheel(_sessionKey: string, deltaY: number, deltaX: number) {
      browserCalls.push(`wheel:${deltaY},${deltaX}`);
      return "ok";
    },
    async mouseDrag(_sessionKey: string, path: Array<{ x: number; y: number }>) {
      browserCalls.push(`drag:${path.map((point) => `${point.x},${point.y}`).join("->")}`);
      return "ok";
    },
    async press(_sessionKey: string, shortcut: string) {
      browserCalls.push(`press:${shortcut}`);
      return "ok";
    },
    async keyboardType(_sessionKey: string, text: string) {
      browserCalls.push(`type:${text}`);
      return "ok";
    },
    async wait() {
      browserCalls.push("wait");
      return "ok";
    },
    async mouseClick() {
      browserCalls.push("click");
      return "ok";
    },
    async mouseDoubleClick() {
      browserCalls.push("double_click");
      return "ok";
    },
    async close() {
      browserCalls.push("close");
    }
  } as BrowserManager;

  const result = await runOpenAiComputerUseTask({
    openai,
    browserManager,
    store: {
      logAction(entry) {
        logs.push(entry);
      }
    },
    sessionKey: "session-1",
    instruction: "Go inspect https://example.com and tell me what changed.",
    maxSteps: 3,
    stepTimeoutMs: 5_000,
    trace: {
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "user-1",
      source: "test"
    }
  });

  assert.equal(result.text, "Done browsing.");
  assert.equal(result.steps, 1);
  assert.equal(result.hitStepLimit, false);

  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.model, "gpt-5.4");
  assert.deepEqual(requests[0]?.tools, [{
    type: "computer",
    display_width: 1024,
    display_height: 768,
    environment: "browser"
  }]);
  assert.equal(
    ((requests[0]?.input as Array<{ content: Array<{ type: string; detail?: string }> }>)[0]?.content?.[1]?.detail),
    "original"
  );
  assert.equal(requests[1]?.previous_response_id, "resp_1");
  assert.equal(((requests[1]?.input as Array<{ type: string }>)[0]?.type), "computer_call_output");
  assert.equal(
    ((requests[1]?.input as Array<{ output: { type: string } }>)[0]?.output?.type),
    "computer_screenshot"
  );

  assert.deepEqual(browserCalls, [
    "open:https://example.com",
    "screenshot",
    "currentUrl",
    "move:11,22",
    "move:11,22",
    "wheel:300,0",
    "drag:20,30->40,50",
    "press:Meta+A",
    "type:hello",
    "screenshot",
    "currentUrl",
    "close"
  ]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.usdCost, 0.0005);
});

test("runOpenAiComputerUseTask surfaces pending safety checks", async () => {
  const openai = {
    async post() {
      return {
        id: "resp_1",
        output: [{
          id: "comp_1",
          call_id: "call_1",
          type: "computer_call",
          pending_safety_checks: [{ id: "check_1", code: "confirm", message: "Please confirm." }],
          actions: []
        }],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          input_tokens_details: { cached_tokens: 0 }
        }
      };
    }
  } as OpenAI;

  let closed = false;
  const browserManager = {
    async open() {
      return "ok";
    },
    async screenshot() {
      return "data:image/png;base64,c2NyZWVu";
    },
    async currentUrl() {
      return "https://example.com/current";
    },
    async close() {
      closed = true;
    }
  } as BrowserManager;

  await assert.rejects(
    runOpenAiComputerUseTask({
      openai,
      browserManager,
      store: {
        logAction() {}
      },
      sessionKey: "session-1",
      instruction: "Inspect https://example.com",
      maxSteps: 1,
      stepTimeoutMs: 5_000,
      trace: {}
    }),
    /computer_use_safety_check_required:confirm/
  );

  assert.equal(closed, true);
});
