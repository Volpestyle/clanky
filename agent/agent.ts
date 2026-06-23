import type { LanguageModel } from "ai";
import { defineAgent } from "eve";
import { createClaudeModel } from "./lib/claude-model.ts";
import { type CodexReasoningEffort, createCodexModel } from "./lib/codex-model.ts";
import { createLocalModel } from "./lib/local-model.ts";

const CODEX_EFFORTS: readonly CodexReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];

function resolveCodexEffort(value: string | undefined): CodexReasoningEffort | undefined {
	return CODEX_EFFORTS.find((effort) => effort === value);
}

// Clanky's conductor model runs on one of the user's AI subscriptions via OAuth
// (SPEC.md §4.6). Default: OpenAI Codex. CLANKY_MODEL_PROVIDER selects another:
//   claude - Claude Pro/Max subscription (CLANKY_CLAUDE_MODEL)
//   local  - any local OpenAI-compatible server (CLANKY_LOCAL_MODEL,
//            CLANKY_LOCAL_BASE_URL): a single model, e.g. Qwen3-Coder-Next via
//            MLX / llama-server / Ollama, OR a self-hosted orchestrator such as
//            OpenFugu / Maestro routing across a local model pool.
// CLANKY_CODEX_MODEL picks the codex model (e.g. gpt-5.5) and CLANKY_CODEX_EFFORT
// the reasoning effort. CLANKY_LOCAL_EFFORT sets the reasoning effort for thinking
// local models (forwarded as reasoning_effort). Persona lives in instructions.md.
function selectModel(): LanguageModel {
	switch (process.env.CLANKY_MODEL_PROVIDER ?? "codex") {
		case "claude":
			return createClaudeModel({ modelId: process.env.CLANKY_CLAUDE_MODEL ?? "claude-sonnet-4-5" });

		case "local":
			return createLocalModel({
				modelId: process.env.CLANKY_LOCAL_MODEL ?? "qwen3-coder-next",
				baseURL: process.env.CLANKY_LOCAL_BASE_URL ?? "http://127.0.0.1:11434/v1",
				providerName: process.env.CLANKY_LOCAL_PROVIDER_NAME,
				reasoningEffort: process.env.CLANKY_LOCAL_EFFORT,
			});

		default:
			return createCodexModel({
				modelId: process.env.CLANKY_CODEX_MODEL ?? "gpt-5.4",
				reasoningEffort: resolveCodexEffort(process.env.CLANKY_CODEX_EFFORT),
				instructions:
					"You are Clanky, a personal always-on agent. Your full persona and operating rules are provided in the system prompt; follow them exactly.",
			});
	}
}

// Local models aren't in eve's AI Gateway catalog, so eve can't resolve their
// context window to compile compaction and refuses to start. Supply it via the
// modelContextWindowTokens escape hatch. Default 32768; override with
// CLANKY_LOCAL_CONTEXT_TOKENS to match the server's configured context (e.g.
// Ollama num_ctx). Codex/claude resolve via the gateway, so leave it unset.
function localContextWindowTokens(): number | undefined {
	if ((process.env.CLANKY_MODEL_PROVIDER ?? "codex") !== "local") return undefined;
	const parsed = Number.parseInt(process.env.CLANKY_LOCAL_CONTEXT_TOKENS ?? "", 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : 32768;
}

const modelContextWindowTokens = localContextWindowTokens();

export default defineAgent(
	modelContextWindowTokens === undefined
		? { model: selectModel() }
		: { model: selectModel(), modelContextWindowTokens },
);
