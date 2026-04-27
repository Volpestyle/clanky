import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LLMService } from "../llm.ts";
import { rmTempDir } from "../testHelpers.ts";

function createService(appConfig = {}, { logs = null } = {}) {
  return new LLMService({
    appConfig: {
      openaiApiKey: "",
      xaiApiKey: "",
      xaiBaseUrl: "https://api.x.ai/v1",
      anthropicApiKey: "",
      defaultProvider: "openai",
      defaultOpenAiModel: "claude-haiku-4-5",
      defaultAnthropicModel: "claude-haiku-4-5",
      defaultXaiModel: "grok-3-mini-latest",
      defaultClaudeOAuthModel: "claude-sonnet-4-6",
      openaiOAuthRefreshToken: "",
      defaultOpenAiOAuthModel: "gpt-5.4",
      defaultCodexCliModel: "gpt-5.4",
      ...appConfig
    },
    store: {
      logAction(entry) {
        if (Array.isArray(logs)) logs.push(entry);
      }
    }
  });
}

test("resolveProviderAndModel throws when claude-oauth is selected but tokens are not configured", () => {
  const service = createService({ anthropicApiKey: "test-anthropic-key" });
  service.claudeOAuth = null;

  assert.throws(
    () => service.resolveProviderAndModel({ provider: "claude-oauth", model: "claude-sonnet-4-6" }),
    /claude-oauth.*no OAuth tokens/i
  );
});

test("resolveProviderAndModel keeps claude-oauth provider when configured", () => {
  const service = createService({ anthropicApiKey: "test-anthropic-key" });
  service.claudeOAuth = { tokens: { refreshToken: "test", accessToken: "", expiresAt: 0 }, client: {} } as never;

  const resolved = service.resolveProviderAndModel({ provider: "claude-oauth", model: "claude-sonnet-4-6" });
  assert.deepEqual(resolved, { provider: "claude-oauth", model: "claude-sonnet-4-6" });
});

test("resolveProviderAndModel throws when codex-cli is selected but CLI is unavailable", () => {
  const service = createService({ anthropicApiKey: "test-anthropic-key" });
  service.codexCliAvailable = false;

  assert.throws(
    () => service.resolveProviderAndModel({ provider: "codex-cli", model: "gpt-5.4" }),
    /codex-cli.*not available on PATH/i
  );
});

test("resolveProviderAndModel keeps codex_cli_session provider when CLI is available", () => {
  const service = createService({ anthropicApiKey: "test-anthropic-key" });
  service.codexCliAvailable = true;

  const resolved = service.resolveProviderAndModel({ provider: "codex_cli_session", model: "" });
  assert.deepEqual(resolved, { provider: "codex_cli_session", model: "gpt-5.4" });
});

test("resolveProviderAndModel throws when openai-oauth is selected but tokens are not configured", () => {
  const service = createService({ anthropicApiKey: "test-anthropic-key" });
  service.codexOAuth = null;

  assert.throws(
    () => service.resolveProviderAndModel({ provider: "openai-oauth", model: "gpt-5.4" }),
    /openai-oauth.*no OAuth tokens/i
  );
});

test("resolveProviderAndModel keeps openai-oauth provider when configured", () => {
  const service = createService({ anthropicApiKey: "test-anthropic-key" });
  service.codexOAuth = {
    tokens: { refreshToken: "test", accessToken: "", idToken: "", expiresAt: 0, accountId: "acct_123" },
    client: {}
  } as never;

  const resolved = service.resolveProviderAndModel({ provider: "openai-oauth", model: "gpt-5.4" });
  assert.deepEqual(resolved, { provider: "openai-oauth", model: "gpt-5.4" });
});

test("getComputerUseClient auto-selects openai oauth when direct OpenAI is unavailable", () => {
  const service = createService({ anthropicApiKey: "test-anthropic-key" });
  service.openai = null;
  service.codexOAuth = {
    tokens: { refreshToken: "test", accessToken: "", idToken: "", expiresAt: 0, accountId: "acct_123" },
    client: { tag: "oauth" }
  } as never;

  const resolved = service.getComputerUseClient();
  assert.equal(resolved.provider, "openai-oauth");
  assert.deepEqual(resolved.client, { tag: "oauth" });
});

test("getComputerUseClient honors explicit openai selection without falling back", () => {
  const service = createService({ anthropicApiKey: "test-anthropic-key" });
  service.openai = null;
  service.codexOAuth = {
    tokens: { refreshToken: "test", accessToken: "", idToken: "", expiresAt: 0, accountId: "acct_123" },
    client: { tag: "oauth" }
  } as never;

  const resolved = service.getComputerUseClient("openai");
  assert.equal(resolved.provider, null);
  assert.equal(resolved.client, null);
});

test("resolveProviderAndModel accepts standard model IDs for claude-oauth", () => {
  const service = createService({ anthropicApiKey: "test-anthropic-key" });
  service.claudeOAuth = { tokens: { refreshToken: "test", accessToken: "", expiresAt: 0 }, client: {} } as never;

  const resolved = service.resolveProviderAndModel({ provider: "claude-oauth", model: "claude-haiku-4-5" });
  assert.deepEqual(resolved, { provider: "claude-oauth", model: "claude-haiku-4-5" });
});

test("resolveDefaultModel uses claude-haiku-4-5 for anthropic fallback", () => {
  const service = createService({ anthropicApiKey: "test-anthropic-key", defaultAnthropicModel: "" });
  const resolved = service.resolveProviderAndModel({ provider: "anthropic", model: "" });
  assert.deepEqual(resolved, { provider: "anthropic", model: "claude-haiku-4-5" });
});

test("resolveProviderAndModel falls back from unavailable openai to anthropic", () => {
  const service = createService({
    openaiApiKey: "",
    anthropicApiKey: "test-anthropic-key"
  });
  // Isolate from any OAuth token files that may exist on disk.
  service.codexOAuth = null;
  service.claudeOAuth = null;

  const resolved = service.resolveProviderAndModel({ provider: "openai", model: "" });
  assert.deepEqual(resolved, { provider: "anthropic", model: "claude-haiku-4-5" });
});

test("media generation capability helpers select configured provider/model targets", () => {
  const service = createService({
    openaiApiKey: "test-openai-key",
    xaiApiKey: "test-xai-key"
  });

  const settings = {
    initiative: {
      discovery: {
        simpleImageModel: "gpt-image-1.5",
        complexImageModel: "grok-imagine-image",
        videoModel: "grok-imagine-video",
        allowedImageModels: ["gpt-image-1.5", "grok-imagine-image"],
        allowedVideoModels: ["grok-imagine-video", "gpt-video-1"]
      }
    }
  };

  const caps = service.getMediaGenerationCapabilities(settings);
  assert.equal(caps.simpleImageReady, true);
  assert.equal(caps.simpleImageModel, "gpt-image-1.5");
  assert.equal(caps.complexImageReady, true);
  assert.equal(caps.complexImageModel, "grok-imagine-image");
  assert.equal(caps.videoReady, true);
  assert.equal(caps.videoModel, "grok-imagine-video");

  assert.equal(service.isImageGenerationReady(settings, "simple"), true);
  assert.equal(service.isImageGenerationReady(settings, "complex"), true);
  assert.equal(service.isVideoGenerationReady(settings), true);
});

test("resolveVideoGenerationTarget returns null when xai is unavailable", () => {
  const service = createService({
    openaiApiKey: "test-openai-key",
    xaiApiKey: ""
  });

  const settings = {
    discovery: {
      videoModel: "grok-imagine-video",
      allowedVideoModels: ["grok-imagine-video"]
    }
  };
  assert.equal(service.resolveVideoGenerationTarget(settings), null);
});

test("transcribeAudio and synthesizeSpeech enforce readiness and log successful calls", async () => {
  const logs = [];
  const service = createService(
    {
      openaiApiKey: "test-openai-key"
    },
    { logs }
  );
  service.openai = {
    audio: {
      transcriptions: {
        async create() {
          return { text: "hello world" };
        }
      },
      speech: {
        async create() {
          return {
            async arrayBuffer() {
              return new Uint8Array([1, 2, 3, 4]).buffer;
            }
          };
        }
      }
    }
  };

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-llm-test-"));
  const wavPath = path.join(dir, "sample.wav");
  await fs.writeFile(wavPath, "fake audio bytes");

  try {
    const transcript = await service.transcribeAudio({
      filePath: wavPath,
      trace: { source: "unit_test" }
    });
    assert.equal(transcript, "hello world");
    const inMemoryTranscript = await service.transcribeAudio({
      audioBytes: Buffer.from("fake in-memory audio bytes"),
      fileName: "sample.wav",
      trace: { source: "unit_test_in_memory" }
    });
    assert.equal(inMemoryTranscript, "hello world");

    const tts = await service.synthesizeSpeech({
      text: "say less",
      trace: { source: "unit_test" }
    });
    assert.equal(tts.audioBuffer.length > 0, true);
    assert.equal(tts.responseFormat, "pcm");
  } finally {
    await rmTempDir(dir);
  }

  assert.equal(logs.some((entry) => entry.kind === "asr_call"), true);
  assert.equal(logs.some((entry) => entry.kind === "tts_call"), true);
});

test("synthesizeSpeech rejects empty text input", async () => {
  const service = createService({
    openaiApiKey: "test-openai-key"
  });
  service.openai = {
    audio: {
      speech: {
        async create() {
          throw new Error("should not be called");
        }
      }
    }
  };

  await assert.rejects(
    () => service.synthesizeSpeech({ text: "   " }),
    /requires non-empty text/i
  );
});

test("fetchXaiJson requires XAI API key", async () => {
  const service = createService({
    xaiApiKey: ""
  });
  await assert.rejects(
    () => service.fetchXaiJson("https://api.x.ai/v1/videos"),
    /Missing XAI_API_KEY/i
  );
});

test("callOpenAI uses Responses API with max_output_tokens and multimodal input", async () => {
  const service = createService({
    openaiApiKey: "test-openai-key"
  });
  let seenPayload = null;
  service.openai = {
    responses: {
      async create(payload) {
        seenPayload = payload;
        return {
          output_text: "hello from responses",
          usage: {
            input_tokens: 21,
            output_tokens: 7,
            input_tokens_details: {
              cached_tokens: 4
            }
          }
        };
      }
    }
  };

  const result = await service.callOpenAI({
    model: "claude-haiku-4-5",
    systemPrompt: "system prompt",
    userPrompt: "what is in this image?",
    imageInputs: [
      {
        mediaType: "image/png",
        dataBase64: "Zm9v"
      }
    ],
    contextMessages: [
      {
        role: "assistant",
        content: "previous answer"
      }
    ],
    temperature: 0.5,
    maxOutputTokens: 123
  });

  assert.equal(result.text, "hello from responses");
  assert.deepEqual(result.usage, {
    inputTokens: 21,
    outputTokens: 7,
    cacheWriteTokens: 0,
    cacheReadTokens: 4
  });
  assert.equal(seenPayload.max_output_tokens, 123);
  assert.equal(Object.hasOwn(seenPayload, "max_tokens"), false);
  assert.equal(seenPayload.instructions, "system prompt");
  assert.equal(seenPayload.input?.[0]?.role, "assistant");
  assert.equal(seenPayload.input?.[0]?.content, "previous answer");
  assert.equal(seenPayload.input?.[1]?.role, "user");
  assert.equal(seenPayload.input?.[1]?.content?.[0]?.type, "input_text");
  assert.equal(seenPayload.input?.[1]?.content?.[1]?.type, "input_image");
});

test("callOpenAI omits empty text multimodal blocks", async () => {
  const service = createService({
    openaiApiKey: "test-openai-key"
  });
  let seenPayload = null;
  service.openai = {
    responses: {
      async create(payload) {
        seenPayload = payload;
        return {
          output_text: "ok",
          usage: {
            input_tokens: 5,
            output_tokens: 1,
            input_tokens_details: {
              cached_tokens: 0
            }
          }
        };
      }
    }
  };

  await service.callOpenAI({
    model: "claude-haiku-4-5",
    systemPrompt: "system prompt",
    userPrompt: "   ",
    imageInputs: [
      {
        mediaType: "image/png",
        dataBase64: "Zm9v"
      }
    ],
    contextMessages: [],
    temperature: 0.5,
    maxOutputTokens: 123
  });

  assert.equal(Array.isArray(seenPayload.input?.[0]?.content), true);
  assert.equal(seenPayload.input?.[0]?.content?.length, 1);
  assert.equal(seenPayload.input?.[0]?.content?.[0]?.type, "input_image");
});

test("callOpenAI appends the JSON schema contract to instructions when tools are enabled", async () => {
  const service = createService({
    openaiApiKey: "test-openai-key"
  });
  let seenPayload = null;
  service.openai = {
    responses: {
      async create(payload) {
        seenPayload = payload;
        return {
          output_text: '{"text":"ok"}',
          usage: {
            input_tokens: 5,
            output_tokens: 1,
            input_tokens_details: {
              cached_tokens: 0
            }
          }
        };
      }
    }
  };

  await service.callOpenAI({
    model: "gpt-5.4",
    systemPrompt: "system prompt",
    userPrompt: "say hi",
    contextMessages: [],
    temperature: 0.2,
    maxOutputTokens: 64,
    jsonSchema: '{"type":"object","properties":{"text":{"type":"string"}}}',
    tools: [
      {
        name: "web_search",
        description: "Searches the web",
        input_schema: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      }
    ]
  });

  assert.match(String(seenPayload.instructions || ""), /Return strict JSON only\./);
  assert.match(String(seenPayload.instructions || ""), /JSON schema:/);
});

test("callAnthropic omits empty text multimodal blocks", async () => {
  const service = createService({ anthropicApiKey: "test-anthropic-key" });
  let seenPayload = null;
  service.anthropic = {
    messages: {
      async create(payload) {
        seenPayload = payload;
        return {
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 5,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0
          }
        };
      }
    }
  };

  await service.callAnthropic({
    model: "claude-haiku-4-5",
    systemPrompt: "system prompt",
    userPrompt: "   ",
    imageInputs: [
      {
        mediaType: "image/png",
        dataBase64: "Zm9v"
      }
    ],
    contextMessages: [],
    temperature: 0.2,
    maxOutputTokens: 64
  });

  assert.equal(Array.isArray(seenPayload.messages?.[0]?.content), true);
  assert.equal(Array.isArray(seenPayload.system), true);
  assert.deepEqual(seenPayload.system?.[0], {
    type: "text",
    text: "system prompt",
    cache_control: { type: "ephemeral" }
  });
  assert.equal(
    seenPayload.messages?.[0]?.content?.some((item) => item?.type === "image"),
    true
  );
  assert.equal(
    seenPayload.messages?.[0]?.content?.some((item) => item?.type === "text" && !String(item?.text || "").trim()),
    false
  );
});

test("callAnthropic appends the JSON schema contract to the system prompt when tools are enabled", async () => {
  const service = createService({ anthropicApiKey: "test-anthropic-key" });
  let seenPayload = null;
  service.anthropic = {
    messages: {
      async create(payload) {
        seenPayload = payload;
        return {
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 5,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0
          }
        };
      }
    }
  };

  await service.callAnthropic({
    model: "claude-haiku-4-5",
    systemPrompt: "system prompt",
    userPrompt: "say hi",
    contextMessages: [],
    temperature: 0.2,
    maxOutputTokens: 64,
    jsonSchema: '{"type":"object","properties":{"text":{"type":"string"}}}',
    tools: [
      {
        name: "web_search",
        description: "Searches the web",
        input_schema: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      }
    ]
  });

  assert.match(String(seenPayload.system?.[0]?.text || ""), /Return strict JSON only\./);
  assert.match(String(seenPayload.system?.[0]?.text || ""), /JSON schema:/);
});

test("callAnthropicStreaming forwards streamed text deltas and returns the final response", async () => {
  const service = createService({ anthropicApiKey: "test-anthropic-key" });
  let seenPayload = null;
  let onText = null;
  service.anthropic = {
    messages: {
      stream(payload) {
        seenPayload = payload;
        return {
          on(event, handler) {
            if (event === "text") {
              onText = handler;
            }
          },
          abort() {},
          async finalMessage() {
            onText?.("hello ");
            onText?.("world");
            return {
              content: [{ type: "text", text: "hello world" }],
              stop_reason: "end_turn",
              usage: {
                input_tokens: 7,
                output_tokens: 2,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0
              }
            };
          }
        };
      }
    }
  };

  const deltas: string[] = [];
  const result = await service.callAnthropicStreaming({
    model: "claude-haiku-4-5",
    systemPrompt: "system prompt",
    userPrompt: "say hello",
    contextMessages: [],
    temperature: 0.2,
    maxOutputTokens: 64
  }, {
    onTextDelta(delta) {
      deltas.push(delta);
    }
  });

  assert.equal(seenPayload.model, "claude-haiku-4-5");
  assert.deepEqual(seenPayload.system?.[0], {
    type: "text",
    text: "system prompt",
    cache_control: { type: "ephemeral" }
  });
  assert.deepEqual(deltas, ["hello ", "world"]);
  assert.equal(result.text, "hello world");
  assert.equal(result.stopReason, "end_turn");
});

test("callAnthropic retries a transient overload once before succeeding", async () => {
  const service = createService({ anthropicApiKey: "test-anthropic-key" });
  let attempts = 0;
  service.anthropic = {
    messages: {
      async create() {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("{\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}"), {
            status: 529
          });
        }
        return {
          content: [{ type: "text", text: "recovered" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 7,
            output_tokens: 2,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0
          }
        };
      }
    }
  };

  const result = await service.callAnthropic({
    model: "claude-haiku-4-5",
    systemPrompt: "system prompt",
    userPrompt: "say hello",
    contextMessages: [],
    temperature: 0.2,
    maxOutputTokens: 64
  });

  assert.equal(attempts, 2);
  assert.equal(result.text, "recovered");
});

test("callAnthropicStreaming retries a transient overload before any text delta", async () => {
  const service = createService({ anthropicApiKey: "test-anthropic-key" });
  let attempts = 0;
  service.anthropic = {
    messages: {
      stream() {
        attempts += 1;
        let onText = null;
        return {
          on(event, handler) {
            if (event === "text") {
              onText = handler;
            }
            return this;
          },
          abort() {},
          async finalMessage() {
            if (attempts === 1) {
              throw Object.assign(new Error("{\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}"), {
                status: 529
              });
            }
            onText?.("recovered");
            return {
              content: [{ type: "text", text: "recovered" }],
              stop_reason: "end_turn",
              usage: {
                input_tokens: 7,
                output_tokens: 2,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0
              }
            };
          }
        };
      }
    }
  };

  const deltas: string[] = [];
  const result = await service.callAnthropicStreaming({
    model: "claude-haiku-4-5",
    systemPrompt: "system prompt",
    userPrompt: "say hello",
    contextMessages: [],
    temperature: 0.2,
    maxOutputTokens: 64
  }, {
    onTextDelta(delta) {
      deltas.push(delta);
    }
  });

  assert.equal(attempts, 2);
  assert.deepEqual(deltas, ["recovered"]);
  assert.equal(result.text, "recovered");
});

test("callAnthropicStreaming does not retry after streamed text has already started", async () => {
  const service = createService({ anthropicApiKey: "test-anthropic-key" });
  let attempts = 0;
  service.anthropic = {
    messages: {
      stream() {
        attempts += 1;
        let onText = null;
        return {
          on(event, handler) {
            if (event === "text") {
              onText = handler;
            }
            return this;
          },
          abort() {},
          async finalMessage() {
            onText?.("partial");
            throw Object.assign(new Error("{\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}"), {
              status: 529
            });
          }
        };
      }
    }
  };

  const deltas: string[] = [];
  await assert.rejects(
    service.callAnthropicStreaming({
      model: "claude-haiku-4-5",
      systemPrompt: "system prompt",
      userPrompt: "say hello",
      contextMessages: [],
      temperature: 0.2,
      maxOutputTokens: 64
    }, {
      onTextDelta(delta) {
        deltas.push(delta);
      }
    }),
    /overloaded/i
  );

  assert.equal(attempts, 1);
  assert.deepEqual(deltas, ["partial"]);
});

test("chatWithTools caches Anthropic system prefix and latest tool result follow-up context", async () => {
  const logs = [];
  const service = createService(
    {
      anthropicApiKey: "test-anthropic-key"
    },
    { logs }
  );
  let seenPayload = null;
  service.anthropic = {
    messages: {
      async create(payload) {
        seenPayload = payload;
        return {
          content: [
            { type: "text", text: "Looking now." },
            {
              type: "tool_use",
              id: "call_browser_open",
              name: "browser_open",
              input: { url: "https://example.com" }
            }
          ],
          stop_reason: "tool_use",
          usage: {
            input_tokens: 14,
            output_tokens: 6,
            cache_creation_input_tokens: 7,
            cache_read_input_tokens: 3
          }
        };
      }
    }
  };

  const result = await service.chatWithTools({
    provider: "anthropic",
    model: "claude-haiku-4-5",
    systemPrompt: "browse the web",
    messages: [
      { role: "user", content: "Find example.com" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "call_browser_open",
            name: "browser_open",
            input: { url: "https://example.com" }
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolCallId: "call_browser_open",
            content: "Opened page."
          }
        ]
      }
    ],
    tools: [
      {
        name: "browser_open",
        description: "Open a URL",
        input_schema: {
          type: "object",
          properties: {
            url: { type: "string" }
          },
          required: ["url"]
        }
      }
    ]
  });

  assert.deepEqual(result.content, [
    { type: "text", text: "Looking now." },
    {
      type: "tool_call",
      id: "call_browser_open",
      name: "browser_open",
      input: { url: "https://example.com" }
    }
  ]);
  assert.deepEqual(result.usage, {
    inputTokens: 14,
    outputTokens: 6,
    cacheWriteTokens: 7,
    cacheReadTokens: 3
  });
  assert.deepEqual(seenPayload.system?.[0], {
    type: "text",
    text: "browse the web",
    cache_control: { type: "ephemeral" }
  });
  assert.equal(seenPayload.tools?.[0]?.cache_control, undefined);
  assert.equal(seenPayload.messages?.[2]?.content?.[0]?.type, "tool_result");
  assert.deepEqual(seenPayload.messages?.[2]?.content?.[0]?.cache_control, {
    type: "ephemeral"
  });
  assert.equal(
    logs.some((entry) =>
      entry.kind === "llm_tool_call" &&
      entry.metadata?.usage?.cacheWriteTokens === 7 &&
      entry.metadata?.usage?.cacheReadTokens === 3
    ),
    true
  );
});

test("callAnthropicStreaming handles user-aborted Claude streams without leaking stream aborts", async () => {
  const service = createService({ anthropicApiKey: "test-anthropic-key" });
  let streamAbortListener: ((error?: unknown) => void) | null = null;
  let streamErrorListener: ((error?: unknown) => void) | null = null;
  let rejectFinalMessage: ((error?: unknown) => void) | null = null;
  let abortCalled = false;

  service.anthropic = {
    messages: {
      stream() {
        return {
          on(event, handler) {
            if (event === "abort") {
              streamAbortListener = handler;
            }
            if (event === "error") {
              streamErrorListener = handler;
            }
            return this;
          },
          abort() {
            abortCalled = true;
            streamAbortListener?.(new Error("Request was aborted."));
            rejectFinalMessage?.(new Error("Request was aborted."));
          },
          async finalMessage() {
            return await new Promise((_, reject) => {
              rejectFinalMessage = reject;
            });
          }
        };
      }
    }
  };

  const controller = new AbortController();
  const promise = service.callAnthropicStreaming({
    model: "claude-haiku-4-5",
    systemPrompt: "system prompt",
    userPrompt: "say hello",
    contextMessages: [],
    temperature: 0.2,
    maxOutputTokens: 64
  }, {
    signal: controller.signal,
    onTextDelta() {}
  });

  controller.abort("Pending response cleared");

  await assert.rejects(promise, /aborted/i);
  assert.equal(abortCalled, true);
  assert.equal(typeof streamAbortListener, "function");
  assert.equal(typeof streamErrorListener, "function");
});

test("callChatModelStreaming supports OpenAI Responses streaming", async () => {
  const service = createService({ openaiApiKey: "test-openai-key" });
  let seenPayload = null;
  service.openai = {
    responses: {
      async create(payload) {
        seenPayload = payload;
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "response.output_text.delta", delta: "hello " };
            yield { type: "response.function_call_arguments.delta", delta: "{\"text\":\"remember this\"}" };
            yield {
              type: "response.completed",
              response: {
                output_text: "hello world",
                output: [
                  {
                    id: "msg_1",
                    type: "message",
                    role: "assistant",
                    content: [
                      {
                        type: "output_text",
                        text: "hello world",
                        annotations: []
                      }
                    ]
                  },
                  {
                    id: "fc_1",
                    type: "function_call",
                    call_id: "fc_1",
                    name: "note_context",
                    arguments: "{\"text\":\"remember this\"}"
                  }
                ],
                usage: {
                  input_tokens: 11,
                  output_tokens: 4,
                  input_tokens_details: {
                    cached_tokens: 1
                  }
                }
              }
            };
          }
        };
      }
    }
  };

  const deltas: string[] = [];
  const blocks: Array<Record<string, unknown>> = [];
  const result = await service.callChatModelStreaming("openai", {
    model: "gpt-5-mini",
    systemPrompt: "system",
    userPrompt: "user",
    contextMessages: [],
    temperature: 0.2,
    maxOutputTokens: 64
  }, {
    onTextDelta(delta) {
      deltas.push(delta);
    },
    onContentBlockComplete(block) {
      blocks.push(block);
    }
  });

  assert.equal(seenPayload.stream, true);
  assert.deepEqual(deltas, ["hello "]);
  assert.equal(result.text, "hello world");
  assert.deepEqual(result.toolCalls, [
    {
      id: "fc_1",
      name: "note_context",
      input: {
        text: "remember this"
      }
    }
  ]);
  assert.deepEqual(blocks, [
    { type: "text", text: "hello world" },
    {
      type: "tool_use",
      id: "fc_1",
      name: "note_context",
      input: {
        text: "remember this"
      }
    }
  ]);
});

test("callChatModelStreaming recovers OpenAI text from done-only events", async () => {
  const service = createService({ openaiApiKey: "test-openai-key" });
  service.openai = {
    responses: {
      async create() {
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "response.output_text.done", text: "{\"text\":\"try what exactly?\",\"skip\":false}" };
            yield {
              type: "response.completed",
              response: {
                status: "completed",
                output: [],
                usage: {
                  input_tokens: 11,
                  output_tokens: 6
                }
              }
            };
          }
        };
      }
    }
  };

  const deltas: string[] = [];
  const result = await service.callChatModelStreaming("openai", {
    model: "gpt-5-mini",
    systemPrompt: "system",
    userPrompt: "user",
    contextMessages: [],
    temperature: 0.2,
    maxOutputTokens: 64
  }, {
    onTextDelta(delta) {
      deltas.push(delta);
    }
  });

  assert.deepEqual(deltas, []);
  assert.equal(result.text, "{\"text\":\"try what exactly?\",\"skip\":false}");
});

test("generateStreaming falls back to batch generation for non-streaming providers", async () => {
  const service = createService({ xaiApiKey: "test-xai-key" });
  service.callChatModel = async () => ({
    text: "fallback batch reply",
    toolCalls: [],
    rawContent: null,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheWriteTokens: 0,
      cacheReadTokens: 0
    }
  });

  const deltas: string[] = [];
  const result = await service.generateStreaming({
    settings: {
      agentStack: {
        overrides: {
          orchestrator: {
            provider: "xai",
            model: "grok-3-mini-latest"
          }
        }
      }
    },
    systemPrompt: "system",
    userPrompt: "user",
    contextMessages: [],
    onTextDelta(delta) {
      deltas.push(delta);
    }
  });

  assert.deepEqual(deltas, ["fallback batch reply"]);
  assert.equal(result.text, "fallback batch reply");
});

test("generateStreaming logs returned text, tool names, and stop reason for runtime debugging", async () => {
  const logs = [];
  const service = createService({ xaiApiKey: "test-xai-key" }, { logs });
  service.callChatModel = async () => ({
    text: "yo, give me some sound effects",
    toolCalls: [
      {
        id: "tool_1",
        name: "play_soundboard",
        input: {
          refs: ["airhorn"]
        }
      }
    ],
    rawContent: null,
    stopReason: "tool_calls",
    usage: {
      inputTokens: 9,
      outputTokens: 4,
      cacheWriteTokens: 0,
      cacheReadTokens: 0
    }
  });

  const result = await service.generateStreaming({
    settings: {
      agentStack: {
        overrides: {
          orchestrator: {
            provider: "xai",
            model: "grok-3-mini-latest"
          }
        }
      }
    },
    systemPrompt: "system",
    userPrompt: "user",
    contextMessages: [],
    trace: {
      source: "voice_realtime_generation",
      event: "voice_turn"
    },
    onTextDelta() {}
  });

  assert.equal(result.text, "yo, give me some sound effects");
  assert.equal(result.stopReason, "tool_calls");
  const llmLog = logs.find((entry) => entry?.kind === "llm_call");
  assert.ok(llmLog);
  assert.equal(llmLog.metadata?.toolNames, "play_soundboard");
  assert.equal(llmLog.metadata?.stopReason, "tool_calls");
  assert.equal(llmLog.metadata?.transcript, "yo, give me some sound effects");
  assert.equal(llmLog.metadata?.transcriptSource, "output");
});

test("generateStreaming logs compact provider response shape for silent-output debugging", async () => {
  const logs = [];
  const service = createService({ xaiApiKey: "test-xai-key" }, { logs });
  service.callChatModel = async () => ({
    text: "",
    toolCalls: [],
    rawContent: [],
    responseDiagnostics: {
      transport: "openai_responses_stream",
      streamDeltaTextChars: 0,
      streamDoneTextChars: 0,
      extractedTextChars: 0,
      finalOutputItemCount: 0
    },
    stopReason: "completed",
    usage: {
      inputTokens: 9,
      outputTokens: 122,
      cacheWriteTokens: 0,
      cacheReadTokens: 0
    }
  });

  await service.generateStreaming({
    settings: {
      agentStack: {
        overrides: {
          orchestrator: {
            provider: "xai",
            model: "grok-3-mini-latest"
          }
        }
      }
    },
    systemPrompt: "system",
    userPrompt: "user",
    contextMessages: [],
    trace: {
      source: "message_event",
      messageId: "msg_1"
    },
    onTextDelta() {}
  });

  const llmLog = logs.find((entry) => entry?.kind === "llm_call");
  assert.ok(llmLog);
  assert.equal(llmLog.metadata?.responseChars, 0);
  assert.equal(llmLog.metadata?.responseShape, "raw=array[0] delta=0 done=0 extracted=0 finalOut=0");
  assert.deepEqual(llmLog.metadata?.rawContentSummary, {
    shape: "array",
    length: 0,
    messageCount: 0,
    functionCallCount: 0,
    functionCallArgumentChars: 0,
    functionCallArgumentPresent: false,
    textChars: 0
  });
  assert.deepEqual(llmLog.metadata?.responseDiagnostics, {
    transport: "openai_responses_stream",
    streamDeltaTextChars: 0,
    streamDoneTextChars: 0,
    extractedTextChars: 0,
    finalOutputItemCount: 0
  });
});

test("callChatModelStreaming records OpenAI stream extraction diagnostics", async () => {
  const service = createService({ openaiApiKey: "test-openai-key" });
  service.openai = {
    responses: {
      async create() {
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "response.output_text.delta", delta: "hello " };
            yield { type: "response.output_text.done", text: "hello world" };
            yield { type: "response.function_call_arguments.delta", delta: "{\"task\":\"x\"}" };
            yield {
              type: "response.completed",
              response: {
                status: "completed",
                output_text: "",
                output: [],
                usage: {
                  input_tokens: 11,
                  output_tokens: 6
                }
              }
            };
          }
        };
      }
    }
  };

  const result = await service.callChatModelStreaming("openai", {
    model: "gpt-5-mini",
    systemPrompt: "system",
    userPrompt: "user",
    contextMessages: [],
    temperature: 0.2,
    maxOutputTokens: 64
  }, {
    onTextDelta() {}
  });

  assert.equal(result.text, "hello");
  assert.deepEqual(result.responseDiagnostics, {
    transport: "openai_responses_stream",
    streamDeltaTextChars: 6,
    streamOutputTextDeltaEventCount: 1,
    streamDoneTextChars: 11,
    streamOutputTextDoneEventCount: 1,
    streamContentPartDoneEventCount: 0,
    streamFunctionArgumentDeltaEventCount: 1,
    streamFunctionArgumentDeltaChars: 12,
    streamFunctionArgumentsDoneEventCount: 0,
    streamFunctionCallItemAddedCount: 0,
    streamFunctionCallItemDoneCount: 0,
    streamFunctionCallDraftCount: 1,
    streamRecoveredToolCallCount: 0,
    streamRecoveredToolCallNames: null,
    extractedTextChars: 0,
    fallbackTextUsed: true,
    finalStatus: "completed",
    finalOutputItemCount: 0,
    finalOutputItemTypes: null,
    finalContentPartTypes: null,
    finalFunctionCallCount: 0,
    finalFunctionCallArgumentChars: 0,
    finalFunctionCallArgumentPresent: false,
    finalOutputTextChars: 0
  });
});

test("callChatModelStreaming recovers OpenAI streamed tool calls when final output is empty", async () => {
  const service = createService({ openaiApiKey: "test-openai-key" });
  service.openai = {
    responses: {
      async create() {
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "response.output_item.added",
              item: {
                id: "fc_1",
                type: "function_call",
                call_id: "call_spawn",
                name: "spawn_code_worker",
                arguments: ""
              }
            };
            yield {
              type: "response.function_call_arguments.delta",
              item_id: "fc_1",
              delta: "{\"task\":\"create "
            };
            yield {
              type: "response.function_call_arguments.delta",
              item_id: "fc_1",
              delta: "todo app\"}"
            };
            yield {
              type: "response.output_item.done",
              item: {
                id: "fc_1",
                type: "function_call",
                call_id: "call_spawn",
                name: "spawn_code_worker"
              }
            };
            yield {
              type: "response.completed",
              response: {
                status: "completed",
                output_text: "",
                output: [],
                usage: {
                  input_tokens: 11,
                  output_tokens: 6
                }
              }
            };
          }
        };
      }
    }
  };

  const blocks: Array<Record<string, unknown>> = [];
  const result = await service.callChatModelStreaming("openai", {
    model: "gpt-5-mini",
    systemPrompt: "system",
    userPrompt: "user",
    contextMessages: [],
    temperature: 0.2,
    maxOutputTokens: 64
  }, {
    onTextDelta() {},
    onContentBlockComplete(block) {
      blocks.push(block);
    }
  });

  assert.equal(result.text, "");
  assert.deepEqual(result.toolCalls, [
    {
      id: "call_spawn",
      name: "spawn_code_worker",
      input: {
        task: "create todo app"
      }
    }
  ]);
  assert.deepEqual(result.rawContent, [
    {
      id: "call_spawn",
      type: "function_call",
      call_id: "call_spawn",
      name: "spawn_code_worker",
      arguments: "{\"task\":\"create todo app\"}"
    }
  ]);
  assert.deepEqual(blocks, [
    {
      type: "tool_use",
      id: "call_spawn",
      name: "spawn_code_worker",
      input: {
        task: "create todo app"
      }
    }
  ]);
  assert.equal(result.responseDiagnostics?.streamRecoveredToolCallCount, 1);
  assert.deepEqual(result.responseDiagnostics?.streamRecoveredToolCallNames, ["spawn_code_worker"]);
  assert.equal(result.responseDiagnostics?.finalOutputItemCount, 0);
});

test("chatWithTools supports OpenAI function-call loops", async () => {
  const logs = [];
  const service = createService(
    {
      openaiApiKey: "test-openai-key"
    },
    { logs }
  );
  let seenPayload = null;
  service.openai = {
    responses: {
      async create(payload) {
        seenPayload = payload;
        return {
          output: [
            {
              id: "msg_1",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: "Looking now.",
                  annotations: []
                }
              ]
            },
            {
              id: "fc_1",
              type: "function_call",
              call_id: "call_browser_open",
              name: "browser_open",
              arguments: "{\"url\":\"https://example.com\"}",
              status: "completed"
            }
          ],
          usage: {
            input_tokens: 14,
            output_tokens: 6,
            input_tokens_details: {
              cached_tokens: 2
            }
          }
        };
      }
    }
  };

  const result = await service.chatWithTools({
    provider: "openai",
    model: "gpt-5-mini",
    systemPrompt: "browse the web",
    messages: [
      { role: "user", content: "Find example.com" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "call_browser_open",
            name: "browser_open",
            input: { url: "https://example.com" }
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolCallId: "call_browser_open",
            content: "Opened page."
          }
        ]
      }
    ],
    tools: [
      {
        name: "browser_open",
        description: "Open a URL",
        input_schema: {
          type: "object",
          properties: {
            url: { type: "string" }
          },
          required: ["url"]
        }
      }
    ]
  });

  assert.deepEqual(result.content, [
    { type: "text", text: "Looking now." },
    {
      type: "tool_call",
      id: "call_browser_open",
      name: "browser_open",
      input: { url: "https://example.com" }
    }
  ]);
  assert.deepEqual(result.usage, {
    inputTokens: 14,
    outputTokens: 6,
    cacheWriteTokens: 0,
    cacheReadTokens: 2
  });
  assert.equal(seenPayload.instructions, "browse the web");
  assert.equal(seenPayload.input?.[0]?.role, "user");
  assert.equal(seenPayload.input?.[0]?.content?.[0]?.type, "input_text");
  assert.equal(seenPayload.input?.[1]?.type, "function_call");
  assert.equal(seenPayload.input?.[1]?.call_id, "call_browser_open");
  assert.equal(seenPayload.input?.[2]?.type, "function_call_output");
  assert.equal(seenPayload.input?.[2]?.call_id, "call_browser_open");
  assert.equal(logs.some((entry) => entry.kind === "llm_tool_call" && entry.content === "openai:gpt-5-mini"), true);
});

test("generateImage uses OpenAI Responses image_generation tool", async () => {
  const service = createService({
    openaiApiKey: "test-openai-key"
  });
  let seenPayload = null;
  const pngBase64 = Buffer.from([137, 80, 78, 71]).toString("base64");

  service.openai = {
    responses: {
      async create(payload) {
        seenPayload = payload;
        return {
          output: [
            {
              type: "image_generation_call",
              result: pngBase64
            }
          ]
        };
      }
    }
  };

  const result = await service.generateImage({
    settings: {
      discovery: {
        simpleImageModel: "gpt-image-1.5",
        allowedImageModels: ["gpt-image-1.5"]
      }
    },
    prompt: "a cat in a hoodie",
    variant: "simple",
    trace: { source: "unit_test" }
  });

  assert.equal(result.provider, "openai");
  assert.equal(result.model, "gpt-image-1.5");
  assert.equal(result.imageBuffer?.length > 0, true);
  assert.equal(result.imageUrl, null);
  assert.equal(seenPayload.model, "gpt-image-1.5");
  assert.equal(seenPayload.tool_choice, "required");
  assert.equal(seenPayload.tools?.[0]?.type, "image_generation");
  assert.equal(seenPayload.tools?.[0]?.size, "1024x1024");
  assert.equal(seenPayload.tools?.[0]?.output_format, "png");
  assert.equal(seenPayload.input?.[0]?.role, "user");
  assert.equal(seenPayload.input?.[0]?.content?.[0]?.type, "input_text");
});
