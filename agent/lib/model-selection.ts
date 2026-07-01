import type { LanguageModel } from "ai";
import { createClaudeModel } from "./claude-model.ts";
import { type CodexReasoningEffort, createCodexModel } from "./codex-model.ts";
import { createGeminiModel } from "./gemini-model.ts";
import { createLocalModel } from "./local-model.ts";
import { createXaiModel } from "./xai-model.ts";

const CODEX_EFFORTS: readonly CodexReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];

// Model defaults live in config-defaults.ts (the single source; bump there).
// Re-exported here because this module is the agent-side entrypoint for model
// selection and existing importers reference these names.
export {
	DEFAULT_CLAUDE_MODEL,
	DEFAULT_CODEX_MODEL,
	DEFAULT_GEMINI_MODEL,
	DEFAULT_LOCAL_BASE_URL,
	DEFAULT_LOCAL_MODEL,
	DEFAULT_XAI_MODEL,
} from "./config-defaults.ts";
import {
	DEFAULT_CLAUDE_MODEL,
	DEFAULT_CODEX_MODEL,
	DEFAULT_GEMINI_MODEL,
	DEFAULT_LOCAL_BASE_URL,
	DEFAULT_LOCAL_MODEL,
	DEFAULT_XAI_MODEL,
	firstEnvValue,
	GEMINI_API_KEY_ENV_NAMES,
	XAI_API_KEY_ENV_NAMES,
} from "./config-defaults.ts";

export type ClankyModelProvider = "claude" | "codex" | "local" | "xai" | "gemini";

// xAI and Gemini brains aren't in eve's AI Gateway catalog, so eve can't resolve
// their context window to compile compaction (same gap as local models). Supply a
// conservative per-model context window, env-overridable via CLANKY_XAI_CONTEXT_TOKENS /
// CLANKY_GEMINI_CONTEXT_TOKENS. Conservative-low is safe: it triggers compaction
// earlier rather than overflowing the real window.
const DEFAULT_XAI_CONTEXT_TOKENS = 131_072;
const DEFAULT_GEMINI_CONTEXT_TOKENS = 1_048_576;
const XAI_CONTEXT_TOKENS: Record<string, number> = {
	"grok-4": 256_000,
	"grok-4-fast": 256_000,
	"grok-3": 131_072,
};
const GEMINI_CONTEXT_TOKENS: Record<string, number> = {
	"gemini-2.5-pro": 1_048_576,
	"gemini-2.5-flash": 1_048_576,
	"gemini-3-pro": 1_048_576,
};

function parsePositiveTokens(value: string | undefined): number | undefined {
	const raw = value?.trim();
	if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
	const parsed = Number.parseInt(raw, 10);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Context window (tokens) for the selected brain when eve can't resolve it from
 * the AI Gateway catalog. Returns a value only for xai/gemini; local is handled
 * by localContextWindowTokensFromEnv and catalog providers (codex/claude) return
 * undefined so eve uses its own metadata.
 */
export function brainContextWindowTokensFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
	const provider = env.CLANKY_MODEL_PROVIDER ?? "codex";
	if (provider === "xai") {
		const modelId = env.CLANKY_XAI_MODEL ?? DEFAULT_XAI_MODEL;
		return parsePositiveTokens(env.CLANKY_XAI_CONTEXT_TOKENS) ?? XAI_CONTEXT_TOKENS[modelId] ?? DEFAULT_XAI_CONTEXT_TOKENS;
	}
	if (provider === "gemini") {
		const modelId = env.CLANKY_GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;
		return parsePositiveTokens(env.CLANKY_GEMINI_CONTEXT_TOKENS) ?? GEMINI_CONTEXT_TOKENS[modelId] ?? DEFAULT_GEMINI_CONTEXT_TOKENS;
	}
	return undefined;
}

/** Resolve the xAI API key (shared with Discord voice realtime). */
export function resolveXaiApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return firstEnvValue(XAI_API_KEY_ENV_NAMES, env);
}

/** Resolve the Gemini API key from any of the accepted env names. */
export function resolveGeminiApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return firstEnvValue(GEMINI_API_KEY_ENV_NAMES, env);
}

export interface ClankyCodexModelSettings {
	provider: "codex";
	modelId: string;
	reasoningEffort?: CodexReasoningEffort;
}

export interface ClankyClaudeModelSettings {
	provider: "claude";
	modelId: string;
}

export interface ClankyLocalModelSettings {
	provider: "local";
	modelId: string;
	baseURL: string;
	providerName?: string;
	reasoningEffort?: string;
}

export interface ClankyXaiModelSettings {
	provider: "xai";
	modelId: string;
	apiKey?: string;
}

export interface ClankyGeminiModelSettings {
	provider: "gemini";
	modelId: string;
	apiKey?: string;
}

export type ClankyModelSettings =
	| ClankyCodexModelSettings
	| ClankyClaudeModelSettings
	| ClankyLocalModelSettings
	| ClankyXaiModelSettings
	| ClankyGeminiModelSettings;

export function resolveCodexEffort(value: string | undefined): CodexReasoningEffort | undefined {
	return CODEX_EFFORTS.find((effort) => effort === value);
}

export function resolveClankyModelSettings(env: NodeJS.ProcessEnv = process.env): ClankyModelSettings {
	switch (env.CLANKY_MODEL_PROVIDER ?? "codex") {
		case "claude":
			return {
				provider: "claude",
				modelId: env.CLANKY_CLAUDE_MODEL ?? DEFAULT_CLAUDE_MODEL,
			};

		case "local": {
			const settings: ClankyLocalModelSettings = {
				provider: "local",
				modelId: env.CLANKY_LOCAL_MODEL ?? DEFAULT_LOCAL_MODEL,
				baseURL: env.CLANKY_LOCAL_BASE_URL ?? DEFAULT_LOCAL_BASE_URL,
			};
			const providerName = env.CLANKY_LOCAL_PROVIDER_NAME?.trim();
			const reasoningEffort = env.CLANKY_LOCAL_EFFORT?.trim();
			if (providerName !== undefined && providerName.length > 0) settings.providerName = providerName;
			if (reasoningEffort !== undefined && reasoningEffort.length > 0) settings.reasoningEffort = reasoningEffort;
			return settings;
		}

		case "xai": {
			const settings: ClankyXaiModelSettings = {
				provider: "xai",
				modelId: env.CLANKY_XAI_MODEL ?? DEFAULT_XAI_MODEL,
			};
			const apiKey = resolveXaiApiKey(env);
			if (apiKey !== undefined) settings.apiKey = apiKey;
			return settings;
		}

		case "gemini": {
			const settings: ClankyGeminiModelSettings = {
				provider: "gemini",
				modelId: env.CLANKY_GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL,
			};
			const apiKey = resolveGeminiApiKey(env);
			if (apiKey !== undefined) settings.apiKey = apiKey;
			return settings;
		}

		default: {
			const settings: ClankyCodexModelSettings = {
				provider: "codex",
				modelId: env.CLANKY_CODEX_MODEL ?? DEFAULT_CODEX_MODEL,
			};
			const reasoningEffort = resolveCodexEffort(env.CLANKY_CODEX_EFFORT);
			if (reasoningEffort !== undefined) settings.reasoningEffort = reasoningEffort;
			return settings;
		}
	}
}

export function createClankyModel(settings: ClankyModelSettings): LanguageModel {
	switch (settings.provider) {
		case "claude":
			return createClaudeModel({ modelId: settings.modelId });

		case "local":
			return createLocalModel({
				modelId: settings.modelId,
				baseURL: settings.baseURL,
				providerName: settings.providerName,
				reasoningEffort: settings.reasoningEffort,
			});

		case "codex":
			return createCodexModel({
				modelId: settings.modelId,
				reasoningEffort: settings.reasoningEffort,
				instructions:
					"You are Clanky, a personal always-on agent. Your full persona and operating rules are provided in the system prompt; follow them exactly.",
			});

		case "xai":
			return createXaiModel({ modelId: settings.modelId, apiKey: settings.apiKey ?? "" });

		case "gemini":
			return createGeminiModel({ modelId: settings.modelId, apiKey: settings.apiKey ?? "" });
	}
}

export function createClankyModelFromEnv(env: NodeJS.ProcessEnv = process.env): LanguageModel {
	return createClankyModel(resolveClankyModelSettings(env));
}
