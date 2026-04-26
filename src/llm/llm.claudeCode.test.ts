import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  buildClaudeCodeAgentArgs,
  buildClaudeCodeJsonCliArgs,
  buildClaudeCodeTextCliArgs,
  buildClaudeCodeSystemPrompt,
  parseClaudeCodeJsonOutput
} from "./llmClaudeCode.ts";

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
  assert.equal(args[args.indexOf("--output-format") + 1], "json");
  assert.equal(args[args.indexOf("--model") + 1], "opus");
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
  assert.equal(args[args.indexOf("--model") + 1], "opus");
  assert.equal(args[args.length - 1], "Hello there");
});

test("buildClaudeCodeAgentArgs builds one-shot swarm launcher args", () => {
  const mcpConfig = '{"swarm":{"type":"stdio","command":"bun","args":["run","/tmp/swarm.ts"],"env":{}}}';
  const args = buildClaudeCodeAgentArgs({
    model: "sonnet",
    prompt: "fix it",
    maxTurns: 12,
    mcpConfig
  });

  assert.equal(args[0], "-p");
  assert.equal(args[1], "fix it");
  assert.equal(args[args.indexOf("--model") + 1], "sonnet");
  assert.equal(args[args.indexOf("--max-turns") + 1], "12");
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
  assert.equal(args.includes("--verbose"), true);
  assert.equal(args.includes("--no-session-persistence"), true);
  assert.equal(args[args.indexOf("--mcp-config") + 1], mcpConfig);
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
