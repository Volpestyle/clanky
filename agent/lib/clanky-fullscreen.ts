/**
 * Clanky's fullscreen face (opt-in via CLANKY_FULLSCREEN=1 or the /fullscreen
 * command).
 *
 * Goal — like Claude Code: the conversation fills from the top of the
 * viewport, the text input/status stays pinned to the bottom, and history is
 * scrollable while fullscreen owns the visible screen.
 *
 * Mechanism: eve renders its prompt at the end of its output, so we relocate it
 * into the reserved bottom zone by parsing eve's frame protocol and splitting
 * committed transcript lines (→ retained body buffer) from the live
 * prompt/status (→ bottom zone).
 *
 * eve's frame (one write per repaint), synchronized-output markers optional:
 *   CSI ?2026h  <prefix>  CSI 0J  <committed lines, each "\n">  <live, "\n"-joined>  CSI ?2026l
 * where <prefix> is "\r" (previous live height was 0 or 1) or "CSI {n}F"
 * (previous live height was n+1). The committed/live split of the *current*
 * frame is recovered one frame later from the next prefix — see EveFrameSplitter.
 */

import { clipVisible as clipTerminalTextVisible, visibleLength } from "../../node_modules/eve/dist/src/cli/dev/tui/terminal-text.js";

const ESC = "\x1b";
const CSI = `${ESC}[`;
const FRAME_START = `${CSI}?2026h`;
const FRAME_END = `${CSI}?2026l`;
const ERASE_BELOW = `${CSI}0J`;
const CLEAR_ALL = `${CSI}3J${CSI}2J${CSI}H`;
const PREFIX_UP = new RegExp(`^${ESC}\\[(\\d+)F`, "u");
const MOUSE_ON = `${CSI}?1000h${CSI}?1006h`;
const MOUSE_OFF = `${CSI}?1000l${CSI}?1006l`;

/** Normal bottom rows: a divider plus the prompt, spacer, and status lines. */
const MIN_ZONE_ROWS = 4;
/** Minimum conversation rows between the header and bottom zone. */
const MIN_BODY_ROWS = 5;

export type FullscreenOutput = {
	isTTY?: boolean;
	columns?: number;
	rows?: number;
	getWindowSize?: () => readonly [number, number];
	write(data: string): unknown;
};

export type ParsedFrame = { prefixLive: number; lines: string[]; endsWithNewline: boolean };

/** Truncate a possibly-ANSI-colored line to a visible width, keeping color codes. */
export function clipVisible(line: string, width: number): string {
	return clipTerminalTextVisible(line, width);
}

/**
 * Parse one eve frame into its previous-live height and content lines.
 * Returns null if the chunk is not an eve repaint frame (passed through as-is).
 */
export function parseFrame(chunk: string, prevEndsWithNewline: boolean): ParsedFrame | null {
	let s = chunk;
	if (s.startsWith(FRAME_START)) s = s.slice(FRAME_START.length);
	if (s.endsWith(FRAME_END)) s = s.slice(0, -FRAME_END.length);

	let prefixLive: number;
	if (s.startsWith("\r")) {
		// "\r" means the previous live height was 0 or 1; the previous frame's
		// trailing newline disambiguates (a trailing "\n" means it had no live region).
		prefixLive = prevEndsWithNewline ? 0 : 1;
		s = s.slice(1);
	} else {
		const up = PREFIX_UP.exec(s);
		if (up === null) return null;
		prefixLive = Number.parseInt(up[1] ?? "0", 10) + 1;
		s = s.slice(up[0].length);
	}
	if (!s.startsWith(ERASE_BELOW)) return null;
	const content = s.slice(ERASE_BELOW.length);

	const endsWithNewline = content.endsWith("\n");
	const lines = content.split("\n");
	if (endsWithNewline) lines.pop();
	return { prefixLive, lines, endsWithNewline };
}

/**
 * Splits eve's repaint stream into committed transcript lines (permanent) and
 * the current live region (prompt/status). The current frame's live height is
 * only known once the *next* frame's prefix reveals it, so each frame releases
 * the previous frame's now-proven-committed lines.
 */
export class EveFrameSplitter {
	private prevLines: string[] = [];
	private prevEndsWithNewline = true;

	feed(chunk: string): { committed: string[]; live: string[] } | null {
		const frame = parseFrame(chunk, this.prevEndsWithNewline);
		if (frame === null) return null;
		const released = Math.max(0, this.prevLines.length - frame.prefixLive);
		const committed = this.prevLines.slice(0, released);
		this.prevLines = frame.lines;
		this.prevEndsWithNewline = frame.endsWithNewline;
		return { committed, live: frame.lines };
	}

	reset(): void {
		this.prevLines = [];
		this.prevEndsWithNewline = true;
	}
}

function trimBlankEdges(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && (lines[start] ?? "").trim() === "") start += 1;
	while (end > start && (lines[end - 1] ?? "").trim() === "") end -= 1;
	return lines.slice(start, end);
}

type ZoneMetrics = {
	trimmedLive: string[];
	zoneRows: number;
	regionTop: number;
	regionBottom: number;
	zoneTop: number;
	bodyRows: number;
};

function measureZone(live: string[], rows: number): ZoneMetrics {
	const trimmedLive = trimBlankEdges(live);
	const maxZoneRows = Math.max(MIN_ZONE_ROWS, rows - MIN_BODY_ROWS);
	const zoneRows = Math.min(maxZoneRows, Math.max(MIN_ZONE_ROWS, trimmedLive.length + 1));
	const regionTop = 1;
	const regionBottom = rows - zoneRows;
	const zoneTop = regionBottom + 1;
	const bodyRows = Math.max(1, regionBottom - regionTop + 1);
	return { trimmedLive, zoneRows, regionTop, regionBottom, zoneTop, bodyRows };
}

function clearRows(from: number, to: number): string {
	let out = "";
	for (let row = from; row <= to; row += 1) {
		out += `${CSI}${row};1H${CSI}2K`;
	}
	return out;
}

/** Whether fullscreen is worth enabling for this terminal. */
export function fullscreenViable(output: FullscreenOutput, _headerRows = 0): boolean {
	if (output.isTTY !== true) return false;
	const size = terminalDimensions(output);
	return size.rows >= MIN_ZONE_ROWS + MIN_BODY_ROWS && size.columns >= 20;
}

export type TerminalDimensions = {
	columns: number;
	rows: number;
};

export function terminalDimensions(output: Pick<FullscreenOutput, "columns" | "rows" | "getWindowSize">): TerminalDimensions {
	const size = windowSize(output);
	const columns = size?.columns ?? positiveInteger(output.columns) ?? positiveInteger(Number.parseInt(process.env.COLUMNS ?? "", 10)) ?? 80;
	const rows = size?.rows ?? positiveInteger(output.rows) ?? positiveInteger(Number.parseInt(process.env.LINES ?? "", 10)) ?? 24;
	return { columns, rows };
}

function windowSize(output: Pick<FullscreenOutput, "getWindowSize">): TerminalDimensions | undefined {
	try {
		const size = output.getWindowSize?.();
		const columns = positiveInteger(size?.[0]);
		const rows = positiveInteger(size?.[1]);
		return columns !== undefined && rows !== undefined ? { columns, rows } : undefined;
	} catch {
		return undefined;
	}
}

function positiveInteger(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function enterSequence(header: string[], rows: number, columns: number): string {
	void header;
	void rows;
	void columns;
	return `${CSI}r${CSI}?25l${MOUSE_ON}${CSI}2J${CSI}H`;
}

export function exitSequence(rows: number): string {
	return `${MOUSE_OFF}${CSI}r${CSI}?25h${CSI}${rows};1H`;
}

/** Render one split frame: transcript fills from the top, live pins to the zone. */
export function renderFrame(
	transcript: string[],
	live: string[],
	rows: number,
	columns: number,
	scrollOffset = 0,
	previousZoneTop?: number,
): string {
	const { trimmedLive, zoneRows, regionTop, regionBottom, zoneTop, bodyRows } = measureZone(live, rows);
	const maxOffset = Math.max(0, transcript.length - bodyRows);
	const offset = Math.max(0, Math.min(maxOffset, scrollOffset));
	const start = Math.max(0, transcript.length - bodyRows - offset);
	const shownTranscript = transcript.slice(start, start + bodyRows);
	let out = "";

	// If a tall typeahead panel shrinks back to the normal prompt zone, the
	// reclaimed rows are now part of the body again. They previously contained
	// live UI, so clear them before transcript lines paint into them.
	if (previousZoneTop !== undefined && previousZoneTop < zoneTop) {
		out += clearRows(Math.max(regionTop, previousZoneTop), Math.min(zoneTop - 1, rows));
	}

	for (let i = 0; i < bodyRows; i += 1) {
		out += `${CSI}${regionTop + i};1H${CSI}2K${clipVisible(shownTranscript[i] ?? "", columns)}`;
	}

	// Live region: a divider, then live lines, painted by
	// absolute address so nothing in the frozen zone can scroll the screen.
	const shown = trimmedLive.slice(-(zoneRows - 1));
	const marker = offset > 0 ? ` history +${offset} ` : "";
	const ruleWidth = Math.max(1, columns - visibleLength(marker));
	const divider = clipVisible(`${"─".repeat(ruleWidth)}${marker}`, columns);
	out += `${CSI}${zoneTop};1H${CSI}2K${CSI}2m${divider}${CSI}0m`;
	for (let i = 0; i < zoneRows - 1; i += 1) {
		out += `${CSI}${zoneTop + 1 + i};1H${CSI}2K${clipVisible(shown[i] ?? "", columns)}`;
	}
	return out;
}

/**
 * Controller owning the fullscreen lifecycle. createClankyOutput funnels eve's
 * writes through `remap`; the controller writes its own region-control
 * sequences straight to the raw stream.
 */
export class ClankyFullscreenController {
	private readonly output: FullscreenOutput;
	private readonly writeRaw: (data: string) => unknown;
	private readonly splitter = new EveFrameSplitter();
	private header: string[] = [];
	private transcript: string[] = [];
	private live: string[] = [];
	private scrollOffset = 0;
	private enabled = false;
	private lastZoneTop: number | undefined;

	constructor(output: FullscreenOutput) {
		this.output = output;
		this.writeRaw = output.write.bind(output);
	}

	get active(): boolean {
		return this.enabled;
	}

	get headerRows(): number {
		return this.header.length;
	}

	private get rows(): number {
		return terminalDimensions(this.output).rows;
	}

	private get columns(): number {
		return terminalDimensions(this.output).columns;
	}

	enable(header: string[]): boolean {
		if (this.enabled || !fullscreenViable(this.output, header.length)) return false;
		this.header = header;
		this.transcript = [...header, ""];
		this.live = [];
		this.scrollOffset = 0;
		this.enabled = true;
		this.lastZoneTop = undefined;
		this.splitter.reset();
		this.writeRaw(enterSequence(this.header, this.rows, this.columns));
		this.writeRaw(this.render([], []));
		return true;
	}

	/** Seed the region with starting lines (the welcome banner) that scroll like any transcript line. */
	emitLines(lines: string[]): void {
		if (!this.enabled) return;
		const output = this.render(lines, []);
		this.writeRaw(output);
	}

	resize(header: string[] = this.header): void {
		if (!this.enabled) return;
		this.header = header;
		this.lastZoneTop = undefined;
		this.writeRaw(enterSequence(this.header, this.rows, this.columns));
		this.writeRaw(this.render([], this.live));
	}

	/** Transform one of eve's output chunks (no-op when inactive or not a frame). */
	remap(chunk: string): string {
		if (!this.enabled) return chunk;
		const clearIndex = chunk.indexOf(CLEAR_ALL);
		if (clearIndex !== -1) {
			const before = chunk.slice(0, clearIndex);
			const after = chunk.slice(clearIndex + CLEAR_ALL.length);
			return `${before}${this.resetSequence()}${after.length > 0 ? this.remap(after) : ""}`;
		}
		const split = this.splitter.feed(chunk);
		if (split === null) return chunk;
		return this.render(split.committed, split.live);
	}

	disable(): void {
		if (!this.enabled) return;
		this.enabled = false;
		this.lastZoneTop = undefined;
		this.writeRaw(exitSequence(this.rows));
	}

	toggle(): boolean {
		if (this.enabled) {
			this.disable();
			return false;
		}
		return this.enable([]);
	}

	private resetState(): void {
		this.lastZoneTop = undefined;
		this.transcript = [...this.header, ""];
		this.live = [];
		this.scrollOffset = 0;
		this.splitter.reset();
	}

	private resetSequence(): string {
		this.resetState();
		return `${CSI}3J${enterSequence(this.header, this.rows, this.columns)}${this.render([], [])}`;
	}

	private render(committed: string[], live: string[]): string {
		if (committed.length > 0) {
			if (this.scrollOffset > 0) this.scrollOffset += committed.length;
			this.transcript.push(...committed);
		}
		this.live = live;
		this.scrollOffset = this.clampedScrollOffset(this.scrollOffset, live);
		const output = renderFrame(this.transcript, this.live, this.rows, this.columns, this.scrollOffset, this.lastZoneTop);
		this.lastZoneTop = measureZone(live, this.rows).zoneTop;
		return output;
	}

	scroll(lines: number): boolean {
		if (!this.enabled) return false;
		const next = this.clampedScrollOffset(this.scrollOffset + lines, this.live);
		if (next === this.scrollOffset) return true;
		this.scrollOffset = next;
		this.writeRaw(this.render([], this.live));
		return true;
	}

	scrollPage(direction: -1 | 1): boolean {
		const pageRows = measureZone(this.live, this.rows).bodyRows;
		return this.scroll(direction * pageRows);
	}

	private clampedScrollOffset(offset: number, live: string[]): number {
		const bodyRows = measureZone(live, this.rows).bodyRows;
		const maxOffset = Math.max(0, this.transcript.length - bodyRows);
		return Math.max(0, Math.min(maxOffset, offset));
	}
}

/** Read the startup opt-in flag. */
export function fullscreenEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const flag = env.CLANKY_FULLSCREEN;
	return flag === "1" || flag === "true";
}
