import { resolveClankyChromeMouseTarget } from "../agent/lib/clanky-face-layout.ts";
import { ClankyChromeSelectableComponent, ClankyChromeSelection } from "../agent/lib/clanky-chrome-selection.ts";
import type { Component, Focusable } from "@earendil-works/pi-tui";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const layout = {
	bannerRows: 6,
	transcriptRows: 14,
	statusRows: 1,
	typeaheadRows: 0,
	editorRows: 3,
	terminalRows: 24,
} as const;

// Banner header band: a click on row 2 maps to band-local row 1.
const bannerHit = resolveClankyChromeMouseTarget({ ...layout, mouseRow: 2, mouseCol: 5 });
assert(bannerHit?.band === "banner" && bannerHit.row === 1 && bannerHit.col === 4, "banner row maps to band-local coordinates");

// Transcript band owns its own selection, so chrome resolution returns null there.
const transcriptMiss = resolveClankyChromeMouseTarget({ ...layout, mouseRow: 10, mouseCol: 1 });
assert(transcriptMiss === null, "transcript band is not a chrome selection target");

// Status footer band sits just below the transcript.
const statusHit = resolveClankyChromeMouseTarget({ ...layout, mouseRow: 21, mouseCol: 3 });
assert(statusHit?.band === "status" && statusHit.row === 0, "status row resolves to the status band");

// Editor rows are left to the editor's own input handling.
const editorMiss = resolveClankyChromeMouseTarget({ ...layout, mouseRow: 24, mouseCol: 1 });
assert(editorMiss === null, "editor band is not a chrome selection target");

// Typeahead band only resolves when it has rows.
const withTypeahead = { ...layout, typeaheadRows: 2, terminalRows: 26 } as const;
const typeaheadHit = resolveClankyChromeMouseTarget({ ...withTypeahead, mouseRow: 22, mouseCol: 1 });
assert(typeaheadHit?.band === "typeahead" && typeaheadHit.row === 0, "typeahead rows resolve when present");

// Selection over a wrapped banner: drag across two rows and read back the text.
const bannerLines = ["clanky robot", "eve conductor", "herdr stage"];
const inner: Component = { invalidate() {}, render: () => [...bannerLines] };
const selection = new ClankyChromeSelection();
const wrapped = new ClankyChromeSelectableComponent(inner, "banner", selection);
wrapped.render(80); // capture band lines

selection.press("banner", 0, 0);
selection.drag("banner", 1, 13);
assert(selection.hasSelection(), "a multi-row drag is a real selection");
const painted = wrapped.render(80);
assert(painted[0]?.includes("\x1b[7m") === true, "the selected banner rows render the inverse highlight");
assert(selection.getSelectedText() === "clanky robot\neve conductor", "selection copies the dragged banner text");

// Cross-band drag is clamped to the originating band.
selection.drag("status", 5, 5);
assert(selection.getSelectedText() === "clanky robot\neve conductor", "dragging into another band does not extend the selection");

// A zero-width press is not a selection and copies nothing.
selection.press("banner", 0, 0);
assert(!selection.hasSelection(), "a bare click is not a selection");
assert(selection.getSelectedText() === "", "a bare click copies nothing");

selection.clear();
assert(!selection.isActive(), "clearing drops the selection");
assert(wrapped.render(80).every((line) => !line.includes("\x1b[7m")), "cleared selection renders without highlight");

let handledInput = "";
let invalidated = false;
const focusableInner: Component & Focusable = {
	focused: false,
	handleInput(data: string): void {
		handledInput += data;
	},
	invalidate(): void {
		invalidated = true;
	},
	render: () => ["choose codex", "choose claude"],
};
const modal = new ClankyChromeSelectableComponent(focusableInner, "modal", selection);
modal.focused = true;
assert(focusableInner.focused, "selectable wrapper forwards focus to focusable modal content");
modal.handleInput("x");
assert(handledInput === "x", "selectable wrapper forwards input to modal content");
modal.invalidate();
assert(invalidated, "selectable wrapper forwards invalidation to modal content");

modal.render(80);
selection.press("modal", 0, 0);
selection.drag("modal", 1, 13);
assert(selection.getSelectedText() === "choose codex\nchoose claude", "modal selection copies rendered menu text");
selection.clearBand("modal");
assert(!selection.isActive(), "clearing the modal band drops modal selection");

console.log("clanky-chrome-selection-smoke: ok");
