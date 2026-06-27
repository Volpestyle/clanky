/**
 * Clanky's conductor model on Google Gemini, an API-key-backed alternative to the
 * Codex/Claude subscription brains (SPEC.md §4.6). The key comes from
 * CLANKY_GEMINI_API_KEY, GEMINI_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY. eve's
 * persona flows through the normal system message; no provider-specific
 * middleware is required.
 */
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

export interface GeminiModelOptions {
	/** Gemini model id, e.g. "gemini-2.5-pro". */
	modelId: string;
	/** Resolved Gemini API key. */
	apiKey: string;
}

export function createGeminiModel(options: GeminiModelOptions): LanguageModel {
	if (options.apiKey.trim().length === 0) {
		throw new Error("Gemini API key missing: set CLANKY_GEMINI_API_KEY, GEMINI_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY");
	}
	const provider = createGoogleGenerativeAI({ apiKey: options.apiKey });
	return provider(options.modelId);
}
