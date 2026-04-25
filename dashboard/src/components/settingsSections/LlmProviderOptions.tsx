import { createContext, useContext, useMemo } from "react";
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

export type ProviderAuthState = {
  anthropic?: boolean;
  openai?: boolean;
  claude_oauth?: boolean;
  openai_oauth?: boolean;
  xai?: boolean;
  codex_cli?: boolean;
};

const ProviderAuthContext = createContext<ProviderAuthState | null>(null);

export function ProviderAuthProvider({ value, children }: { value: ProviderAuthState; children: React.ReactNode }) {
  const memo = useMemo(() => value, [
    value.anthropic, value.openai, value.claude_oauth, value.openai_oauth, value.xai, value.codex_cli
  ]);
  return <ProviderAuthContext.Provider value={memo}>{children}</ProviderAuthContext.Provider>;
}

/** Map a MODEL_PROVIDER_KINDS value to the providerAuth boolean that gates it. */
export function isProviderAuthAvailable(providerKind: string, auth: ProviderAuthState | null): boolean {
  if (!auth) return true;
  switch (providerKind) {
    case "openai": return auth.openai !== false;
    case "anthropic": return auth.anthropic !== false;
    case "ai_sdk_anthropic": return auth.anthropic !== false;
    case "claude-oauth": return auth.claude_oauth !== false;
    case "openai-oauth": return auth.openai_oauth !== false;
    case "xai": return auth.xai !== false;
    case "codex": return auth.openai !== false;
    case "codex-cli": return auth.codex_cli !== false;
    case "codex_cli_session": return auth.codex_cli !== false;
    default: return true;
  }
}

export function LlmProviderOptions({ options = GENERAL_LLM_PROVIDER_OPTIONS }: { options?: readonly LlmProviderOption[] }) {
  const auth = useContext(ProviderAuthContext);
  return (
    <>
      {options.map((provider) => {
        const available = isProviderAuthAvailable(provider.value, auth);
        return (
          <option key={provider.value} value={provider.value} disabled={!available}>
            {available ? provider.label : `${provider.label} (not configured)`}
          </option>
        );
      })}
    </>
  );
}
