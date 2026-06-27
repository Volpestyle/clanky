/**
 * Clanky's conductor model on xAI (Grok), an API-key-backed alternative to the
 * Codex/Claude subscription brains (SPEC.md §4.6). Unlike codex/claude there is
 * no OAuth: the key comes from CLANKY_XAI_API_KEY or XAI_API_KEY (the same key
 * Clanky already uses for Discord voice realtime). eve's persona flows through
 * the normal system message, so no provider-specific middleware is needed.
 */
import { createXai } from "@ai-sdk/xai";
import type { LanguageModel } from "ai";

export interface XaiModelOptions {
	/** xAI model id, e.g. "grok-4". */
	modelId: string;
	/** Resolved xAI API key (CLANKY_XAI_API_KEY or XAI_API_KEY). */
	apiKey: string;
}

export function createXaiModel(options: XaiModelOptions): LanguageModel {
	if (options.apiKey.trim().length === 0) {
		throw new Error("xAI API key missing: set CLANKY_XAI_API_KEY or XAI_API_KEY");
	}
	const provider = createXai({ apiKey: options.apiKey });
	return provider(options.modelId);
}
