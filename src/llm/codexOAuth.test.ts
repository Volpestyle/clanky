import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createCodexOAuthFetch,
  normalizeCodexResponsesBodyForOAuth,
  type CodexOAuthTokens
} from "./codexOAuth.ts";

test("normalizeCodexResponsesBodyForOAuth enforces Codex-compatible body defaults", () => {
  const normalized = normalizeCodexResponsesBodyForOAuth({
    model: "gpt-5.4-mini",
    stream: true,
    temperature: 0.7,
    top_p: 0.9,
    reasoning: {
      effort: "minimal"
    },
    max_output_tokens: 800,
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]
  });

  assert.equal(normalized.model, "gpt-5.4-mini");
  assert.equal(normalized.stream, true);
  assert.equal(normalized.store, false);
  assert.equal(normalized.instructions, "");
  assert.equal(Object.prototype.hasOwnProperty.call(normalized, "max_output_tokens"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(normalized, "temperature"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(normalized, "top_p"), false);
  assert.deepEqual(normalized.reasoning, { effort: "low" });
});

test("createCodexOAuthFetch rewrites responses requests and injects codex headers", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      init: {
        method: init?.method,
        headers: init?.headers,
        body: init?.body
      }
    });
    return new Response("{}", {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    });
  };

  const tokens: CodexOAuthTokens = {
    refreshToken: "refresh-token",
    accessToken: "access-token",
    idToken: "",
    expiresAt: Date.now() + 60_000,
    accountId: "acct_123"
  };

  const oauthFetch = createCodexOAuthFetch({
    getTokens: () => tokens,
    setTokens() {},
    fetchImpl: mockFetch
  });

  await oauthFetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-5.4-mini",
      stream: true,
      max_output_tokens: 500,
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]
    })
  });

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, "https://chatgpt.com/backend-api/codex/responses");

  const headers = new Headers(call.init.headers);
  assert.equal(headers.get("authorization"), "Bearer access-token");
  assert.equal(headers.get("chatgpt-account-id"), "acct_123");
  assert.equal(headers.get("openai-beta"), "responses=experimental");

  const normalizedBody = JSON.parse(String(call.init.body || "{}")) as Record<string, unknown>;
  assert.equal(normalizedBody.store, false);
  assert.equal(normalizedBody.instructions, "");
  assert.equal(Object.prototype.hasOwnProperty.call(normalizedBody, "max_output_tokens"), false);
});

test("createCodexOAuthFetch forces stream for non-stream responses and returns JSON", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      init: {
        method: init?.method,
        headers: init?.headers,
        body: init?.body
      }
    });

    const sse = [
      "event: response.created",
      'data: {"response":{"id":"resp_1","status":"in_progress"}}',
      "",
      "event: response.completed",
      'data: {"response":{"id":"resp_1","status":"completed","output_text":"done"}}',
      ""
    ].join("\n");

    return new Response(sse, {
      status: 200,
      headers: {
        "content-type": "text/event-stream"
      }
    });
  };

  const tokens: CodexOAuthTokens = {
    refreshToken: "refresh-token",
    accessToken: "access-token",
    idToken: "",
    expiresAt: Date.now() + 60_000,
    accountId: "acct_123"
  };

  const oauthFetch = createCodexOAuthFetch({
    getTokens: () => tokens,
    setTokens() {},
    fetchImpl: mockFetch
  });

  const response = await oauthFetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-5.4-mini",
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]
    })
  });

  assert.equal(calls.length, 1);
  const sentBody = JSON.parse(String(calls[0]?.init?.body || "{}")) as Record<string, unknown>;
  assert.equal(sentBody.stream, true);

  assert.equal(response.headers.get("content-type"), "application/json");
  const json = await response.json() as Record<string, unknown>;
  assert.equal(json.status, "completed");
  assert.equal(json.output_text, "done");
});
