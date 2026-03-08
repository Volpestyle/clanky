import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  BROWSER_LLM_PROVIDER_OPTIONS,
  GENERAL_LLM_PROVIDER_OPTIONS,
  VISION_LLM_PROVIDER_OPTIONS
} from "./LlmProviderOptions.tsx";

test("general llm provider options match canonical settings providers", () => {
  const values = GENERAL_LLM_PROVIDER_OPTIONS.map((option) => option.value);
  assert.deepEqual(values, [
    "openai",
    "anthropic",
    "ai_sdk_anthropic",
    "litellm",
    "claude-oauth",
    "codex-oauth",
    "codex_cli_session",
    "xai",
    "codex",
    "codex-cli"
  ]);
  assert.ok(!values.includes("claude_code_session"));
  assert.ok(!values.includes("claude-code"));
});

test("vision and browser provider options expose only supported subsets", () => {
  assert.deepEqual(
    VISION_LLM_PROVIDER_OPTIONS.map((option) => option.value),
    ["openai", "anthropic", "ai_sdk_anthropic", "litellm", "claude-oauth", "codex-oauth", "xai"]
  );
  assert.deepEqual(
    BROWSER_LLM_PROVIDER_OPTIONS.map((option) => option.value),
    ["openai", "anthropic", "claude-oauth"]
  );
});
