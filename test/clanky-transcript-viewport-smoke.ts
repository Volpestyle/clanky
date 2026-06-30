import { CURSOR_MARKER, visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
	ClankyTranscriptViewport,
	clankyScrollbarWindowStartForRow,
	clankyTranscriptMouseScrollDirection,
	computeClankyScrollbarColumn,
	isClankySgrMouseInput,
	isClankyTranscriptMouseScrollInput,
	isClankyTranscriptPageScrollInput,
	UNICODE_SCROLLBAR_GLYPHS,
} from "../agent/lib/clanky-transcript-viewport.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

class LineComponent implements Component {
	private lines: readonly string[];

	constructor(lines: readonly string[]) {
		this.lines = lines;
	}

	setLines(lines: readonly string[]): void {
		this.lines = lines;
	}

	invalidate(): void {}

	render(): string[] {
		return [...this.lines];
	}
}

function assertFits(lines: readonly string[], width: number): void {
	for (const line of lines) assert(visibleWidth(line) <= width, `line exceeded ${width}: ${JSON.stringify(line)}`);
}

function plain(lines: readonly string[]): string[] {
	return lines.map((line) => line.replace(CURSOR_MARKER, "").replace(/\x1b\[[0-9;]*m/gu, "").trimEnd());
}

// Like plain(), but also drops the trailing scrollbar gutter glyph so content can
// be compared independently of the bar.
function plainContent(lines: readonly string[]): string[] {
	return lines.map((line) => line.replace(CURSOR_MARKER, "").replace(/\x1b\[[0-9;]*m/gu, "").replace(/[█▀▄│ ]+$/u, ""));
}

let maxRows = 5;
const viewport = new ClankyTranscriptViewport(() => maxRows, {
	dim: (text) => text,
	selected: (text) => text,
});
const first = new LineComponent(["one", "two"]);
const second = new LineComponent(["three", "four", "five", "six"]);

viewport.addChild(first);
const secondHandle = viewport.addChild(second);

assert(plain(viewport.render(80)).join("|") === "two|three|four|five|six", "viewport should show newest rows by default");
assertFits(viewport.render(80), 80);

viewport.scroll(99, 80);
assert(plain(viewport.render(80)).join("|") === "one|two|three|four|five", "viewport should scroll back through older rows");

const third = new LineComponent(["seven"]);
viewport.addChild(third);
assert(!plain(viewport.render(80)).join("|").includes("seven"), "new blocks should not force-follow while user is scrolled back");

secondHandle.scrollIntoView();
secondHandle.toggleCollapsed();
const collapsedRows = plain(viewport.render(80));
assert(collapsedRows.some((line) => line.includes("three")), "collapsed block should keep its first line visible");
assert(collapsedRows.some((line) => line.includes("hidden lines")), "collapsed block should summarize hidden lines");

second.setLines(["updated", "body"]);
secondHandle.setCollapsed(false);
secondHandle.scrollIntoView();
assert(plain(viewport.render(80)).some((line) => line.includes("updated")), "updated child components should re-render through stable handles");

viewport.focused = true;
assert(viewport.render(80).some((line) => line.includes(CURSOR_MARKER)), "focused viewport should render a cursor marker on the selected block");

viewport.handleInput("\x1b[B");
assert(plain(viewport.render(80)).some((line) => line.startsWith("> seven")), "down should move block focus");
viewport.handleInput("\r");
assert(plain(viewport.render(80)).some((line) => line.startsWith("> seven")), "enter should keep single-line selected blocks stable");

viewport.scrollToBottom();
secondHandle.remove();
assert(!plain(viewport.render(80)).join("|").includes("updated"), "removing a transient component should remove its rows");

maxRows = 1;
viewport.addChild(new LineComponent(["eight", "nine"]));
assert(plain(viewport.render(80)).join("|") === "  nine", "viewport should respect a smaller dynamic row budget");

maxRows = 3;
const globalViewport = new ClankyTranscriptViewport(() => maxRows, {
	dim: (text) => text,
	selected: (text) => text,
});
globalViewport.addChild(new LineComponent(["a1", "a2"]));
globalViewport.addChild(new LineComponent(["b1", "b2"]));
globalViewport.addChild(new LineComponent(["c1", "c2"]));
assert(globalViewport.handleGlobalInput("\x1b[5~"), "global page-up should be handled");
assert(plain(globalViewport.render(80)).join("|") === "a2|b1|b2", "global page-up should scroll transcript rows");
assert(globalViewport.handleGlobalInput("\x1b[6~"), "global page-down should be handled");
assert(plain(globalViewport.render(80)).join("|") === "b2|c1|c2", "global page-down should return toward newest rows");
assert(globalViewport.handleGlobalInput("\x1b[1;3A"), "global alt-up should be handled");
globalViewport.focused = true;
assert(plain(globalViewport.render(80)).some((line) => line.startsWith("> b1")), "global alt-up should select the previous block");
assert(globalViewport.handleGlobalInput("\x1b\r"), "global alt-enter should be handled");
assert(plain(globalViewport.render(80)).some((line) => line.includes("hidden lines")), "global alt-enter should collapse the selected block");
assert(globalViewport.handleGlobalInput("\x1b[1;3F"), "global alt-end should be handled");
assert(plain(globalViewport.render(80)).some((line) => line.startsWith("> c1")), "global alt-end should select the newest block");
assert(globalViewport.handleGlobalInput("\x1b[1;5H"), "global ctrl-home fallback should be handled");
assert(plain(globalViewport.render(80)).some((line) => line.startsWith("> a1")), "global ctrl-home should select the first block");

const wheelViewport = new ClankyTranscriptViewport(() => 3, {
	dim: (text) => text,
	selected: (text) => text,
});
wheelViewport.addChild(new LineComponent(["w1", "w2"]));
wheelViewport.addChild(new LineComponent(["x1", "x2"]));
wheelViewport.addChild(new LineComponent(["y1", "y2"]));
assert(wheelViewport.handleGlobalInput("\x1b[<64;10;5M"), "global wheel-up should be handled");
assert(plain(wheelViewport.render(80)).join("|") === "w1|w2|x1", "global wheel-up should scroll transcript rows");
assert(wheelViewport.handleGlobalInput("\x1b[<65;10;5M"), "global wheel-down should be handled");
assert(plain(wheelViewport.render(80)).join("|") === "x2|y1|y2", "global wheel-down should return toward newest rows");

const emptyGlobalViewport = new ClankyTranscriptViewport(() => 3);
assert(!emptyGlobalViewport.handleGlobalInput("\x1b[5~"), "global transcript shortcuts should pass through when no blocks exist");
assert(!emptyGlobalViewport.handleGlobalInput("\x1b[<64;10;5M"), "global wheel shortcuts should pass through when no blocks exist");
assert(isClankyTranscriptPageScrollInput("\x1b[5~"), "page-up should be classified as transcript page scroll");
assert(isClankyTranscriptPageScrollInput("\x1b[6~"), "page-down should be classified as transcript page scroll");
assert(isClankyTranscriptPageScrollInput("\x1b[5~", "up"), "page-up direction classifier should match page-up");
assert(!isClankyTranscriptPageScrollInput("\x1b[5~", "down"), "page-up direction classifier should not match page-down");
assert(!isClankyTranscriptPageScrollInput("\x1b[1;3A"), "alt-up should not be treated as draft-safe page scroll");
assert(isClankyTranscriptMouseScrollInput("\x1b[<64;10;5M"), "wheel-up should be classified as transcript mouse scroll");
assert(isClankyTranscriptMouseScrollInput("\x1b[<65;10;5M"), "wheel-down should be classified as transcript mouse scroll");
assert(clankyTranscriptMouseScrollDirection("\x1b[<64;10;5M") === "up", "wheel-up should parse as up");
assert(clankyTranscriptMouseScrollDirection("\x1b[<65;10;5M") === "down", "wheel-down should parse as down");
assert(clankyTranscriptMouseScrollDirection("\x1b[<68;10;5M") === "up", "modified wheel-up should parse as up");
assert(isClankySgrMouseInput("\x1b[<0;10;5M"), "plain mouse clicks should be classified as SGR mouse input");
assert(!isClankyTranscriptMouseScrollInput("\x1b[<64;10;5m"), "mouse release should not be classified as wheel scroll");

const selectionViewport = new ClankyTranscriptViewport(() => 3, {
	dim: (text) => text,
	selected: (text) => text,
});
selectionViewport.addChild(new LineComponent(["hello world", "second line", "third"]));
selectionViewport.render(80);
assert(!selectionViewport.hasSelection(), "a fresh viewport should have no selection");

selectionViewport.selectionPress(0, 0);
selectionViewport.selectionDrag(0, 5);
assert(selectionViewport.hasSelection(), "dragging across columns should produce a selection");
assert(selectionViewport.getSelectedText() === "hello", "single-line selection should return the dragged columns");
assert(selectionViewport.render(80)[0]?.includes("\x1b[7m") === true, "selected columns should render with inverse styling");

selectionViewport.selectionPress(0, 6);
selectionViewport.selectionDrag(1, 6);
assert(selectionViewport.getSelectedText() === "world\nsecond", "multi-line selection should join rows with newlines");

selectionViewport.selectionPress(1, 6);
selectionViewport.selectionDrag(0, 6);
assert(selectionViewport.getSelectedText() === "world\nsecond", "reversed drag direction should normalize the selection");

selectionViewport.selectionPress(0, 3);
assert(!selectionViewport.hasSelection(), "a press without a drag should not select anything");
assert(selectionViewport.getSelectedText() === "", "an empty selection should yield no text");

selectionViewport.selectionPress(0, 0);
selectionViewport.selectionDrag(0, 5);
selectionViewport.clearSelection();
assert(!selectionViewport.hasSelection(), "clearSelection should drop the active selection");
assert(!selectionViewport.render(80)[0]?.includes("\x1b[7m"), "cleared selection should not render inverse styling");

const spacedViewport = new ClankyTranscriptViewport(() => 6, { dim: (text) => text, selected: (text) => text }, { blockSpacing: 1 });
spacedViewport.addChild(new LineComponent(["You", "hi"]));
spacedViewport.addChild(new LineComponent(["Clanky", "hello"]));
assert(plain(spacedViewport.render(80)).join("|") === "|You|hi||Clanky|hello", "blockSpacing should insert a blank row between blocks");

const unspacedViewport = new ClankyTranscriptViewport(() => 6, { dim: (text) => text, selected: (text) => text });
unspacedViewport.addChild(new LineComponent(["You", "hi"]));
unspacedViewport.addChild(new LineComponent(["Clanky", "hello"]));
assert(plain(unspacedViewport.render(80)).join("|") === "||You|hi|Clanky|hello", "default spacing should keep blocks adjacent");

const pinnedLoaderViewport = new ClankyTranscriptViewport(() => 9, { dim: (text) => text, selected: (text) => text }, { blockSpacing: 1 });
pinnedLoaderViewport.addChild(new LineComponent(["You"]));
pinnedLoaderViewport.addChild(new LineComponent(["Step 1 running..."]), { collapsible: false, pin: "bottom" });
pinnedLoaderViewport.addChild(new LineComponent(["Clanky", "hello"]));
pinnedLoaderViewport.addChild(new LineComponent(["Tool", "done"]));
const pinnedLoaderRows = plain(pinnedLoaderViewport.render(80));
assert(
	pinnedLoaderRows.join("|") === "You||Clanky|hello||Tool|done||Step 1 running...",
	"bottom-pinned loader should stay below later transcript blocks",
);

const topAlignedViewport = new ClankyTranscriptViewport(() => 4, { dim: (text) => text, selected: (text) => text }, { underfilledAlignment: "top" });
topAlignedViewport.addChild(new LineComponent(["near input", "second"]));
assert(plain(topAlignedViewport.render(80)).join("|") === "near input|second||", "top-aligned underfilled transcripts should put blank rows after content");
topAlignedViewport.setUnderfilledAlignment("bottom");
assert(plain(topAlignedViewport.render(80)).join("|") === "||near input|second", "underfilled alignment should be switchable after construction");

const focusedSelection = new ClankyTranscriptViewport(() => 1, {
	dim: (text) => text,
	selected: (text) => text,
});
focusedSelection.addChild(new LineComponent(["hello"]));
focusedSelection.focused = true;
focusedSelection.render(80);
focusedSelection.selectionPress(0, 0);
focusedSelection.selectionDrag(0, 7);
assert(focusedSelection.getSelectedText() === "hello", "focused selection should exclude the block prefix gutter");

const clickToggleViewport = new ClankyTranscriptViewport(() => 4, { dim: (text) => text, selected: (text) => text }, { underfilledAlignment: "top" });
clickToggleViewport.addChild(new LineComponent(["tool", "summary", "detail"]), { clickToggle: true, collapsed: true });
assert(plain(clickToggleViewport.render(80)).some((line) => line.includes("hidden lines")), "click-toggle blocks can start collapsed");
assert(clickToggleViewport.toggleCollapsedAt(0), "clicking a click-toggle block row should expand it");
assert(plain(clickToggleViewport.render(80)).includes("detail"), "expanded click-toggle block should show hidden detail");
assert(clickToggleViewport.toggleCollapsedAt(1), "clicking another visible row in the block should collapse it");
assert(plain(clickToggleViewport.render(80)).some((line) => line.includes("hidden lines")), "second click should collapse the block again");

const inertClickViewport = new ClankyTranscriptViewport(() => 3, { dim: (text) => text, selected: (text) => text }, { underfilledAlignment: "top" });
inertClickViewport.addChild(new LineComponent(["plain", "body"]), { collapsed: true });
inertClickViewport.render(80);
assert(!inertClickViewport.toggleCollapsedAt(0), "plain collapsed blocks should ignore mouse toggles unless opted in");

// --- scrollbar geometry (pure) ---
const identityBar = { thumb: (text: string) => text, track: (text: string) => text };
assert(
	computeClankyScrollbarColumn(10, 5, 5, UNICODE_SCROLLBAR_GLYPHS, identityBar).join("") === "││▄██",
	"scrollbar thumb should sit at the bottom of the track when pinned to newest rows",
);
assert(
	computeClankyScrollbarColumn(10, 5, 0, UNICODE_SCROLLBAR_GLYPHS, identityBar).join("") === "██▀││",
	"scrollbar thumb should sit at the top of the track when scrolled fully back",
);
assert(
	computeClankyScrollbarColumn(3, 5, 0, UNICODE_SCROLLBAR_GLYPHS, identityBar).join("") === "     ",
	"scrollbar column should be blank when content fits the viewport",
);
const thumbCells = computeClankyScrollbarColumn(100, 5, 0, UNICODE_SCROLLBAR_GLYPHS, identityBar).filter((cell) => cell !== "│").length;
assert(thumbCells >= 1, "a tiny thumb should still render at least one cell");
assert(clankyScrollbarWindowStartForRow(0, 10, 5) === 0, "clicking the top track row should scroll to the top");
assert(clankyScrollbarWindowStartForRow(4, 10, 5) === 5, "clicking the bottom track row should scroll to the bottom");
assert(clankyScrollbarWindowStartForRow(0, 3, 5) === 0, "a non-overflowing transcript should map every click to the top");

// --- scrollbar integration ---
const barViewport = new ClankyTranscriptViewport(() => 5, {
	dim: (text) => text,
	scrollbarThumb: (text) => text,
	scrollbarTrack: (text) => text,
	selected: (text) => text,
}, { scrollbar: true });
barViewport.addChild(new LineComponent(["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"]));
const barRows = barViewport.render(20);
assertFits(barRows, 20);
for (const row of barRows) assert(visibleWidth(row) === 20, "scrollbar rows should fill the full width including the gutter");
assert(barRows.map((row) => row.at(-1)).join("") === "││▄██", "overflowing transcript should paint a thumb pinned to the bottom");
assert(barViewport.scrollbarHitColumn() === 19, "scrollbar should report its gutter column when content overflows");
barViewport.scroll(99, 20);
const scrolledRows = barViewport.render(20);
assert(scrolledRows.map((row) => row.at(-1)).join("") === "██▀││", "scrolling back should move the thumb to the top");
assert(plainContent(scrolledRows).join("|") === "l1|l2|l3|l4|l5", "the gutter must not eat transcript content columns");
barViewport.scrollToTrackRow(4, 20);
assert(plainContent(barViewport.render(20)).join("|") === "l6|l7|l8|l9|l10", "dragging the thumb to the bottom row should jump to newest rows");
barViewport.scrollToTrackRow(0, 20);
assert(plainContent(barViewport.render(20)).join("|") === "l1|l2|l3|l4|l5", "dragging the thumb to the top row should jump to oldest rows");

const fitsBarViewport = new ClankyTranscriptViewport(() => 5, {
	dim: (text) => text,
	scrollbarThumb: (text) => text,
	scrollbarTrack: (text) => text,
	selected: (text) => text,
}, { scrollbar: true });
fitsBarViewport.addChild(new LineComponent(["only", "two"]));
const fitsRows = fitsBarViewport.render(20);
assert(fitsRows.every((row) => row.at(-1) === " "), "a fitting transcript should leave the gutter blank");
assert(fitsBarViewport.scrollbarHitColumn() === undefined, "no scrollbar column should be reported when content fits");
assert(plain(fitsRows).join("|") === "|||only|two", "blank gutter should not change the plain transcript content");

const focusedBarViewport = new ClankyTranscriptViewport(() => 3, {
	dim: (text) => text,
	scrollbarThumb: (text) => text,
	scrollbarTrack: (text) => text,
	selected: (text) => text,
}, { scrollbar: true });
focusedBarViewport.addChild(new LineComponent(["f1", "f2", "f3", "f4", "f5", "f6"]));
focusedBarViewport.focused = true;
const focusedBarRows = focusedBarViewport.render(20);
for (const row of focusedBarRows) assert(visibleWidth(row) === 20, "focused scrollbar rows should still fill the full width with both gutters");
assert("█▀▄│".includes(focusedBarRows[0]?.at(-1) ?? ""), "focused overflowing transcript should still paint a thumb in the right gutter");
focusedBarViewport.scroll(99, 20);
const focusedTopRows = focusedBarViewport.render(20);
assert(focusedTopRows.some((row) => row.includes(CURSOR_MARKER)), "focused viewport should keep its selection cursor alongside the scrollbar");
for (const row of focusedTopRows) assert(visibleWidth(row) === 20, "focused cursor row should account for both the prefix and the gutter");

const narrowBarViewport = new ClankyTranscriptViewport(() => 3, { dim: (text) => text, selected: (text) => text }, { scrollbar: true });
narrowBarViewport.addChild(new LineComponent(["a", "b", "c", "d", "e"]));
const narrowRows = narrowBarViewport.render(6);
assert(narrowRows.every((row) => visibleWidth(row) <= 6), "very narrow terminals should drop the gutter rather than overflow");
assert(narrowBarViewport.scrollbarHitColumn() === undefined, "no scrollbar should render below the minimum width");

console.log("clanky-transcript-viewport-smoke: ok");
