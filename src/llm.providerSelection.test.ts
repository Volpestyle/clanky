import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LLMService } from "./llm.ts";

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
      defaultClaudeCodeModel: "sonnet",
      ...appConfig
    },
    store: {
      logAction(entry) {
        if (Array.isArray(logs)) logs.push(entry);
      }
    }
  });
}

test("resolveProviderAndModel throws when claude-code is selected but CLI is unavailable", () => {
  const service = createService({ anthropicApiKey: "test-anthropic-key" });
  service.claudeCodeAvailable = false;

  assert.throws(
    () => service.resolveProviderAndModel({ provider: "claude-code", model: "opus" }),
    /claude-code.*not available on PATH/i
  );
});

test("resolveProviderAndModel keeps claude-code provider when CLI is available", () => {
  const service = createService({ anthropicApiKey: "test-anthropic-key" });
  service.claudeCodeAvailable = true;

  const resolved = service.resolveProviderAndModel({ provider: "claude-code", model: "opus" });
  assert.deepEqual(resolved, { provider: "claude-code", model: "opus" });
});

test("resolveProviderAndModel rejects unsupported claude-code model IDs", () => {
  const service = createService({ anthropicApiKey: "test-anthropic-key" });
  service.claudeCodeAvailable = true;

  assert.throws(
    () => service.resolveProviderAndModel({ provider: "claude-code", model: "claude-3-5-haiku-latest" }),
    /invalid claude-code model/i
  );
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

  const resolved = service.resolveProviderAndModel({ provider: "openai", model: "" });
  assert.deepEqual(resolved, { provider: "anthropic", model: "claude-haiku-4-5" });
});

test("media generation capability helpers select configured provider/model targets", () => {
  const service = createService({
    openaiApiKey: "test-openai-key",
    xaiApiKey: "test-xai-key"
  });

  const settings = {
    discovery: {
      simpleImageModel: "gpt-image-1.5",
      complexImageModel: "grok-imagine-image",
      videoModel: "grok-imagine-video",
      allowedImageModels: ["gpt-image-1.5", "grok-imagine-image"],
      allowedVideoModels: ["grok-imagine-video", "gpt-video-1"]
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
    await fs.rm(dir, { recursive: true, force: true });
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

test("callOpenAiMemoryExtraction uses Responses JSON schema format", async () => {
  const service = createService({
    openaiApiKey: "test-openai-key"
  });
  let seenPayload = null;
  service.openai = {
    responses: {
      async create(payload) {
        seenPayload = payload;
        return {
          output_text: "{\"facts\":[]}",
          usage: {
            input_tokens: 9,
            output_tokens: 2,
            input_tokens_details: {
              cached_tokens: 0
            }
          }
        };
      }
    }
  };

  const result = await service.callOpenAiMemoryExtraction({
    model: "claude-haiku-4-5",
    systemPrompt: "extract durable facts only",
    userPrompt: "user says they like sci-fi"
  });

  assert.equal(result.text, "{\"facts\":[]}");
  assert.deepEqual(result.usage, {
    inputTokens: 9,
    outputTokens: 2,
    cacheWriteTokens: 0,
    cacheReadTokens: 0
  });
  assert.equal(seenPayload.max_output_tokens, 320);
  assert.equal(seenPayload.instructions, "extract durable facts only");
  assert.equal(seenPayload.text?.format?.type, "json_schema");
  assert.equal(seenPayload.text?.format?.name, "memory_fact_extraction");
  assert.equal(seenPayload.text?.format?.strict, true);
  assert.deepEqual(
    seenPayload.text?.format?.schema?.properties?.facts?.items?.properties?.subject?.enum,
    ["author", "bot", "lore"]
  );
  assert.deepEqual(
    seenPayload.text?.format?.schema?.properties?.facts?.items?.required,
    ["subject", "fact", "type", "confidence", "evidence"]
  );
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
