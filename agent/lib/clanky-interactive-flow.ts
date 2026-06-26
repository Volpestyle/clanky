import {
	CURSOR_MARKER,
	decodeKittyPrintable,
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	type Component,
	type Focusable,
	type SelectListTheme,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export type InteractivePromptOption = {
	readonly value: string;
	readonly label: string;
	readonly hint?: string;
	readonly description?: string;
};

export type InteractiveTextPromptOptions = {
	readonly message: string;
	readonly defaultValue?: string;
	readonly placeholder?: string;
	readonly error?: string;
	readonly onCancel: () => void;
	readonly onRender: () => void;
	readonly onSubmit: (value: string) => void;
};

export type InteractiveSelectPromptOptions = {
	readonly kind: "multi" | "single";
	readonly message: string;
	readonly options: readonly InteractivePromptOption[];
	readonly initialValue?: string;
	readonly initialValues?: readonly string[];
	readonly required?: boolean;
	readonly theme: SelectListTheme;
	readonly onCancel: () => void;
	readonly onRender: () => void;
	readonly onSubmit: (values: readonly string[]) => void;
};

type IndexedOption = {
	readonly index: number;
	readonly option: InteractivePromptOption;
};

const FILTER_HINT = "Type to filter. Enter accepts. Esc cancels.";
const MULTI_FILTER_HINT = "Type to filter. Space toggles. Ctrl+A selects all. Enter accepts. Esc cancels.";

export class InteractiveTextPrompt implements Component, Focusable {
	private readonly input = new Input();
	private readonly options: InteractiveTextPromptOptions;

	private _focused = false;

	constructor(options: InteractiveTextPromptOptions) {
		this.options = options;
		this.input.setValue(options.defaultValue ?? "");
		this.input.onSubmit = (value) => options.onSubmit(value);
		this.input.onEscape = options.onCancel;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	invalidate(): void {
		this.input.invalidate();
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
		this.options.onRender();
	}

	render(width: number): string[] {
		const contentWidth = Math.max(1, width - 2);
		const lines = [
			...promptHeader("Input", this.options.message, contentWidth),
			...(this.options.defaultValue === undefined ? [] : [dim(`Default: ${this.options.defaultValue}`)]),
			...(this.options.placeholder === undefined ? [] : [dim(`Placeholder: ${this.options.placeholder}`)]),
			...(this.options.error === undefined ? [] : [errorLine(this.options.error)]),
			"",
			...this.input.render(contentWidth),
			dim("Enter accepts. Esc cancels."),
		];
		return boxLines(lines, width);
	}
}

export class InteractiveSelectPrompt implements Component, Focusable {
	private readonly options: InteractiveSelectPromptOptions;
	private readonly selectedValues: Set<string>;
	focused = false;
	private cursorIndex = 0;
	private filter = "";
	private error: string | undefined;

	constructor(options: InteractiveSelectPromptOptions) {
		this.options = options;
		this.selectedValues = new Set(options.kind === "multi" ? options.initialValues ?? [] : []);
		const initialValue = options.initialValue;
		if (options.kind === "single" && initialValue !== undefined) {
			const index = options.options.findIndex((option) => option.value === initialValue);
			if (index >= 0) this.cursorIndex = index;
		}
	}

	invalidate(): void {
		// Rendering is derived directly from current state.
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.options.onCancel();
			return;
		}
		if (matchesKey(data, Key.enter) || data === "\n" || data === "\r") {
			this.submit();
			return;
		}
		if (this.options.kind === "multi" && (matchesKey(data, Key.space) || data === " ")) {
			this.toggleCurrent();
			this.options.onRender();
			return;
		}
		if (this.options.kind === "multi" && (matchesKey(data, Key.ctrl("a")) || data === "\x01")) {
			this.toggleAllFiltered();
			this.error = undefined;
			this.options.onRender();
			return;
		}
		if (matchesKey(data, Key.home)) {
			this.cursorIndex = 0;
			this.options.onRender();
			return;
		}
		if (matchesKey(data, Key.end)) {
			this.cursorIndex = Math.max(0, this.filteredOptions().length - 1);
			this.options.onRender();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.moveCursor(-1);
			this.options.onRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.moveCursor(1);
			this.options.onRender();
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.moveCursor(-8);
			this.options.onRender();
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.moveCursor(8);
			this.options.onRender();
			return;
		}
		if (matchesKey(data, Key.backspace) || data === "\x7f") {
			this.filter = this.filter.slice(0, -1);
			this.cursorIndex = 0;
			this.error = undefined;
			this.options.onRender();
			return;
		}
		if (matchesKey(data, Key.ctrl("u")) || data === "\x15") {
			this.filter = "";
			this.cursorIndex = 0;
			this.error = undefined;
			this.options.onRender();
			return;
		}
		const printable = decodeKittyPrintable(data) ?? printableInput(data);
		if (printable !== undefined) {
			this.filter += printable;
			this.cursorIndex = 0;
			this.error = undefined;
			this.options.onRender();
		}
	}

	render(width: number): string[] {
		const contentWidth = Math.max(1, width - 2);
		const filtered = this.filteredOptions();
		const hint = this.options.kind === "multi" ? MULTI_FILTER_HINT : FILTER_HINT;
		const lines = [
			...promptHeader(this.options.kind === "multi" ? "Select values" : "Select value", this.options.message, contentWidth),
			dim(this.filterStatusLine(filtered.length, hint)),
			...(this.error === undefined ? [] : [errorLine(this.error)]),
			"",
			...this.renderItems(filtered, contentWidth),
			...this.renderCurrentDetail(filtered, contentWidth),
		];
		return boxLines(lines, width);
	}

	private filteredOptions(): IndexedOption[] {
		const normalized = this.filter.trim().toLowerCase();
		const indexed = this.options.options.map((option, index) => ({ index, option }));
		if (normalized.length === 0) return indexed;
		return indexed.filter(({ option }) => optionSearchText(option).includes(normalized));
	}

	private renderItems(items: readonly IndexedOption[], width: number): string[] {
		if (items.length === 0) return [this.options.theme.noMatch("  No matching options")];
		this.cursorIndex = clamp(this.cursorIndex, 0, items.length - 1);
		const maxVisible = Math.min(12, items.length);
		const startIndex = clamp(this.cursorIndex - Math.floor(maxVisible / 2), 0, Math.max(0, items.length - maxVisible));
		const visible = items.slice(startIndex, startIndex + maxVisible);
		const rows = visible.map((item, visibleIndex) => this.renderItem(item, startIndex + visibleIndex === this.cursorIndex, width));
		if (items.length > maxVisible) rows.push(this.options.theme.scrollInfo(`  (${this.cursorIndex + 1}/${items.length})`));
		return rows;
	}

	private renderItem(item: IndexedOption, active: boolean, width: number): string {
		const selected = this.selectedValues.has(item.option.value);
		const marker = this.options.kind === "multi" ? (selected ? "[x]" : "[ ]") : `${item.index + 1}.`;
		const label = `${marker} ${item.option.label}`;
		const details = [item.option.hint, item.option.description].filter((part): part is string => part !== undefined && part.length > 0).join(" - ");
		const prefix = active ? "> " : "  ";
		const available = Math.max(1, width - prefix.length);
		const detailText = details.length === 0 ? "" : `  ${details}`;
		const row = truncateToWidth(`${label}${detailText}`, available, "");
		return active ? this.options.theme.selectedText(`${prefix}${row}`) : `${prefix}${row}`;
	}

	private renderCurrentDetail(items: readonly IndexedOption[], width: number): string[] {
		const current = items[this.cursorIndex]?.option;
		if (current === undefined) return [];
		const details = [current.hint, current.description].filter((part): part is string => part !== undefined && part.length > 0);
		if (details.length === 0) return [];
		const wrapped = details.flatMap((detail) => wrapTextWithAnsi(detail, Math.max(1, width - 4)));
		return ["", ...wrapped.slice(0, 4).map((line) => dim(`  ${line}`))];
	}

	private filterStatusLine(filteredCount: number, hint: string): string {
		const cursor = this.focused ? CURSOR_MARKER : "";
		const count = `${filteredCount}/${this.options.options.length}`;
		const selected = this.options.kind === "multi" ? ` | ${this.selectedValues.size} selected` : "";
		if (this.filter.length === 0) return `${count}${selected}${cursor} | ${hint}`;
		return `${count}${selected} | Filter: ${this.filter}${cursor} | Ctrl+U clears`;
	}

	private moveCursor(delta: number): void {
		const filteredLength = this.filteredOptions().length;
		if (filteredLength === 0) {
			this.cursorIndex = 0;
			return;
		}
		this.cursorIndex = (this.cursorIndex + delta + filteredLength) % filteredLength;
	}

	private toggleCurrent(): void {
		const current = this.currentOption();
		if (current === undefined) return;
		if (this.selectedValues.has(current.value)) this.selectedValues.delete(current.value);
		else this.selectedValues.add(current.value);
		this.error = undefined;
	}

	private toggleAllFiltered(): void {
		const values = this.filteredOptions().map(({ option }) => option.value);
		if (values.length === 0) return;
		const allSelected = values.every((value) => this.selectedValues.has(value));
		for (const value of values) {
			if (allSelected) this.selectedValues.delete(value);
			else this.selectedValues.add(value);
		}
	}

	private submit(): void {
		if (this.options.kind === "single") {
			const current = this.currentOption();
			if (current !== undefined) {
				this.options.onSubmit([current.value]);
				return;
			}
			if (this.options.required === true) {
				this.error = "A selection is required.";
				this.options.onRender();
				return;
			}
			this.options.onSubmit([]);
			return;
		}
		const values = [...this.selectedValues];
		if (values.length === 0 && this.options.required === true) {
			this.error = "Select at least one option.";
			this.options.onRender();
			return;
		}
		this.options.onSubmit(values);
	}

	private currentOption(): InteractivePromptOption | undefined {
		return this.filteredOptions()[this.cursorIndex]?.option;
	}
}

function promptHeader(title: string, message: string, width: number): string[] {
	return [bold(title), "", ...wrapPromptMessage(message, width)];
}

function wrapPromptMessage(message: string, width: number): string[] {
	const lines: string[] = [];
	for (const raw of message.split("\n")) {
		const wrapped = wrapTextWithAnsi(raw, width);
		lines.push(...(wrapped.length === 0 ? [""] : wrapped));
	}
	return lines;
}

function boxLines(lines: readonly string[], width: number): string[] {
	const contentWidth = Math.max(1, width - 2);
	return lines.map((line) => ` ${truncateToWidth(line, contentWidth, "", true)}`);
}

function optionSearchText(option: InteractivePromptOption): string {
	return [option.value, option.label, option.hint ?? "", option.description ?? ""].join(" ").toLowerCase();
}

function printableInput(data: string): string | undefined {
	if (data.length === 0) return undefined;
	return [...data].every((char) => {
		const code = char.charCodeAt(0);
		return code >= 32 && code !== 127 && (code < 0x80 || code > 0x9f);
	}) ? data : undefined;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}

function bold(text: string): string {
	return `\x1b[1m${text}\x1b[22m`;
}

function dim(text: string): string {
	return `\x1b[2m${text}\x1b[22m`;
}

function errorLine(text: string): string {
	return `\x1b[31m${text}\x1b[39m`;
}
