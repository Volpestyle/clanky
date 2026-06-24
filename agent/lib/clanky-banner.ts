/**
 * Clanky's welcome banner (custom face).
 *
 * Inspired by Claude Code's LogoV2: a compact pixel mascot rendered in
 * Unicode quadrant blocks beside an info "feed" (identity + model/harness/cwd
 * + a hint line). Clanky's mascot is the hooded figure from the brand art,
 * with two glowing amber eyes.
 *
 * Degrades on capability: truecolor -> 256-color -> no color, and a Unicode
 * mascot -> ASCII mascot. On narrow terminals it collapses to a single
 * condensed line so the header never wraps into noise.
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

// Warm, dusty palette pulled from the hooded-figure brand art: terracotta
// hood fading to deep maroon, a near-black face, and glowing amber eyes.
const PALETTE = {
	hoodTop: [158, 84, 62] as Rgb,
	hoodMid: [122, 62, 52] as Rgb,
	hoodLow: [88, 46, 46] as Rgb,
	face: [26, 18, 22] as Rgb,
	eye: [255, 188, 96] as Rgb,
	titleA: [255, 196, 112] as Rgb,
	titleB: [196, 92, 66] as Rgb,
	label: [150, 132, 126] as Rgb,
	dim: [128, 116, 112] as Rgb,
} as const;

// 256-color approximations for terminals without truecolor.
const PALETTE_256: Record<keyof typeof PALETTE, number> = {
	hoodTop: 131,
	hoodMid: 95,
	hoodLow: 52,
	face: 235,
	eye: 215,
	titleA: 215,
	titleB: 167,
	label: 245,
	dim: 244,
};

type Segment = {
	text: string;
	fg?: keyof typeof PALETTE;
	bg?: keyof typeof PALETTE;
	bold?: boolean;
};

// Mascot rows as colored segments. Every row is FACE_WIDTH visible columns so
// the feed lines to its right stay aligned.
const MASCOT_WIDTH = 12;

const UNICODE_MASCOT: Segment[][] = [
	[{ text: "   ▄▄▄▄▄▄   ", fg: "hoodTop" }],
	[{ text: "  ▟██████▙  ", fg: "hoodTop" }],
	[{ text: " ▟████████▙ ", fg: "hoodMid" }],
	[
		{ text: " ██", fg: "hoodMid" },
		{ text: " ", bg: "face" },
		{ text: "●", fg: "eye", bg: "face", bold: true },
		{ text: "  ", bg: "face" },
		{ text: "●", fg: "eye", bg: "face", bold: true },
		{ text: " ", bg: "face" },
		{ text: "██ ", fg: "hoodMid" },
	],
	[{ text: " ▜████████▛ ", fg: "hoodLow" }],
	[{ text: "  ▀▀▀▀▀▀▀▀  ", fg: "hoodLow" }],
];

const ASCII_MASCOT: Segment[][] = [
	[{ text: "   ______   ", fg: "hoodTop" }],
	[{ text: "  /######\\  ", fg: "hoodTop" }],
	[{ text: " /########\\ ", fg: "hoodMid" }],
	[
		{ text: " |##", fg: "hoodMid" },
		{ text: " ", bg: "face" },
		{ text: "o", fg: "eye", bg: "face", bold: true },
		{ text: "  ", bg: "face" },
		{ text: "o", fg: "eye", bg: "face", bold: true },
		{ text: " ", bg: "face" },
		{ text: "##| ", fg: "hoodMid" },
	],
	[{ text: " \\########/ ", fg: "hoodLow" }],
	[{ text: "  \\______/  ", fg: "hoodLow" }],
];

export function renderClankyBanner(
	fields: BannerFields,
	caps: BannerCapabilities,
): string[] {
	const feed = buildFeedLines(fields, caps);
	if (caps.columns < MASCOT_WIDTH + 2 + 28) {
		return renderCondensed(fields, caps);
	}

	const mascot = caps.unicode ? UNICODE_MASCOT : ASCII_MASCOT;
	const rows = Math.max(mascot.length, feed.length);
	const lines: string[] = [];
	for (let i = 0; i < rows; i += 1) {
		const left =
			i < mascot.length
				? paintSegments(mascot[i] ?? [], caps)
				: " ".repeat(MASCOT_WIDTH);
		const right = feed[i] ?? "";
		lines.push(` ${left}  ${right}`.trimEnd());
	}
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
	lines.push(
		gradientText(
			fields.title.toUpperCase().split("").join(" "),
			PALETTE.titleA,
			PALETTE.titleB,
			caps,
			true,
		),
	);
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
	const eyes = caps.unicode ? "◉◉" : "oo";
	const head = `${paint(eyes, { fg: "eye", bold: true }, caps)} ${gradientText(fields.title, PALETTE.titleA, PALETTE.titleB, caps, true)}`;
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

function paintSegments(segments: Segment[], caps: BannerCapabilities): string {
	return segments.map((segment) => paint(segment.text, segment, caps)).join("");
}

function paint(
	text: string,
	style: {
		fg?: keyof typeof PALETTE;
		bg?: keyof typeof PALETTE;
		bold?: boolean;
	},
	caps: BannerCapabilities,
): string {
	if (!caps.color) return text;
	const codes: string[] = [];
	if (style.bold === true) codes.push("1");
	if (style.fg !== undefined) codes.push(colorCode(style.fg, false, caps));
	if (style.bg !== undefined) codes.push(colorCode(style.bg, true, caps));
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

function gradientText(
	text: string,
	from: Rgb,
	to: Rgb,
	caps: BannerCapabilities,
	bold: boolean,
): string {
	if (!caps.color) return text;
	const chars = [...text];
	const span = Math.max(1, chars.length - 1);
	const prefix = bold ? "1;" : "";
	return chars
		.map((char, index) => {
			if (char === " ") return char;
			const t = index / span;
			if (caps.trueColor) {
				const r = Math.round(from[0] + (to[0] - from[0]) * t);
				const g = Math.round(from[1] + (to[1] - from[1]) * t);
				const b = Math.round(from[2] + (to[2] - from[2]) * t);
				return `\x1b[${prefix}38;2;${r};${g};${b}m${char}\x1b[0m`;
			}
			const code = t < 0.5 ? PALETTE_256.titleA : PALETTE_256.titleB;
			return `\x1b[${prefix}38;5;${code}m${char}\x1b[0m`;
		})
		.join("");
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
