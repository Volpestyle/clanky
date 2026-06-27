export type ClankyFaceRowsOptions = {
	readonly reservedRows: number;
	readonly terminalRows: number;
};

export type ClankyTranscriptRowsOptions = ClankyFaceRowsOptions & {
	readonly minRows: number;
};

export type ClankyCommandRowsOptions = ClankyFaceRowsOptions & {
	readonly maxRows: number;
};

export function resolveClankyTranscriptRows(options: ClankyTranscriptRowsOptions): number {
	const remainingRows = options.terminalRows - options.reservedRows;
	return remainingRows >= options.minRows ? remainingRows : Math.max(1, remainingRows);
}

export function resolveClankyCommandRows(options: ClankyCommandRowsOptions): number {
	return clampNumber(options.terminalRows - options.reservedRows, 0, options.maxRows);
}

export type ClankyTranscriptMouseTargetOptions = {
	readonly bannerRows: number;
	readonly transcriptRows: number;
	readonly belowRows: number;
	readonly terminalRows: number;
	readonly mouseRow: number;
	readonly mouseCol: number;
};

export type ClankyTranscriptMouseTarget = {
	readonly row: number;
	readonly col: number;
	readonly inside: boolean;
};

// Map an absolute 1-based terminal cell to a transcript row/col. The face stacks
// banner, transcript, status, typeahead, and editor top-to-bottom and the
// terminal shows the bottom `terminalRows` lines, so the transcript band starts
// at `bannerRows - viewportTop`. Returns a clamped row plus whether the cell
// actually fell inside the transcript band.
export function resolveClankyTranscriptMouseTarget(
	options: ClankyTranscriptMouseTargetOptions,
): ClankyTranscriptMouseTarget {
	const totalRows = options.bannerRows + options.transcriptRows + options.belowRows;
	const viewportTop = Math.max(0, totalRows - options.terminalRows);
	const transcriptTopScreen = options.bannerRows - viewportTop;
	const rawRow = options.mouseRow - 1 - transcriptTopScreen;
	const lastRow = Math.max(0, options.transcriptRows - 1);
	return {
		col: Math.max(0, options.mouseCol - 1),
		inside: options.transcriptRows > 0 && rawRow >= 0 && rawRow < options.transcriptRows,
		row: clampNumber(rawRow, 0, lastRow),
	};
}

export type ClankyChromeBand = "banner" | "status" | "typeahead";

export type ClankyChromeMouseTargetOptions = {
	readonly bannerRows: number;
	readonly transcriptRows: number;
	readonly statusRows: number;
	readonly typeaheadRows: number;
	readonly editorRows: number;
	readonly terminalRows: number;
	readonly mouseRow: number;
	readonly mouseCol: number;
};

export type ClankyChromeMouseTarget = {
	readonly band: ClankyChromeBand;
	readonly row: number;
	readonly col: number;
};

// Map an absolute 1-based terminal cell to a selectable chrome band (banner
// header or status/typeahead footer) and a band-local row. The face stacks
// banner, transcript, status, typeahead, and editor top-to-bottom and the
// terminal shows the bottom `terminalRows` lines. Returns null when the cell
// falls in the transcript band (which owns its own selection), in the editor,
// or outside the frame.
export function resolveClankyChromeMouseTarget(
	options: ClankyChromeMouseTargetOptions,
): ClankyChromeMouseTarget | null {
	const totalRows =
		options.bannerRows + options.transcriptRows + options.statusRows + options.typeaheadRows + options.editorRows;
	const viewportTop = Math.max(0, totalRows - options.terminalRows);
	const flat = options.mouseRow - 1 + viewportTop;
	const col = Math.max(0, options.mouseCol - 1);
	const statusStart = options.bannerRows + options.transcriptRows;
	const typeaheadStart = statusStart + options.statusRows;
	if (flat >= 0 && flat < options.bannerRows) {
		return { band: "banner", col, row: flat };
	}
	if (flat >= statusStart && flat < statusStart + options.statusRows) {
		return { band: "status", col, row: flat - statusStart };
	}
	if (flat >= typeaheadStart && flat < typeaheadStart + options.typeaheadRows) {
		return { band: "typeahead", col, row: flat - typeaheadStart };
	}
	return null;
}

function clampNumber(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
