import {
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

console.log("clanky-face-layout-smoke: ok");
