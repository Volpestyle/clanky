/**
 * Single source for Clanky's model defaults and API-key env-name lists.
 *
 * These constants were previously declared independently in
 * agent/lib/model-selection.ts, scripts/clanky/config-data.ts, bin/clanky.ts,
 * and scripts/clanky-up.ts and drifted. Every other module must import (or
 * re-export) from here; when a newer flagship model ships, bump it in this file
 * only (see AGENTS.md "Custom Face / TUI").
 *
 * Keep this module dependency-free so the CLI entrypoints can import it without
 * pulling in AI SDK packages.
 */

export const DEFAULT_CODEX_MODEL = "gpt-5.5";
export const DEFAULT_CLAUDE_MODEL = "claude-opus-4-8";
export const DEFAULT_LOCAL_MODEL = "qwen3-coder-next";
export const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:11434/v1";
export const DEFAULT_XAI_MODEL = "grok-4";
export const DEFAULT_GEMINI_MODEL = "gemini-3-pro";
/** OpenAI fallback vision model for media_inspect when no override is set. */
export const DEFAULT_OPENAI_VISION_MODEL = "gpt-5.4-mini";

/** Accepted env names per API key, in precedence order (first match wins). */
export const XAI_API_KEY_ENV_NAMES = ["CLANKY_XAI_API_KEY", "XAI_API_KEY"] as const;
export const GEMINI_API_KEY_ENV_NAMES = [
	"CLANKY_GEMINI_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_GENERATIVE_AI_API_KEY",
] as const;
export const OPENAI_API_KEY_ENV_NAMES = ["CLANKY_OPENAI_API_KEY", "OPENAI_API_KEY"] as const;
export const ELEVENLABS_API_KEY_ENV_NAMES = ["CLANKY_ELEVENLABS_API_KEY", "ELEVENLABS_API_KEY"] as const;

/** "A or B" / "A, B, or C" for user-facing missing-key messages. */
export function formatEnvNameAlternatives(names: readonly string[]): string {
	if (names.length <= 1) return names[0] ?? "";
	if (names.length === 2) return `${names[0]} or ${names[1]}`;
	return `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`;
}

/** First non-empty value among the env names, checking `env` then `fileEnv`. */
export function firstEnvValue(
	names: readonly string[],
	env: NodeJS.ProcessEnv,
	fileEnv: Record<string, string | undefined> = {},
): string | undefined {
	for (const name of names) {
		const value = env[name]?.trim() || fileEnv[name]?.trim();
		if (value !== undefined && value.length > 0) return value;
	}
	return undefined;
}
