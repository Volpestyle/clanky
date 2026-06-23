/**
 * Clanky's conductor model on a LOCAL OpenAI-compatible endpoint (SPEC.md §4.6,
 * opt-in alternative to the Codex subscription). The endpoint can be either:
 *   - a single local model, e.g. Qwen3-Coder-Next via MLX / llama-server /
 *     Ollama, or
 *   - a self-hosted orchestrator that fronts a local model pool (e.g. OpenFugu
 *     or Maestro), which also exposes one OpenAI-compatible /v1.
 * Either way it is just a base URL + model id to Clanky.
 *
 * Unlike codex-model.ts this speaks Chat Completions (not the Responses API) and
 * needs no auth or Codex-specific middleware: eve's persona flows through the
 * normal system message. Tool-call reliability depends on the SERVER being run
 * with tool parsing enabled (e.g. llama-server --jinja, or Ollama's OpenAI API).
 */
import { createOpenAI } from "@ai-sdk/openai";
import { wrapLanguageModel, type LanguageModel } from "ai";

export interface LocalModelOptions {
	/** Local model id as the server names it, e.g. "qwen3-coder-next". */
	modelId: string;
	/**
	 * OpenAI-compatible base URL. Common defaults:
	 *   http://127.0.0.1:8080/v1  (llama-server)
	 *   http://127.0.0.1:11434/v1 (Ollama)
	 *   http://127.0.0.1:1234/v1  (LM Studio)
	 */
	baseURL: string;
	/**
	 * Provider tag surfaced in model ids (e.g. the TUI status line shows
	 * "<providerName>/<model>"). Defaults to "ollama"; set to match the actual
	 * backend (e.g. "lmstudio", "llamacpp") when not using Ollama.
	 */
	providerName?: string;
	/**
	 * Reasoning effort (low/medium/high) forwarded to the server as
	 * `reasoning_effort`, honored by thinking models like GLM-4.7-Flash. Omit for
	 * non-thinking models or to use the server default.
	 */
	reasoningEffort?: string;
}

/**
 * Build a LanguageModel backed by a local OpenAI-compatible server. No OAuth and
 * no Codex-style middleware: local endpoints implement Chat Completions, so the
 * system message carries Clanky's persona natively.
 */
export function createLocalModel(options: LocalModelOptions): LanguageModel {
	const provider = createOpenAI({
		baseURL: options.baseURL,
		// Local servers ignore the key; the AI SDK requires a non-empty string.
		apiKey: "local",
		// Override the default "openai" provider tag so the model id surfaces as
		// "<providerName>/<model>" (e.g. in the TUI status line), not a misleading
		// "openai/". Defaults to "ollama" (the default backend).
		name: options.providerName ?? "ollama",
	});
	// .chat() — local endpoints speak Chat Completions, not the Responses API.
	const model = provider.chat(options.modelId);
	if (options.reasoningEffort === undefined) return model;
	// Thread reasoning effort through as providerOptions.openai.reasoningEffort,
	// which @ai-sdk/openai forwards as the `reasoning_effort` request field.
	const reasoningEffort = options.reasoningEffort;
	return wrapLanguageModel({
		model,
		middleware: {
			transformParams: async ({ params }) => {
				const providerOptions = params.providerOptions ?? {};
				const openai = { ...(providerOptions.openai ?? {}) };
				if (openai.reasoningEffort === undefined) openai.reasoningEffort = reasoningEffort;
				return { ...params, providerOptions: { ...providerOptions, openai } };
			},
		},
	});
}
