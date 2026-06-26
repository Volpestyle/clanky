import {
	CURSOR_MARKER,
	Key,
	matchesKey,
	sliceByColumn,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
	type KeyId,
} from "@earendil-works/pi-tui";
import { parseClankySgrMouse } from "./clanky-sgr-mouse.ts";

export type ClankyTranscriptViewportTheme = {
	readonly dim: (text: string) => string;
	readonly selected: (text: string) => string;
};

export type ClankyTranscriptViewportOptions = {
	// Blank rows inserted before each block after the first, so turns read as
	// separated paragraphs rather than one wall of text.
	readonly blockSpacing?: number;
};

export type ClankyTranscriptBlockHandle = {
	remove(): void;
	setCollapsed(collapsed: boolean): void;
	toggleCollapsed(): void;
	scrollIntoView(): void;
};

export type ClankyTranscriptBlockOptions = {
	readonly collapsed?: boolean;
	readonly collapsible?: boolean;
	readonly id?: string;
};

type TranscriptBlock = {
	readonly component: Component;
	readonly id: string;
	collapsed: boolean;
	collapsible: boolean;
};

type RenderedBlock = {
	readonly block: TranscriptBlock;
	readonly lines: readonly string[];
	readonly start: number;
	readonly end: number;
};

type ScrollDirection = "down" | "up";

type SelectionPoint = {
	readonly line: number;
	readonly col: number;
};

type Selection = {
	readonly anchor: SelectionPoint;
	readonly head: SelectionPoint;
};

const SELECTION_INVERSE = "\x1b[7m";
const SELECTION_RESET = "\x1b[0m";

const DEFAULT_THEME: ClankyTranscriptViewportTheme = {
	dim: (text) => `\x1b[2m${text}\x1b[22m`,
	selected: (text) => `\x1b[36m${text}\x1b[39m`,
};
const WHEEL_SCROLL_ROWS = 3;

export class ClankyTranscriptViewport implements Component, Focusable {
	private readonly blocks: TranscriptBlock[] = [];
	private readonly maxRows: (width: number) => number;
	private readonly theme: ClankyTranscriptViewportTheme;
	private readonly blockSpacing: number;
	private nextBlockId = 1;
	private scrollbackRows = 0;
	private selectedIndex = 0;
	private lastWidth = 80;
	private selection: Selection | null = null;
	private prefixWidth = 0;
	private lastFlattened: readonly string[] = [];
	private lastWindowStart = 0;
	private lastTopPad = 0;
	focused = false;

	constructor(
		maxRows: (width: number) => number,
		theme: Partial<ClankyTranscriptViewportTheme> = {},
		options: ClankyTranscriptViewportOptions = {},
	) {
		this.maxRows = maxRows;
		this.theme = { ...DEFAULT_THEME, ...theme };
		this.blockSpacing = Math.max(0, Math.floor(options.blockSpacing ?? 0));
	}

	addChild(component: Component, options: ClankyTranscriptBlockOptions = {}): ClankyTranscriptBlockHandle {
		const wasAtBottom = this.scrollbackRows === 0;
		const block: TranscriptBlock = {
			collapsed: options.collapsed === true,
			collapsible: options.collapsible !== false,
			component,
			id: options.id ?? `block-${this.nextBlockId++}`,
		};
		this.blocks.push(block);
		if (wasAtBottom || this.blocks.length === 1) {
			this.selectedIndex = this.blocks.length - 1;
			this.scrollToBottom();
		}
		return this.handleFor(block);
	}

	removeChild(component: Component): void {
		const index = this.blocks.findIndex((block) => block.component === component);
		if (index < 0) return;
		this.blocks.splice(index, 1);
		this.selectedIndex = clamp(this.selectedIndex, 0, Math.max(0, this.blocks.length - 1));
		this.selection = null;
		this.clampScrollback(this.lastWidth);
	}

	clear(): void {
		this.blocks.length = 0;
		this.scrollbackRows = 0;
		this.selectedIndex = 0;
		this.selection = null;
	}

	scroll(delta: number, width = this.lastWidth): void {
		this.lastWidth = width;
		this.scrollbackRows += delta;
		this.clampScrollback(width);
	}

	scrollPage(direction: "down" | "up", width = this.lastWidth): void {
		const delta = this.visibleRowCount(width) - 1;
		this.scroll(direction === "up" ? delta : -delta, width);
	}

	scrollWheel(direction: ScrollDirection, width = this.lastWidth): void {
		this.scroll(direction === "up" ? WHEEL_SCROLL_ROWS : -WHEEL_SCROLL_ROWS, width);
	}

	scrollToBottom(): void {
		this.scrollbackRows = 0;
	}

	invalidate(): void {
		for (const block of this.blocks) block.component.invalidate();
	}

	handleGlobalInput(data: string): boolean {
		if (this.blocks.length === 0) return false;
		const wheelDirection = clankyTranscriptMouseScrollDirection(data);
		if (wheelDirection !== undefined) {
			this.scrollWheel(wheelDirection);
			return true;
		}
		if (isClankyTranscriptPageScrollInput(data, "up")) {
			this.scrollPage("up");
			return true;
		}
		if (isClankyTranscriptPageScrollInput(data, "down")) {
			this.scrollPage("down");
			return true;
		}
		if (matchesAny(data, Key.alt("up"), Key.ctrl("up"))) {
			this.moveSelection(-1);
			return true;
		}
		if (matchesAny(data, Key.alt("down"), Key.ctrl("down"))) {
			this.moveSelection(1);
			return true;
		}
		if (matchesAny(data, Key.alt("home"), Key.ctrl("home"))) {
			this.selectedIndex = 0;
			this.ensureSelectedVisible();
			return true;
		}
		if (matchesAny(data, Key.alt("end"), Key.ctrl("end"))) {
			this.selectedIndex = Math.max(0, this.blocks.length - 1);
			this.scrollToBottom();
			return true;
		}
		if (matchesAny(data, Key.alt("enter"), Key.alt("space"))) {
			this.toggleSelectedCollapsed();
			return true;
		}
		return false;
	}

	handleInput(data: string): void {
		const wheelDirection = clankyTranscriptMouseScrollDirection(data);
		if (wheelDirection !== undefined) {
			this.scrollWheel(wheelDirection);
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.moveSelection(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.moveSelection(1);
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.scrollPage("up");
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scrollPage("down");
			return;
		}
		if (matchesKey(data, Key.home)) {
			this.selectedIndex = 0;
			this.ensureSelectedVisible();
			return;
		}
		if (matchesKey(data, Key.end)) {
			this.selectedIndex = Math.max(0, this.blocks.length - 1);
			this.scrollToBottom();
			return;
		}
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.space) || data === "\r" || data === " ") {
			this.toggleSelectedCollapsed();
		}
	}

	render(width: number): string[] {
		this.lastWidth = width;
		this.prefixWidth = this.focused ? 2 : 0;
		const rendered = this.renderBlocks(width);
		const lines = rendered.flatMap((block) => block.lines);
		this.lastFlattened = lines;
		const maxRows = this.visibleRowCount(width);
		this.clampScrollback(width, lines.length, maxRows);
		let visible: string[];
		if (lines.length <= maxRows) {
			this.lastTopPad = maxRows - lines.length;
			this.lastWindowStart = 0;
			visible = [...Array.from({ length: this.lastTopPad }, () => ""), ...lines];
		} else {
			const end = Math.max(maxRows, lines.length - this.scrollbackRows);
			this.lastWindowStart = Math.max(0, end - maxRows);
			this.lastTopPad = 0;
			visible = lines.slice(this.lastWindowStart, end);
		}
		if (this.selection === null) return visible;
		return visible.map((line, index) => this.applyHighlight(line, this.lastWindowStart + index - this.lastTopPad));
	}

	selectionPress(row: number, col: number): void {
		const point = this.pointAt(row, col);
		this.selection = { anchor: point, head: point };
	}

	selectionDrag(row: number, col: number): void {
		if (this.selection === null) return;
		this.selection = { anchor: this.selection.anchor, head: this.pointAt(row, col) };
	}

	hasSelection(): boolean {
		if (this.selection === null) return false;
		const { anchor, head } = this.selection;
		return anchor.line !== head.line || anchor.col !== head.col;
	}

	clearSelection(): void {
		this.selection = null;
	}

	getSelectedText(): string {
		if (this.selection === null) return "";
		const [first, last] = orderSelectionPoints(this.selection.anchor, this.selection.head);
		const out: string[] = [];
		for (let line = first.line; line <= last.line; line++) {
			const text = this.lastFlattened[line];
			if (text === undefined) continue;
			const range = this.selectionColumns(first, last, line, text);
			out.push(range === null ? "" : stripAnsi(sliceByColumn(text, range[0], range[1] - range[0])).replace(/\s+$/u, ""));
		}
		return out.join("\n");
	}

	private pointAt(row: number, col: number): SelectionPoint {
		const line = clamp(this.lastWindowStart + row - this.lastTopPad, 0, Math.max(0, this.lastFlattened.length - 1));
		return { col: Math.max(0, col), line };
	}

	private applyHighlight(line: string, flatIndex: number): string {
		if (this.selection === null || flatIndex < 0) return line;
		const [first, last] = orderSelectionPoints(this.selection.anchor, this.selection.head);
		const range = this.selectionColumns(first, last, flatIndex, line);
		if (range === null) return line;
		const before = sliceByColumn(line, 0, range[0]);
		const middle = stripAnsi(sliceByColumn(line, range[0], range[1] - range[0]));
		const after = sliceByColumn(line, range[1], Number.MAX_SAFE_INTEGER);
		return `${before}${SELECTION_RESET}${SELECTION_INVERSE}${middle}${SELECTION_RESET}${after}`;
	}

	private selectionColumns(first: SelectionPoint, last: SelectionPoint, line: number, text: string): [number, number] | null {
		if (line < first.line || line > last.line) return null;
		const width = visibleWidth(text);
		const lo = Math.max(line === first.line ? first.col : 0, this.prefixWidth);
		const hi = Math.min(line === last.line ? last.col : width, width);
		return hi > lo ? [lo, hi] : null;
	}

	private handleFor(block: TranscriptBlock): ClankyTranscriptBlockHandle {
		return {
			remove: () => this.removeChild(block.component),
			scrollIntoView: () => {
				const index = this.blocks.indexOf(block);
				if (index < 0) return;
				this.selectedIndex = index;
				this.ensureSelectedVisible();
			},
			setCollapsed: (collapsed) => {
				if (!block.collapsible) return;
				block.collapsed = collapsed;
				this.ensureSelectedVisible();
			},
			toggleCollapsed: () => {
				if (!block.collapsible) return;
				block.collapsed = !block.collapsed;
				this.ensureSelectedVisible();
			},
		};
	}

	private moveSelection(delta: number): void {
		if (this.blocks.length === 0) return;
		this.selectedIndex = clamp(this.selectedIndex + delta, 0, this.blocks.length - 1);
		this.ensureSelectedVisible();
	}

	private toggleSelectedCollapsed(): void {
		const block = this.blocks[this.selectedIndex];
		if (block === undefined || !block.collapsible) return;
		block.collapsed = !block.collapsed;
		this.ensureSelectedVisible();
	}

	private ensureSelectedVisible(width = this.lastWidth): void {
		const rendered = this.renderBlocks(width);
		const selected = rendered[this.selectedIndex];
		if (selected === undefined) {
			this.clampScrollback(width);
			return;
		}
		const maxRows = this.visibleRowCount(width);
		const totalRows = rendered.length === 0 ? 0 : rendered[rendered.length - 1]?.end ?? 0;
		const currentEnd = Math.max(maxRows, totalRows - this.scrollbackRows);
		const currentStart = Math.max(0, currentEnd - maxRows);
		if (selected.start < currentStart) {
			this.scrollbackRows = totalRows - Math.min(totalRows, selected.start + maxRows);
		} else if (selected.end > currentEnd) {
			this.scrollbackRows = totalRows - selected.end;
		}
		this.clampScrollback(width, totalRows, maxRows);
	}

	private renderBlocks(width: number): RenderedBlock[] {
		const childWidth = Math.max(1, this.focused ? width - 2 : width);
		let cursor = 0;
		return this.blocks.map((block, index) => {
			const selected = index === this.selectedIndex;
			const rawLines = block.component.render(childWidth);
			const blockLines = block.collapsed ? collapsedLines(rawLines, childWidth, this.theme) : rawLines;
			const bodyLines = blockLines.map((line, lineIndex) => {
				if (!this.focused) return truncateToWidth(line, width, "", true);
				const marker = selected && lineIndex === 0 ? ">" : " ";
				const cursorMarker = selected && this.focused && lineIndex === 0 ? CURSOR_MARKER : "";
				const prefix = selected ? this.theme.selected(`${marker} `) : `${marker} `;
				return `${prefix}${cursorMarker}${truncateToWidth(line, childWidth, "", true)}`;
			});
			const spacer = index === 0 ? [] : Array.from({ length: this.blockSpacing }, () => "");
			const lines = [...spacer, ...bodyLines];
			const rendered = { block, end: cursor + lines.length, lines, start: cursor };
			cursor = rendered.end;
			return rendered;
		});
	}

	private visibleRowCount(width: number): number {
		return Math.max(1, Math.floor(this.maxRows(width)));
	}

	private clampScrollback(width: number, renderedRows?: number, maxRows?: number): void {
		const totalRows = renderedRows ?? this.renderBlocks(width).reduce((sum, block) => sum + block.lines.length, 0);
		const visibleRows = maxRows ?? this.visibleRowCount(width);
		const maxScrollback = Math.max(0, totalRows - visibleRows);
		this.scrollbackRows = clamp(this.scrollbackRows, 0, maxScrollback);
	}
}

export function isClankyTranscriptPageScrollInput(data: string, direction?: ScrollDirection): boolean {
	if (direction === "up") return matchesKey(data, Key.pageUp);
	if (direction === "down") return matchesKey(data, Key.pageDown);
	return matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown);
}

export function isClankyTranscriptMouseScrollInput(data: string, direction?: ScrollDirection): boolean {
	const actual = clankyTranscriptMouseScrollDirection(data);
	if (direction === undefined) return actual !== undefined;
	return actual === direction;
}

export function isClankySgrMouseInput(data: string): boolean {
	return parseClankySgrMouse(data) !== undefined;
}

export function clankyTranscriptMouseScrollDirection(data: string): ScrollDirection | undefined {
	const event = parseClankySgrMouse(data);
	return event?.kind === "wheel" ? event.wheelDirection : undefined;
}

function orderSelectionPoints(a: SelectionPoint, b: SelectionPoint): [SelectionPoint, SelectionPoint] {
	if (a.line < b.line || (a.line === b.line && a.col <= b.col)) return [a, b];
	return [b, a];
}

function stripAnsi(text: string): string {
	return text
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu, "")
		.replace(/\x1b[_P^][^\x07\x1b]*(?:\x07|\x1b\\)/gu, "")
		.replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/gu, "")
		.replace(/\x1b./gu, "");
}

function collapsedLines(lines: readonly string[], width: number, theme: ClankyTranscriptViewportTheme): string[] {
	if (lines.length <= 1) return [...lines];
	const first = lines[0] ?? "";
	const hidden = lines.length - 1;
	return [
		truncateToWidth(first, width, "", true),
		theme.dim(truncateToWidth(`... ${hidden} hidden lines`, width, "", true)),
	];
}

function matchesAny(data: string, ...keys: KeyId[]): boolean {
	return keys.some((key) => matchesKey(data, key));
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}
