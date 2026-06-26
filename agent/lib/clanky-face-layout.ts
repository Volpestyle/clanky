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

function clampNumber(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
