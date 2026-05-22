import type { Platform } from "./types.ts";

export interface RuntimeFooterInput {
	platform: Platform;
	model?: string;
	provider?: string;
	durationMs?: number;
	chunks?: number;
	tokensUsed?: number;
}

export interface RuntimeFooterConfig {
	enabled: boolean;
	includeModel: boolean;
	includeDuration: boolean;
	includeChunks: boolean;
	includeTokens: boolean;
	template?: string;
}

export const DEFAULT_FOOTER_CONFIG: RuntimeFooterConfig = {
	enabled: false,
	includeModel: true,
	includeDuration: true,
	includeChunks: false,
	includeTokens: false,
};

export function buildRuntimeFooter(input: RuntimeFooterInput, config: RuntimeFooterConfig): string | undefined {
	if (!config.enabled) return undefined;
	if (config.template !== undefined) return renderTemplate(config.template, input);
	const parts: string[] = [];
	if (config.includeModel && input.model !== undefined) {
		const provider = input.provider === undefined ? "" : `${input.provider}/`;
		parts.push(`model: ${provider}${input.model}`);
	}
	if (config.includeDuration && input.durationMs !== undefined) {
		parts.push(`took: ${formatDuration(input.durationMs)}`);
	}
	if (config.includeChunks && input.chunks !== undefined) {
		parts.push(`chunks: ${input.chunks}`);
	}
	if (config.includeTokens && input.tokensUsed !== undefined) {
		parts.push(`tokens: ${input.tokensUsed}`);
	}
	if (parts.length === 0) return undefined;
	return `\n\n— ${parts.join(" · ")}`;
}

export function appendRuntimeFooter(text: string, input: RuntimeFooterInput, config: RuntimeFooterConfig): string {
	const footer = buildRuntimeFooter(input, config);
	if (footer === undefined) return text;
	return `${text}${footer}`;
}

function renderTemplate(template: string, input: RuntimeFooterInput): string {
	return template
		.replace("{model}", input.model ?? "")
		.replace("{provider}", input.provider ?? "")
		.replace("{platform}", input.platform)
		.replace("{duration}", input.durationMs === undefined ? "" : formatDuration(input.durationMs))
		.replace("{chunks}", input.chunks === undefined ? "" : String(input.chunks))
		.replace("{tokens}", input.tokensUsed === undefined ? "" : String(input.tokensUsed));
}

function formatDuration(ms: number): string {
	if (ms < 1_000) return `${ms}ms`;
	const seconds = ms / 1_000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = Math.floor(seconds % 60);
	return `${minutes}m${remainder}s`;
}
