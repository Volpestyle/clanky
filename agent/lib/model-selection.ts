import type { LanguageModel } from "ai";
import { createClaudeModel } from "./claude-model.ts";
import { type CodexReasoningEffort, createCodexModel } from "./codex-model.ts";
import { createLocalModel } from "./local-model.ts";

const CODEX_EFFORTS: readonly CodexReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];

export const DEFAULT_CODEX_MODEL = "gpt-5.4";
export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-5";
export const DEFAULT_LOCAL_MODEL = "qwen3-coder-next";
export const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:11434/v1";

export type ClankyModelProvider = "claude" | "codex" | "local";

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

export type ClankyModelSettings = ClankyCodexModelSettings | ClankyClaudeModelSettings | ClankyLocalModelSettings;

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
	}
}

export function createClankyModelFromEnv(env: NodeJS.ProcessEnv = process.env): LanguageModel {
	return createClankyModel(resolveClankyModelSettings(env));
}
