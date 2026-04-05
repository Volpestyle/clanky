import { MODEL_PROVIDER_KINDS } from "../../../../src/settings/settingsSchema.ts";

interface LlmProviderOption {
  value: string;
  label: string;
}

const LLM_PROVIDER_LABELS: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  ai_sdk_anthropic: "ai sdk anthropic",
  "claude-oauth": "claude oauth",
  "openai-oauth": "openai oauth",
  codex_cli_session: "codex cli session (local)",
  xai: "xai (grok)",
  codex: "codex api (remote)",
  "codex-cli": "codex cli (local)"
};

export const GENERAL_LLM_PROVIDER_OPTIONS: LlmProviderOption[] = MODEL_PROVIDER_KINDS.map((value) => ({
  value,
  label: LLM_PROVIDER_LABELS[value] || value
}));

export const VISION_LLM_PROVIDER_OPTIONS: LlmProviderOption[] = GENERAL_LLM_PROVIDER_OPTIONS.filter(
  (option) => ["openai", "anthropic", "ai_sdk_anthropic", "claude-oauth", "openai-oauth", "xai"].includes(option.value)
);

export const BROWSER_LLM_PROVIDER_OPTIONS: LlmProviderOption[] = GENERAL_LLM_PROVIDER_OPTIONS.filter(
  (option) => ["openai", "anthropic", "claude-oauth"].includes(option.value)
);

export function LlmProviderOptions({ options = GENERAL_LLM_PROVIDER_OPTIONS }: { options?: readonly LlmProviderOption[] }) {
  return (
    <>
      {options.map((provider) => (
        <option key={provider.value} value={provider.value}>
          {provider.label}
        </option>
      ))}
    </>
  );
}
