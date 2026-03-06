import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  buildClaudeCodeCliArgs,
  buildClaudeCodeJsonCliArgs,
  buildClaudeCodeTextCliArgs,
  buildClaudeCodeStreamInput,
  buildClaudeCodeSystemPrompt,
  createClaudeCliStreamSession,
  parseClaudeCodeStreamOutput,
  parseClaudeCodeJsonOutput
} from "../llm.ts";

test("buildClaudeCodeStreamInput emits only context and user events (no stream system event)", () => {
  const input = buildClaudeCodeStreamInput({
    contextMessages: [
      { role: "assistant", content: "previous assistant reply" },
      { role: "user", content: "previous user message" }
    ],
    userPrompt: "latest user prompt",
    imageInputs: [{ url: "https://example.com/image.png" }]
  });
  const events = String(input)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.equal(events.length, 3);
  assert.equal(events.some((event) => event.type === "system"), false);

  assert.equal(events[0].type, "assistant");
  assert.equal(events[0].message.role, "assistant");
  assert.equal(events[0].message.content[0].type, "text");
  assert.equal(events[0].message.content[0].text, "previous assistant reply");

  assert.equal(events[1].type, "user");
  assert.equal(events[1].message.role, "user");
  assert.equal(events[1].message.content[0].type, "text");
  assert.equal(events[1].message.content[0].text, "previous user message");

  assert.equal(events[2].type, "user");
  assert.equal(events[2].message.role, "user");
  assert.equal(events[2].message.content[0].type, "text");
  assert.equal(events[2].message.content[0].text, "latest user prompt");
  assert.equal(events[2].message.content[1].type, "image");
  assert.equal(events[2].message.content[1].source.type, "url");
  assert.equal(events[2].message.content[1].source.url, "https://example.com/image.png");
});

test("buildClaudeCodeStreamInput prepends a turn preamble to the final user message when provided", () => {
  const input = buildClaudeCodeStreamInput({
    contextMessages: [{ role: "assistant", content: "previous assistant reply" }],
    userPrompt: "latest user prompt",
    turnPreamble: "Turn metadata and privacy boundary",
    imageInputs: []
  });
  const events = String(input)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.equal(events.length, 2);
  assert.equal(events[1].type, "user");
  assert.equal(
    events[1].message.content[0].text,
    "Turn metadata and privacy boundary\n\nlatest user prompt"
  );
});

test("buildClaudeCodeCliArgs includes stream-json flags, system prompt, and optional schema", () => {
  const args = buildClaudeCodeCliArgs({
    model: "haiku",
    systemPrompt: "Binary classifier prompt",
    jsonSchema: '{"type":"object","properties":{"decision":{"type":"string"}}}'
  });

  assert.equal(args.includes("--verbose"), true);
  assert.equal(args.includes("--input-format"), true);
  assert.equal(args.includes("stream-json"), true);
  assert.equal(args.includes("--output-format"), true);
  assert.equal(args.includes("--no-session-persistence"), true);
  assert.equal(args.includes("--strict-mcp-config"), true);
  assert.equal(args.includes("--plugin-dir"), true);
  assert.equal(args[args.indexOf("--plugin-dir") + 1], "");
  assert.equal(args.includes("--setting-sources"), true);
  assert.equal(args[args.indexOf("--setting-sources") + 1], "project,local");
  assert.equal(args.includes("--system-prompt"), true);
  assert.equal(args.includes("--json-schema"), true);
  const maxTurnsIndex = args.indexOf("--max-turns");
  assert.equal(args[maxTurnsIndex + 1], "1");

  const modelIndex = args.indexOf("--model");
  assert.equal(args[modelIndex + 1], "haiku");

  const systemPromptIndex = args.indexOf("--system-prompt");
  assert.equal(args[systemPromptIndex + 1], "Binary classifier prompt");

  const schemaIndex = args.indexOf("--json-schema");
  assert.equal(args[schemaIndex + 1], '{"type":"object","properties":{"decision":{"type":"string"}}}');
});

test("buildClaudeCodeCliArgs allows overriding max turns for persistent stream sessions", () => {
  const args = buildClaudeCodeCliArgs({
    model: "haiku",
    systemPrompt: "Binary classifier prompt",
    jsonSchema: '{"type":"object","properties":{"decision":{"type":"string"}}}',
    maxTurns: 120
  });
  const maxTurnsIndex = args.indexOf("--max-turns");
  assert.equal(args[maxTurnsIndex + 1], "120");
});

test("buildClaudeCodeJsonCliArgs includes output-format json and trailing prompt", () => {
  const args = buildClaudeCodeJsonCliArgs({
    model: "opus",
    systemPrompt: "You are concise.",
    jsonSchema: '{"type":"object"}',
    prompt: "Hello there"
  });

  assert.equal(args.includes("--output-format"), true);
  assert.equal(args.includes("--strict-mcp-config"), true);
  assert.equal(args.includes("--plugin-dir"), true);
  assert.equal(args[args.indexOf("--plugin-dir") + 1], "");
  assert.equal(args.includes("--setting-sources"), true);
  assert.equal(args[args.indexOf("--setting-sources") + 1], "project,local");
  const outputFormatIndex = args.indexOf("--output-format");
  assert.equal(args[outputFormatIndex + 1], "json");

  const modelIndex = args.indexOf("--model");
  assert.equal(args[modelIndex + 1], "opus");

  assert.equal(args[args.length - 1], "Hello there");
});

test("buildClaudeCodeTextCliArgs builds plain text fallback args", () => {
  const args = buildClaudeCodeTextCliArgs({
    model: "opus",
    systemPrompt: "You are concise.",
    jsonSchema: '{"type":"object"}',
    prompt: "Hello there"
  });

  assert.equal(args.includes("--output-format"), false);
  assert.equal(args.includes("--strict-mcp-config"), true);
  assert.equal(args.includes("--plugin-dir"), true);
  assert.equal(args[args.indexOf("--plugin-dir") + 1], "");
  assert.equal(args.includes("--setting-sources"), true);
  assert.equal(args[args.indexOf("--setting-sources") + 1], "project,local");
  const modelIndex = args.indexOf("--model");
  assert.equal(args[modelIndex + 1], "opus");
  assert.equal(args[args.length - 1], "Hello there");
});

test("buildClaudeCodeSystemPrompt appends output-budget guidance when a token limit exists", () => {
  const full = buildClaudeCodeSystemPrompt({
    systemPrompt: "You are a strict classifier.",
    maxOutputTokens: 2
  });
  assert.equal(
    full,
    "You are a strict classifier.\n\nKeep the final answer under 2 tokens."
  );

  const noBudget = buildClaudeCodeSystemPrompt({
    systemPrompt: "You are a strict classifier.",
    maxOutputTokens: 0
  });
  assert.equal(noBudget, "You are a strict classifier.");
});

test("parseClaudeCodeStreamOutput prioritizes StructuredOutput tool payload when result text is empty", () => {
  const raw = [
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Done. I've called the StructuredOutput tool as instructed." },
          { type: "tool_use", name: "StructuredOutput", input: { decision: "NO" } }
        ]
      }
    }),
    JSON.stringify({
      type: "result",
      subtype: "error_max_turns",
      is_error: false,
      result: "",
      usage: {
        input_tokens: 11,
        output_tokens: 33,
        cache_creation_input_tokens: 7,
        cache_read_input_tokens: 5
      },
      total_cost_usd: 0.42
    })
  ].join("\n");

  const parsed = parseClaudeCodeStreamOutput(raw);
  assert.ok(parsed);
  assert.equal(parsed.text, '{"decision":"NO"}');
  assert.equal(parsed.isError, false);
  assert.deepEqual(parsed.usage, {
    inputTokens: 11,
    outputTokens: 33,
    cacheWriteTokens: 7,
    cacheReadTokens: 5
  });
  assert.equal(parsed.costUsd, 0.42);
});

test("parseClaudeCodeStreamOutput falls back to assistant text when no result event exists", () => {
  const raw = JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "text", text: "YES" }]
    }
  });

  const parsed = parseClaudeCodeStreamOutput(raw);
  assert.ok(parsed);
  assert.equal(parsed.text, "YES");
  assert.equal(parsed.isError, false);
});

test("parseClaudeCodeJsonOutput parses result payload and usage", () => {
  const raw = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "YES",
    usage: {
      input_tokens: 4,
      output_tokens: 2,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 20
    },
    total_cost_usd: 0.11
  });

  const parsed = parseClaudeCodeJsonOutput(raw);
  assert.ok(parsed);
  assert.equal(parsed.text, "YES");
  assert.equal(parsed.isError, false);
  assert.equal(parsed.costUsd, 0.11);
  assert.deepEqual(parsed.usage, {
    inputTokens: 4,
    outputTokens: 2,
    cacheWriteTokens: 10,
    cacheReadTokens: 20
  });
});

test("parseClaudeCodeJsonOutput supports pretty-printed whole JSON output", () => {
  const raw = JSON.stringify(
    {
      type: "result",
      is_error: false,
      result: "NO",
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      },
      total_cost_usd: 0.01
    },
    null,
    2
  );

  const parsed = parseClaudeCodeJsonOutput(raw);
  assert.ok(parsed);
  assert.equal(parsed.text, "NO");
  assert.equal(parsed.isError, false);
});

test("parseClaudeCodeJsonOutput prefers structured_output over generic result text", () => {
  const raw = JSON.stringify({
    type: "result",
    is_error: false,
    result: "Done!",
    structured_output: { decision: "YES" },
    usage: {
      input_tokens: 2,
      output_tokens: 2,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0
    },
    total_cost_usd: 0.01
  });

  const parsed = parseClaudeCodeJsonOutput(raw);
  assert.ok(parsed);
  assert.equal(parsed.text, '{"decision":"YES"}');
  assert.equal(parsed.isError, false);
});

test("parseClaudeCodeStreamOutput prefers structured_output on result events", () => {
  const raw = JSON.stringify({
    type: "result",
    is_error: false,
    result: "Done!",
    structured_output: { answer: "yes", confidence: 0.5 },
    usage: {
      input_tokens: 3,
      output_tokens: 4,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0
    },
    total_cost_usd: 0.02
  });

  const parsed = parseClaudeCodeStreamOutput(raw);
  assert.ok(parsed);
  assert.equal(parsed.text, '{"answer":"yes","confidence":0.5}');
  assert.equal(parsed.isError, false);
});

test("createClaudeCliStreamSession accepts cwd without throwing", () => {
  const session = createClaudeCliStreamSession({
    args: buildClaudeCodeCliArgs({ model: "haiku" }),
    cwd: "/tmp/test-isolation"
  });
  assert.ok(session);
  assert.equal(typeof session.run, "function");
  assert.equal(typeof session.close, "function");
  assert.equal(typeof session.isIdle, "function");
  session.close();
});
