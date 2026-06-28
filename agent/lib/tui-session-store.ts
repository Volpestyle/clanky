import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionState } from "eve/client";

export interface TuiSessionEntry {
	readonly id: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly label?: string;
	readonly lastPrompt?: string;
	readonly session: SessionState;
}

export interface TuiSessionStore {
	readonly version: 1;
	readonly entries: readonly TuiSessionEntry[];
}

export async function readTuiSessionStore(
	path: string,
	options: { readonly maxAgeMs?: number } = {},
): Promise<TuiSessionStore> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (isNodeErrorCode(error, "ENOENT")) return emptyStore();
		throw error;
	}
	const parsed = JSON.parse(raw) as unknown;
	if (!isRecord(parsed) || !Array.isArray(parsed.entries)) return emptyStore();
	const entries = parsed.entries.filter(isTuiSessionEntry);
	const maxAgeMs = options.maxAgeMs;
	if (maxAgeMs === undefined || !(maxAgeMs > 0)) return { version: 1, entries };
	const cutoff = Date.now() - maxAgeMs;
	return {
		version: 1,
		entries: entries.filter((entry) => Date.parse(entry.updatedAt) >= cutoff),
	};
}

export async function rememberTuiSession(
	path: string,
	input: {
		readonly label?: string;
		readonly lastPrompt?: string;
		readonly session: SessionState;
	},
	options: { readonly limit?: number; readonly maxAgeMs?: number } = {},
): Promise<TuiSessionEntry | undefined> {
	const id = sessionStateId(input.session);
	if (id === undefined) return undefined;
	const now = new Date().toISOString();
	const store = await readTuiSessionStore(path, { maxAgeMs: options.maxAgeMs });
	const existing = store.entries.find((entry) => entry.id === id);
	const next: TuiSessionEntry = {
		id,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
		...optionalEntryField("label", input.label, existing?.label),
		...optionalEntryField("lastPrompt", input.lastPrompt, existing?.lastPrompt),
		session: input.session,
	};
	const limit = Math.max(1, Math.floor(options.limit ?? 20));
	const entries = [next, ...store.entries.filter((entry) => entry.id !== id)]
		.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
		.slice(0, limit);
	await writeTuiSessionStore(path, { version: 1, entries });
	return next;
}

export function sessionStateId(state: SessionState): string | undefined {
	const sessionId = state.sessionId?.trim();
	if (sessionId !== undefined && sessionId.length > 0) return sessionId;
	const continuationToken = state.continuationToken?.trim();
	return continuationToken !== undefined && continuationToken.length > 0 ? continuationToken : undefined;
}

async function writeTuiSessionStore(path: string, store: TuiSessionStore): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

function emptyStore(): TuiSessionStore {
	return { version: 1, entries: [] };
}

function isTuiSessionEntry(value: unknown): value is TuiSessionEntry {
	if (!isRecord(value) || !isRecord(value.session)) return false;
	if (typeof value.id !== "string" || value.id.trim().length === 0) return false;
	if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return false;
	if (value.label !== undefined && typeof value.label !== "string") return false;
	if (value.lastPrompt !== undefined && typeof value.lastPrompt !== "string") return false;
	if (value.session.sessionId !== undefined && typeof value.session.sessionId !== "string") return false;
	if (value.session.continuationToken !== undefined && typeof value.session.continuationToken !== "string") return false;
	const streamIndex = value.session.streamIndex;
	return typeof streamIndex === "number" && Number.isInteger(streamIndex) && streamIndex >= 0;
}

function optionalEntryField<Key extends "label" | "lastPrompt">(
	key: Key,
	nextValue: string | undefined,
	existingValue: string | undefined,
): Partial<Pick<TuiSessionEntry, Key>> {
	const value = nextValue ?? existingValue;
	return value === undefined ? {} : { [key]: value } as Partial<Pick<TuiSessionEntry, Key>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
