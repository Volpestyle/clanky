import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveClankyDataPath } from "./paths.ts";

export const DEFAULT_PROMPT_HISTORY_MAX_ENTRIES = 100;
const PROMPT_HISTORY_RELATIVE_PATH = "tui/prompt-history.jsonl";

export interface PromptHistoryLike {
	add(entry: string): void;
	begin(draft: string): void;
	previous(currentDraft: string): string | undefined;
	next(): string | undefined;
}

export interface PromptHistoryConstructor {
	prototype: PromptHistoryLike;
}

interface PromptHistoryState {
	entries: string[];
	cursor: number;
	draft: string;
}

interface PromptHistoryPrototypeOptions {
	readonly entries?: readonly string[];
	readonly maxEntries?: number;
	readonly onEntryAdded?: (entry: string) => void;
	readonly onEntriesChanged?: (entries: readonly string[]) => void;
}

interface PromptHistoryInstallOptions {
	readonly env?: NodeJS.ProcessEnv;
	readonly filePath?: string;
	readonly maxEntries?: number;
}

export async function installClankyPromptHistory(
	PromptHistoryClass: PromptHistoryConstructor,
	options: PromptHistoryInstallOptions = {},
): Promise<void> {
	const maxEntries = normalizedMaxEntries(options.maxEntries);
	const filePath = options.filePath ?? resolveClankyDataPath(PROMPT_HISTORY_RELATIVE_PATH, options.env);
	const entries = await readPromptHistoryFile(filePath, maxEntries);
	let persistence = Promise.resolve();
	const enqueue = (task: () => Promise<void>): void => {
		persistence = persistence.then(task, task).catch(() => undefined);
	};
	installPromptHistoryPrototype(PromptHistoryClass, {
		entries,
		maxEntries,
		onEntryAdded: (entry) => enqueue(async () => await appendPromptHistoryEntry(filePath, entry)),
		onEntriesChanged: (nextEntries) => enqueue(async () => await writePromptHistoryFile(filePath, nextEntries)),
	});
}

export function installPromptHistoryPrototype(
	PromptHistoryClass: PromptHistoryConstructor,
	options: PromptHistoryPrototypeOptions = {},
): void {
	const maxEntries = normalizedMaxEntries(options.maxEntries);
	const seed = normalizePromptHistoryEntries(options.entries ?? [], maxEntries);
	const states = new WeakMap<PromptHistoryLike, PromptHistoryState>();
	const stateFor = (history: PromptHistoryLike): PromptHistoryState => {
		const existing = states.get(history);
		if (existing !== undefined) return existing;
		const state = { entries: [...seed], cursor: seed.length, draft: "" };
		states.set(history, state);
		return state;
	};

	PromptHistoryClass.prototype.add = function add(entry: string): void {
		const state = stateFor(this);
		if (entry.trim().length === 0) {
			resetPromptHistoryNavigation(state);
			return;
		}
		if (state.entries.at(-1) === entry) {
			resetPromptHistoryNavigation(state);
			return;
		}
		state.entries.push(entry);
		const trimmed = state.entries.length > maxEntries;
		if (trimmed) state.entries = state.entries.slice(-maxEntries);
		resetPromptHistoryNavigation(state);
		if (trimmed) options.onEntriesChanged?.([...state.entries]);
		else options.onEntryAdded?.(entry);
	};

	PromptHistoryClass.prototype.begin = function begin(draft: string): void {
		const state = stateFor(this);
		state.cursor = state.entries.length;
		state.draft = draft;
	};

	PromptHistoryClass.prototype.previous = function previous(currentDraft: string): string | undefined {
		const state = stateFor(this);
		if (state.entries.length === 0) return undefined;
		if (state.cursor === state.entries.length) state.draft = currentDraft;
		if (state.cursor === 0) return undefined;
		state.cursor -= 1;
		return state.entries[state.cursor];
	};

	PromptHistoryClass.prototype.next = function next(): string | undefined {
		const state = stateFor(this);
		if (state.cursor >= state.entries.length) return undefined;
		state.cursor += 1;
		if (state.cursor === state.entries.length) return state.draft;
		return state.entries[state.cursor];
	};
}

function resetPromptHistoryNavigation(state: PromptHistoryState): void {
	state.cursor = state.entries.length;
	state.draft = "";
}

export async function readPromptHistoryFile(filePath: string, maxEntries = DEFAULT_PROMPT_HISTORY_MAX_ENTRIES): Promise<string[]> {
	let text: string;
	try {
		text = await readFile(filePath, "utf8");
	} catch {
		return [];
	}
	const entries = parsePromptHistoryJsonl(text, maxEntries);
	if (formatPromptHistoryJsonl(entries) !== text) {
		await writePromptHistoryFile(filePath, entries).catch(() => undefined);
	}
	return entries;
}

export async function appendPromptHistoryEntry(filePath: string, entry: string): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
	await appendFile(filePath, `${JSON.stringify({ prompt: entry })}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function writePromptHistoryFile(filePath: string, entries: readonly string[]): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
	await writeFile(filePath, formatPromptHistoryJsonl(entries), { encoding: "utf8", mode: 0o600 });
}

export function parsePromptHistoryJsonl(text: string, maxEntries = DEFAULT_PROMPT_HISTORY_MAX_ENTRIES): string[] {
	const entries: string[] = [];
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		const entry = parsePromptHistoryLine(line);
		if (entry !== undefined) entries.push(entry);
	}
	return normalizePromptHistoryEntries(entries, maxEntries);
}

export function formatPromptHistoryJsonl(entries: readonly string[]): string {
	const normalized = normalizePromptHistoryEntries(entries);
	if (normalized.length === 0) return "";
	return `${normalized.map((prompt) => JSON.stringify({ prompt })).join("\n")}\n`;
}

export function normalizePromptHistoryEntries(
	entries: readonly string[],
	maxEntries = DEFAULT_PROMPT_HISTORY_MAX_ENTRIES,
): string[] {
	const normalized: string[] = [];
	for (const entry of entries) {
		if (entry.trim().length === 0) continue;
		if (normalized.at(-1) === entry) continue;
		normalized.push(entry);
	}
	return normalized.slice(-normalizedMaxEntries(maxEntries));
}

function parsePromptHistoryLine(line: string): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof parsed === "string") return parsed;
	if (!isRecord(parsed)) return undefined;
	return typeof parsed.prompt === "string" ? parsed.prompt : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedMaxEntries(value: number | undefined): number {
	return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_PROMPT_HISTORY_MAX_ENTRIES;
}
