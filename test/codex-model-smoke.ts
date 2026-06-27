// End-to-end smoke for Clanky's Codex model lib: credential load + header fetch
// + instructions/store middleware + a real streamed completion. SPEC.md §4.6.
//
// Requires a valid openai-codex credential in the auth store
// (~/.clanky/profiles/default/auth.json or $CLANKY_CODEX_AUTH).
import { streamText } from "ai";
import { createCodexModel } from "../agent/lib/codex-model.ts";

const model = createCodexModel({
	modelId: process.env.CLANKY_CODEX_MODEL ?? "gpt-5.5",
	instructions: "You are a terse test harness. Follow the user exactly.",
});

let streamErr: unknown;
const result = streamText({
	model,
	system: "You are Clanky.",
	prompt: "Reply with exactly: CLANKY_OK",
	onError: (e) => {
		streamErr = (e as { error?: unknown })?.error ?? e;
	},
});

let out = "";
for await (const delta of result.textStream) out += delta;

if (streamErr) {
	console.error("FAIL:", String((streamErr as Error)?.message ?? streamErr).slice(0, 300));
	process.exit(1);
}
if (!out.includes("CLANKY_OK")) {
	console.error("FAIL: unexpected output ->", JSON.stringify(out));
	process.exit(1);
}
console.log("MODEL OK ->", JSON.stringify(out));
