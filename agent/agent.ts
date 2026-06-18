import type { LanguageModel } from "ai";
import { defineAgent } from "eve";
import { createClaudeModel } from "./lib/claude-model.ts";
import { createCodexModel } from "./lib/codex-model.ts";

// Clanky's conductor model runs on one of the user's AI subscriptions via OAuth
// (SPEC.md §4.6). Default: OpenAI Codex. Set CLANKY_MODEL_PROVIDER=claude to run
// on the Claude Pro/Max subscription instead. Persona lives in instructions.md.
function selectModel(): LanguageModel {
	if ((process.env.CLANKY_MODEL_PROVIDER ?? "codex") === "claude") {
		return createClaudeModel({ modelId: process.env.CLANKY_CLAUDE_MODEL ?? "claude-sonnet-4-5" });
	}
	return createCodexModel({
		modelId: process.env.CLANKY_CODEX_MODEL ?? "gpt-5.4",
		instructions:
			"You are Clanky, a personal always-on agent. Your full persona and operating rules are provided in the system prompt; follow them exactly.",
	});
}

export default defineAgent({ model: selectModel() });
