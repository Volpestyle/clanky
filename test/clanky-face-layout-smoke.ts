import { resolveClankyCommandRows, resolveClankyTranscriptRows } from "../agent/lib/clanky-face-layout.ts";

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

console.log("clanky-face-layout-smoke: ok");
