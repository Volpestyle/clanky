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

function clampNumber(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
