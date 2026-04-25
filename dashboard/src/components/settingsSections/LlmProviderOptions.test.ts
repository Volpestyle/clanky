import { test } from "bun:test";
import assert from "node:assert/strict";
import { MODEL_PROVIDER_KINDS } from "../../../../src/settings/settingsSchema.ts";
import {
  BROWSER_LLM_PROVIDER_OPTIONS,
  GENERAL_LLM_PROVIDER_OPTIONS,
  VISION_LLM_PROVIDER_OPTIONS,
  isProviderAuthAvailable
} from "./LlmProviderOptions.tsx";

test("general llm provider options match canonical settings providers", () => {
  const values = GENERAL_LLM_PROVIDER_OPTIONS.map((option) => option.value);
  assert.equal(new Set(values).size, values.length);
  assert.deepEqual(new Set(values), new Set(MODEL_PROVIDER_KINDS));
  assert.ok(!values.includes("claude_code_session"));
  assert.ok(!values.includes("claude-code"));
});

test("vision and browser provider options expose only supported subsets", () => {
  const generalValues = new Set(GENERAL_LLM_PROVIDER_OPTIONS.map((option) => option.value));
  const visionValues = VISION_LLM_PROVIDER_OPTIONS.map((option) => option.value);
  const browserValues = BROWSER_LLM_PROVIDER_OPTIONS.map((option) => option.value);

  for (const provider of visionValues) {
    assert.ok(generalValues.has(provider));
  }
  for (const provider of browserValues) {
    assert.ok(generalValues.has(provider));
  }

  assert.ok(visionValues.includes("openai"));
  assert.ok(visionValues.includes("anthropic"));
  assert.ok(!visionValues.includes("codex-cli"));
  assert.ok(!visionValues.includes("codex"));

  assert.ok(browserValues.includes("openai"));
  assert.ok(browserValues.includes("anthropic"));
  assert.ok(browserValues.includes("claude-oauth"));
  assert.ok(!browserValues.includes("xai"));
  assert.ok(!browserValues.includes("codex-cli"));
});

test("isProviderAuthAvailable treats null auth as fully available", () => {
  for (const provider of MODEL_PROVIDER_KINDS) {
    assert.equal(isProviderAuthAvailable(provider, null), true);
  }
});

test("isProviderAuthAvailable gates oauth providers behind their flags", () => {
  const noOauth = { claude_oauth: false, openai_oauth: false, anthropic: true, openai: true, xai: true, codex_cli: true };
  assert.equal(isProviderAuthAvailable("claude-oauth", noOauth), false);
  assert.equal(isProviderAuthAvailable("openai-oauth", noOauth), false);
  assert.equal(isProviderAuthAvailable("openai", noOauth), true);
  assert.equal(isProviderAuthAvailable("anthropic", noOauth), true);
  assert.equal(isProviderAuthAvailable("ai_sdk_anthropic", noOauth), true);
  assert.equal(isProviderAuthAvailable("xai", noOauth), true);
});

test("isProviderAuthAvailable maps codex variants to the codex_cli flag", () => {
  const noCodex = { codex_cli: false, openai: true };
  assert.equal(isProviderAuthAvailable("codex-cli", noCodex), false);
  assert.equal(isProviderAuthAvailable("codex_cli_session", noCodex), false);
  assert.equal(isProviderAuthAvailable("codex", noCodex), true);
});
