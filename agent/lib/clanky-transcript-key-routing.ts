import {
	isClankyTranscriptMouseScrollInput,
	isClankyTranscriptPageScrollInput,
} from "./clanky-transcript-viewport.ts";

export type ClankyTranscriptGlobalInputState = {
	readonly commandPaletteFocused: boolean;
	readonly editorAutocompleteOpen: boolean;
	readonly editorText: string;
	readonly setupWaiting: boolean;
	readonly transcriptFocused: boolean;
};

export function shouldRouteClankyTranscriptGlobalInput(
	data: string,
	state: ClankyTranscriptGlobalInputState,
): boolean {
	if (state.setupWaiting || state.commandPaletteFocused) return false;
	if (state.transcriptFocused || state.editorAutocompleteOpen) return false;
	if (state.editorText.length === 0) return true;
	return isClankyTranscriptPageScrollInput(data) || isClankyTranscriptMouseScrollInput(data);
}
