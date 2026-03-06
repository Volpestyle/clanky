interface LlmProviderOption {
  value: string;
  label: string;
}

const LLM_PROVIDER_OPTIONS: LlmProviderOption[] = [
  { value: "openai", label: "openai" },
  { value: "anthropic", label: "anthropic" },
  { value: "claude_code_session", label: "claude code session" },
  { value: "codex_cli_session", label: "codex cli session" },
  { value: "xai", label: "xai (grok)" },
  { value: "claude-code", label: "claude code (local)" },
  { value: "codex-cli", label: "codex cli (local)" }
];

export function LlmProviderOptions() {
  return (
    <>
      {LLM_PROVIDER_OPTIONS.map((provider) => (
        <option key={provider.value} value={provider.value}>
          {provider.label}
        </option>
      ))}
    </>
  );
}
