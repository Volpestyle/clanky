export type ClankyThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export const CLANKY_THINKING_LEVELS: readonly ClankyThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
];

export const DEFAULT_CLANKY_MODEL_PROVIDER = "openai";
export const DEFAULT_CLANKY_MODEL_ID = "gpt-5.5";
export const DEFAULT_CLANKY_MAIN_THINKING_LEVEL: ClankyThinkingLevel = "xhigh";
export const DEFAULT_CLANKY_SUBAGENT_THINKING_LEVEL: ClankyThinkingLevel = "medium";

export interface ClankyRuntimeDefaults {
	mainThinkingLevel: ClankyThinkingLevel;
	subagentThinkingLevel: ClankyThinkingLevel;
}

export function isClankyThinkingLevel(value: string): value is ClankyThinkingLevel {
	return CLANKY_THINKING_LEVELS.includes(value as ClankyThinkingLevel);
}
