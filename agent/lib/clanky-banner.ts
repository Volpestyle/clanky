/**
 * Clanky's welcome banner.
 *
 * A compact text header with identity + model/harness/cwd + a hint line.
 *
 * Degrades on capability: truecolor -> 256-color -> no color, and a Unicode
 * support check. On narrow terminals it collapses to a single condensed line
 * so the header never wraps into noise.
 */

export type BannerCapabilities = {
	/** Emit ANSI color (false for NO_COLOR / non-TTY / dumb terminals). */
	color: boolean;
	/** Use Unicode block art (false falls back to ASCII). */
	unicode: boolean;
	/** Truecolor (24-bit) support; when false but color is true, use 256-color. */
	trueColor: boolean;
	/** Terminal width in columns. */
	columns: number;
};

export type BannerFields = {
	title: string;
	tagline: string;
	model?: string;
	harness?: string;
	cwd?: string;
	hint?: string;
};

type Rgb = readonly [number, number, number];

// Warm, dusty palette pulled from the hooded-figure brand art.
const PALETTE = {
	titleA: [255, 196, 112] as Rgb,
	label: [150, 132, 126] as Rgb,
	dim: [128, 116, 112] as Rgb,
} as const;

// 256-color approximations for terminals without truecolor.
const PALETTE_256: Record<keyof typeof PALETTE, number> = {
	titleA: 215,
	label: 245,
	dim: 244,
};

export function renderClankyBanner(
	fields: BannerFields,
	caps: BannerCapabilities,
): string[] {
	if (caps.columns < 44) {
		return renderCondensed(fields, caps);
	}

	const lines = buildFeedLines(fields, caps).map((line) =>
		line.length === 0 ? "" : ` ${line}`,
	);
	if (fields.hint !== undefined && fields.hint.length > 0) {
		lines.push("");
		lines.push(` ${paint(fields.hint, { fg: "dim" }, caps)}`);
	}
	return lines;
}

function buildFeedLines(
	fields: BannerFields,
	caps: BannerCapabilities,
): string[] {
	const lines: string[] = [];
	lines.push(paint(fields.title.toLowerCase(), { fg: "titleA", bold: true }, caps));
	lines.push(paint(fields.tagline, { fg: "dim" }, caps));
	lines.push("");
	for (const [label, value] of [
		["model", fields.model],
		["harness", fields.harness],
		["cwd", fields.cwd],
	] as const) {
		if (value === undefined || value.length === 0) continue;
		lines.push(
			`${paint(label.padEnd(8), { fg: "label" }, caps)}${paint(value, {}, caps)}`,
		);
	}
	return lines;
}

function renderCondensed(
	fields: BannerFields,
	caps: BannerCapabilities,
): string[] {
	const head = paint(fields.title.toLowerCase(), { fg: "titleA", bold: true }, caps);
	const detail =
		fields.model !== undefined
			? paint(` — ${fields.model}`, { fg: "dim" }, caps)
			: "";
	const lines = [` ${head}${detail}`];
	if (fields.hint !== undefined && fields.hint.length > 0) {
		lines.push(` ${paint(fields.hint, { fg: "dim" }, caps)}`);
	}
	return lines;
}

function paint(
	text: string,
	style: {
		fg?: keyof typeof PALETTE;
		bold?: boolean;
	},
	caps: BannerCapabilities,
): string {
	if (!caps.color) return text;
	const codes: string[] = [];
	if (style.bold === true) codes.push("1");
	if (style.fg !== undefined) codes.push(colorCode(style.fg, false, caps));
	if (codes.length === 0) return text;
	return `\x1b[${codes.join(";")}m${text}\x1b[0m`;
}

function colorCode(
	key: keyof typeof PALETTE,
	background: boolean,
	caps: BannerCapabilities,
): string {
	const layer = background ? "48" : "38";
	if (caps.trueColor) {
		const [r, g, b] = PALETTE[key];
		return `${layer};2;${r};${g};${b}`;
	}
	return `${layer};5;${PALETTE_256[key]}`;
}

/** Detect banner capabilities from the environment and an output stream. */
export function detectBannerCapabilities(
	output: { isTTY?: boolean; columns?: number },
	env: NodeJS.ProcessEnv = process.env,
): BannerCapabilities {
	const isTTY = output.isTTY === true;
	const noColor = env.NO_COLOR !== undefined && env.NO_COLOR !== "";
	const color = isTTY && !noColor && env.TERM !== "dumb";
	const colorTerm = env.COLORTERM ?? "";
	const trueColor =
		color && (colorTerm.includes("truecolor") || colorTerm.includes("24bit"));
	const unicode = detectUnicode(env);
	const columns =
		typeof output.columns === "number" && output.columns > 0
			? output.columns
			: 80;
	return { color, unicode, trueColor, columns };
}

function detectUnicode(env: NodeJS.ProcessEnv): boolean {
	const flag = env.EVE_TUI_UNICODE ?? env.CLANKY_TUI_UNICODE;
	if (flag === "0" || flag === "false") return false;
	if (flag === "1" || flag === "true") return true;
	if (env.TERM === "dumb") return false;
	if (process.platform === "win32")
		return env.WT_SESSION !== undefined || env.TERM_PROGRAM === "vscode";
	return true;
}
