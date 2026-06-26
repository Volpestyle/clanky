import { shouldRouteClankyTranscriptGlobalInput } from "../agent/lib/clanky-transcript-key-routing.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const idle = {
	commandPaletteFocused: false,
	editorAutocompleteOpen: false,
	editorText: "",
	setupWaiting: false,
	transcriptFocused: false,
};

assert(shouldRouteClankyTranscriptGlobalInput("\x1b[5~", idle), "page-up should route while prompt is empty");
assert(shouldRouteClankyTranscriptGlobalInput("\x1b[6~", idle), "page-down should route while prompt is empty");
assert(shouldRouteClankyTranscriptGlobalInput("\x1b[<64;10;5M", idle), "wheel-up should route while prompt is empty");
assert(shouldRouteClankyTranscriptGlobalInput("\x1b[<65;10;5M", idle), "wheel-down should route while prompt is empty");
assert(shouldRouteClankyTranscriptGlobalInput("\x1b[1;3A", idle), "alt-up should route while prompt is empty");

const withDraft = { ...idle, editorText: "draft prompt" };
assert(shouldRouteClankyTranscriptGlobalInput("\x1b[5~", withDraft), "page-up should route even with draft text");
assert(shouldRouteClankyTranscriptGlobalInput("\x1b[6~", withDraft), "page-down should route even with draft text");
assert(shouldRouteClankyTranscriptGlobalInput("\x1b[<64;10;5M", withDraft), "wheel-up should route even with draft text");
assert(shouldRouteClankyTranscriptGlobalInput("\x1b[<65;10;5M", withDraft), "wheel-down should route even with draft text");
assert(!shouldRouteClankyTranscriptGlobalInput("\x1b[1;3A", withDraft), "alt-up should not steal keys while editing");
assert(!shouldRouteClankyTranscriptGlobalInput("\x1b\r", withDraft), "alt-enter should not steal keys while editing");

assert(
	!shouldRouteClankyTranscriptGlobalInput("\x1b[5~", { ...idle, setupWaiting: true }),
	"setup prompts should own page-up",
);
assert(
	!shouldRouteClankyTranscriptGlobalInput("\x1b[5~", { ...idle, commandPaletteFocused: true }),
	"command palette should own page-up",
);
assert(
	!shouldRouteClankyTranscriptGlobalInput("\x1b[5~", { ...idle, editorAutocompleteOpen: true }),
	"editor autocomplete should own page-up",
);
assert(
	!shouldRouteClankyTranscriptGlobalInput("\x1b[<64;10;5M", { ...idle, editorAutocompleteOpen: true }),
	"editor autocomplete should own wheel-up",
);
assert(
	!shouldRouteClankyTranscriptGlobalInput("\x1b[5~", { ...idle, transcriptFocused: true }),
	"focused transcript mode should use focused-component handling",
);

console.log("clanky-transcript-key-routing-smoke: ok");
