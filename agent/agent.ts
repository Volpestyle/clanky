import { defineAgent } from "eve";
import { localContextWindowTokensFromEnv } from "./lib/local-context.ts";
import { createClankyModelFromEnv } from "./lib/model-selection.ts";

// Clanky's conductor model runs on one of the user's AI subscriptions via OAuth
// (SPEC.md §4.6). Default: OpenAI Codex. CLANKY_MODEL_PROVIDER selects another:
//   claude - Claude Pro/Max subscription (CLANKY_CLAUDE_MODEL)
//   local  - any local OpenAI-compatible server (CLANKY_LOCAL_MODEL,
//            CLANKY_LOCAL_BASE_URL): a single model, e.g. Qwen3-Coder-Next via
//            MLX / llama-server / Ollama, OR a self-hosted orchestrator such as
//            OpenFugu / Maestro routing across a local model pool.
// CLANKY_CODEX_MODEL picks the codex model (e.g. gpt-5.5) and CLANKY_CODEX_EFFORT
// the reasoning effort. CLANKY_LOCAL_EFFORT sets the reasoning effort for thinking
// local models (forwarded as reasoning_effort). CLANKY_LOCAL_VISION_MODEL can
// route media_inspect to a separate local Ollama vision model. Persona lives in
// instructions.md.

// Local models aren't in eve's AI Gateway catalog, so eve can't resolve their
// context window to compile compaction. The face auto-injects this env var from
// Ollama metadata when it owns the server; direct eve starts keep a 32K fallback.
const modelContextWindowTokens = localContextWindowTokensFromEnv(process.env);

export default defineAgent(
	modelContextWindowTokens === undefined
		? { model: createClankyModelFromEnv() }
		: { model: createClankyModelFromEnv(), modelContextWindowTokens },
);
