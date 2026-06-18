import { defineAgent } from "eve";
import { createCodexModel } from "./lib/codex-model.ts";

// Clanky's conductor model runs on the user's OpenAI Codex subscription via
// OAuth (SPEC.md §4.6). Persona and operating rules live in instructions.md.
export default defineAgent({
	model: createCodexModel({
		modelId: process.env.CLANKY_CODEX_MODEL ?? "gpt-5.4",
		instructions:
			"You are Clanky, a personal always-on agent. Your full persona and operating rules are provided in the system prompt; follow them exactly.",
	}),
});
