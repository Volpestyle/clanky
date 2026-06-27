import {
	resolveClankyChromeMouseTargetFromBands,
	resolveClankyOverlayFrame,
	resolveClankyOverlayMouseTarget,
	resolveClankyTranscriptMouseTargetFromBands,
	resolveClankyCommandRows,
	resolveClankyTranscriptMouseTarget,
	resolveClankyTranscriptRows,
} from "../agent/lib/clanky-face-layout.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

assert(
	resolveClankyTranscriptRows({ minRows: 4, reservedRows: 12, terminalRows: 30 }) === 18,
	"transcript should use all spare rows on roomy terminals",
);
assert(
	resolveClankyTranscriptRows({ minRows: 4, reservedRows: 14, terminalRows: 16 }) === 2,
	"transcript should shrink below the preferred minimum on short terminals",
);
assert(
	resolveClankyTranscriptRows({ minRows: 4, reservedRows: 20, terminalRows: 16 }) === 1,
	"transcript should keep one row when fixed chrome exceeds terminal height",
);
assert(
	resolveClankyCommandRows({ maxRows: 10, reservedRows: 12, terminalRows: 30 }) === 10,
	"command typeahead should keep its rich menu on roomy terminals",
);
assert(
	resolveClankyCommandRows({ maxRows: 10, reservedRows: 20, terminalRows: 24 }) === 4,
	"command typeahead should shrink to the available row budget",
);
assert(
	resolveClankyCommandRows({ maxRows: 10, reservedRows: 30, terminalRows: 24 }) === 0,
	"command typeahead should hide when the terminal has no spare rows",
);

const roomy = { bannerRows: 4, belowRows: 6, terminalRows: 30, transcriptRows: 20 } as const;
const topHit = resolveClankyTranscriptMouseTarget({ ...roomy, mouseCol: 10, mouseRow: 5 });
assert(topHit.inside && topHit.row === 0 && topHit.col === 9, "the first transcript row sits just below the banner");
const bottomHit = resolveClankyTranscriptMouseTarget({ ...roomy, mouseCol: 1, mouseRow: 24 });
assert(bottomHit.inside && bottomHit.row === 19, "the last transcript row sits just above the status chrome");
const aboveBand = resolveClankyTranscriptMouseTarget({ ...roomy, mouseCol: 1, mouseRow: 4 });
assert(!aboveBand.inside && aboveBand.row === 0, "clicks on the banner fall outside and clamp to the first row");
const belowBand = resolveClankyTranscriptMouseTarget({ ...roomy, mouseCol: 1, mouseRow: 25 });
assert(!belowBand.inside && belowBand.row === 19, "clicks on the editor fall outside and clamp to the last row");

const cramped = resolveClankyTranscriptMouseTarget({ bannerRows: 4, belowRows: 6, terminalRows: 10, mouseCol: 3, mouseRow: 1, transcriptRows: 4 });
assert(cramped.inside && cramped.row === 0, "when the banner scrolls off the top the transcript starts at screen row 1");

const topInputBands = [
	{ band: "banner", rows: 3 },
	{ band: "editor", rows: 2 },
	{ band: "status", rows: 1 },
	{ band: "typeahead", rows: 4 },
	{ band: "transcript", rows: 12 },
] as const;
const topInputTranscript = resolveClankyTranscriptMouseTargetFromBands({ bands: topInputBands, terminalRows: 30, mouseCol: 8, mouseRow: 11 });
assert(topInputTranscript.inside && topInputTranscript.row === 0, "top-pinned input leaves the transcript below the input/status/typeahead cluster");
const topInputStatus = resolveClankyChromeMouseTargetFromBands({ bands: topInputBands, terminalRows: 30, mouseCol: 3, mouseRow: 6 });
assert(topInputStatus?.band === "status" && topInputStatus.row === 0, "status below a top-pinned input maps as selectable chrome");
const topInputEditor = resolveClankyChromeMouseTargetFromBands({ bands: topInputBands, terminalRows: 30, mouseCol: 3, mouseRow: 4 });
assert(topInputEditor === null, "top-pinned editor rows remain outside chrome selection");

const setupOverlayOptions = {
	anchor: "center",
	margin: { bottom: 3, left: 2, right: 2, top: 2 },
	maxHeight: "70%",
	minWidth: 48,
	width: "88%",
} as const;
const overlayFrame = resolveClankyOverlayFrame({
	options: setupOverlayOptions,
	overlayRows: 10,
	terminalColumns: 100,
	terminalRows: 40,
});
assert(overlayFrame.width === 88, "setup overlay uses the configured percentage width");
assert(overlayFrame.row === 14 && overlayFrame.col === 6, "centered setup overlay respects margins");
assert(overlayFrame.rows === 10, "overlay rows are unchanged when below max height");
const overlayHit = resolveClankyOverlayMouseTarget({
	options: setupOverlayOptions,
	overlayRows: 10,
	terminalColumns: 100,
	terminalRows: 40,
	mouseCol: 7,
	mouseRow: 15,
});
assert(overlayHit?.row === 0 && overlayHit.col === 0, "overlay mouse target maps to modal-local coordinates");
const overlayMiss = resolveClankyOverlayMouseTarget({
	options: setupOverlayOptions,
	overlayRows: 10,
	terminalColumns: 100,
	terminalRows: 40,
	mouseCol: 5,
	mouseRow: 15,
});
assert(overlayMiss === null, "overlay mouse target ignores cells outside the modal frame");
const clampedOverlay = resolveClankyOverlayFrame({
	options: setupOverlayOptions,
	overlayRows: 50,
	terminalColumns: 100,
	terminalRows: 40,
});
assert(clampedOverlay.rows === 28, "overlay rows are capped by maxHeight");

console.log("clanky-face-layout-smoke: ok");
