import {
	CURSOR_MARKER,
	Key,
	matchesKey,
	truncateToWidth,
	type Component,
	type Focusable,
	type KeyId,
} from "@earendil-works/pi-tui";

export type ClankyTranscriptViewportTheme = {
	readonly dim: (text: string) => string;
	readonly selected: (text: string) => string;
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

const DEFAULT_THEME: ClankyTranscriptViewportTheme = {
	dim: (text) => `\x1b[2m${text}\x1b[22m`,
	selected: (text) => `\x1b[36m${text}\x1b[39m`,
};
const WHEEL_SCROLL_ROWS = 3;

export class ClankyTranscriptViewport implements Component, Focusable {
	private readonly blocks: TranscriptBlock[] = [];
	private readonly maxRows: (width: number) => number;
	private readonly theme: ClankyTranscriptViewportTheme;
	private nextBlockId = 1;
	private scrollbackRows = 0;
	private selectedIndex = 0;
	private lastWidth = 80;
	focused = false;

	constructor(maxRows: (width: number) => number, theme: Partial<ClankyTranscriptViewportTheme> = {}) {
		this.maxRows = maxRows;
		this.theme = { ...DEFAULT_THEME, ...theme };
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
		this.clampScrollback(this.lastWidth);
	}

	clear(): void {
		this.blocks.length = 0;
		this.scrollbackRows = 0;
		this.selectedIndex = 0;
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
		const rendered = this.renderBlocks(width);
		const lines = rendered.flatMap((block) => block.lines);
		const maxRows = this.visibleRowCount(width);
		this.clampScrollback(width, lines.length, maxRows);
		if (lines.length <= maxRows) return [...Array.from({ length: maxRows - lines.length }, () => ""), ...lines];
		const end = Math.max(maxRows, lines.length - this.scrollbackRows);
		const start = Math.max(0, end - maxRows);
		return lines.slice(start, end);
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
			const rendered = { block, end: cursor + bodyLines.length, lines: bodyLines, start: cursor };
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
	return /^\x1b\[<\d+;\d+;\d+[Mm]$/u.test(data);
}

export function clankyTranscriptMouseScrollDirection(data: string): ScrollDirection | undefined {
	const match = /^\x1b\[<(\d+);\d+;\d+M$/u.exec(data);
	if (match === null) return undefined;
	const button = Number.parseInt(match[1] ?? "", 10);
	if (!Number.isSafeInteger(button) || (button & 64) !== 64) return undefined;
	const wheelButton = button & 3;
	if (wheelButton === 0) return "up";
	if (wheelButton === 1) return "down";
	return undefined;
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
