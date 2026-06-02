import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
	type FileEntry,
	parseSessionEntries,
	type SessionHeader,
	type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { ClankyPaths } from "../paths.ts";
import { loadDatabaseSync } from "../sqlite.ts";

export type SessionIndexRole = "user" | "assistant" | "toolResult";

export interface SessionIndexMessageInput {
	sessionId: string;
	role: SessionIndexRole;
	text: string;
	cwd: string;
	createdAt?: string;
	sessionFile?: string;
	messageKey?: string;
}

export interface SessionSearchResult {
	sessionId: string;
	role: SessionIndexRole;
	text: string;
	snippet: string;
	cwd: string;
	createdAt: string;
	sessionFile?: string;
	messageKey?: string;
}

export interface SessionSearchOptions {
	query: string;
	limit?: number;
}

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;

export class SessionIndexStore {
	private readonly paths: ClankyPaths;
	private db: DatabaseSync | undefined;

	constructor(paths: ClankyPaths) {
		this.paths = paths;
	}

	async recordMessage(input: SessionIndexMessageInput): Promise<void> {
		const text = input.text.trim();
		if (text.length === 0) return;
		await this.ensure();
		const db = this.database();
		const createdAt = input.createdAt ?? new Date().toISOString();
		const messageKey = input.messageKey ?? stableMessageKey(input.sessionId, input.role, createdAt, text);
		db.prepare(`
			INSERT OR IGNORE INTO sessions (session_id, cwd, session_file, updated_at)
			VALUES (?, ?, ?, ?)
		`).run(input.sessionId, input.cwd, input.sessionFile ?? null, createdAt);
		db.prepare(`
			UPDATE sessions
			SET cwd = ?, session_file = COALESCE(?, session_file), updated_at = ?
			WHERE session_id = ?
		`).run(input.cwd, input.sessionFile ?? null, createdAt, input.sessionId);
		db.prepare(`
			INSERT OR IGNORE INTO session_messages (
				message_key,
				session_id,
				role,
				text,
				session_file,
				cwd,
				created_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`).run(messageKey, input.sessionId, input.role, text, input.sessionFile ?? null, input.cwd, createdAt);
	}

	async indexSessionFile(sessionFile: string): Promise<number> {
		const content = await readFile(sessionFile, "utf8").catch(() => undefined);
		if (content === undefined) return 0;
		const entries = parseSessionEntries(content);
		const header = entries.find(isSessionHeader);
		const sessionId = header?.id ?? extractSessionId(sessionFile);
		if (sessionId === undefined) return 0;
		const cwd = header?.cwd ?? "";
		let indexed = 0;
		for (const entry of entries) {
			if (!isSessionMessageEntry(entry)) continue;
			const extracted = extractIndexableMessageText(entry.message);
			if (extracted === undefined) continue;
			await this.recordMessage({
				sessionId,
				role: extracted.role,
				text: extracted.text,
				cwd,
				createdAt: entry.timestamp,
				sessionFile,
				messageKey: `${sessionId}:${entry.id}`,
			});
			indexed += 1;
		}
		return indexed;
	}

	async indexSessionDirectory(sessionDir: string): Promise<number> {
		const files = await readdir(sessionDir).catch(() => []);
		let indexed = 0;
		for (const file of files) {
			if (!file.endsWith(".jsonl")) continue;
			indexed += await this.indexSessionFile(join(sessionDir, file));
		}
		return indexed;
	}

	async search(options: SessionSearchOptions): Promise<SessionSearchResult[]> {
		const query = options.query.trim();
		if (query.length === 0) return [];
		await this.ensure();
		const db = this.database();
		const limit = normalizedLimit(options.limit);
		try {
			const rows = db
				.prepare(`
					SELECT
						session_id,
						role,
						text,
						snippet(session_messages_fts, 2, '', '', '...', 18) AS snippet,
						session_file,
						cwd,
						created_at,
						message_key
					FROM session_messages_fts
					WHERE session_messages_fts MATCH ?
					ORDER BY bm25(session_messages_fts)
					LIMIT ?
				`)
				.all(buildFtsQuery(query), limit);
			return rows.map(readSearchRow).filter((row): row is SessionSearchResult => row !== undefined);
		} catch {
			const rows = db
				.prepare(`
					SELECT
						session_id,
						role,
						text,
						text AS snippet,
						session_file,
						cwd,
						created_at,
						message_key
					FROM session_messages
					WHERE lower(text) LIKE ?
					ORDER BY created_at DESC
					LIMIT ?
				`)
				.all(`%${query.toLowerCase()}%`, limit);
			return rows.map(readSearchRow).filter((row): row is SessionSearchResult => row !== undefined);
		}
	}

	async ensure(): Promise<void> {
		await mkdir(dirname(this.paths.indexDbFile), { recursive: true, mode: 0o700 });
		const db = this.database();
		db.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA foreign_keys = ON;
			CREATE TABLE IF NOT EXISTS sessions (
				session_id TEXT PRIMARY KEY,
				cwd TEXT NOT NULL,
				session_file TEXT,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS session_messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				message_key TEXT NOT NULL UNIQUE,
				session_id TEXT NOT NULL,
				role TEXT NOT NULL,
				text TEXT NOT NULL,
				session_file TEXT,
				cwd TEXT NOT NULL,
				created_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_session_messages_session_id
				ON session_messages (session_id);
			CREATE INDEX IF NOT EXISTS idx_session_messages_created_at
				ON session_messages (created_at);
			CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5(
				session_id UNINDEXED,
				role UNINDEXED,
				text,
				session_file UNINDEXED,
				cwd UNINDEXED,
				created_at UNINDEXED,
				message_key UNINDEXED,
				tokenize = 'unicode61'
			);
			CREATE TRIGGER IF NOT EXISTS session_messages_ai
			AFTER INSERT ON session_messages
			BEGIN
				INSERT INTO session_messages_fts (
					session_id,
					role,
					text,
					session_file,
					cwd,
					created_at,
					message_key
				)
				VALUES (
					new.session_id,
					new.role,
					new.text,
					new.session_file,
					new.cwd,
					new.created_at,
					new.message_key
				);
			END;
		`);
	}

	close(): void {
		if (this.db === undefined) return;
		this.db.close();
		this.db = undefined;
	}

	private database(): DatabaseSync {
		if (this.db !== undefined) return this.db;
		const Database = loadDatabaseSync();
		this.db = new Database(this.paths.indexDbFile);
		return this.db;
	}
}

export function extractIndexableMessageText(message: SessionMessageEntry["message"]):
	| {
			role: SessionIndexRole;
			text: string;
	  }
	| undefined {
	if (message.role === "user") {
		const text = contentText(message.content).trim();
		return text.length === 0 ? undefined : { role: "user", text };
	}
	if (message.role === "assistant") {
		const text = contentText(message.content).trim();
		return text.length === 0 ? undefined : { role: "assistant", text };
	}
	if (message.role === "toolResult") {
		const text = contentText(message.content).trim();
		return text.length === 0 ? undefined : { role: "toolResult", text };
	}
	return undefined;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const candidate = block as Record<string, unknown>;
		if (candidate.type !== "text" || typeof candidate.text !== "string") continue;
		parts.push(candidate.text);
	}
	return parts.join("\n");
}

function buildFtsQuery(query: string): string {
	return query
		.split(/\s+/)
		.map((term) => `"${term.replaceAll('"', '""')}"`)
		.join(" AND ");
}

function normalizedLimit(limit: number | undefined): number {
	if (limit === undefined) return DEFAULT_SEARCH_LIMIT;
	if (!Number.isInteger(limit) || limit <= 0) return DEFAULT_SEARCH_LIMIT;
	return Math.min(limit, MAX_SEARCH_LIMIT);
}

function stableMessageKey(sessionId: string, role: SessionIndexRole, createdAt: string, text: string): string {
	const hash = createHash("sha256").update(text).digest("hex").slice(0, 32);
	return `${sessionId}:${role}:${createdAt}:${hash}`;
}

function readSearchRow(row: Record<string, unknown>): SessionSearchResult | undefined {
	const sessionId = readString(row, "session_id");
	const role = readRole(row.role);
	const text = readString(row, "text");
	const cwd = readString(row, "cwd");
	const createdAt = readString(row, "created_at");
	if (
		sessionId === undefined ||
		role === undefined ||
		text === undefined ||
		cwd === undefined ||
		createdAt === undefined
	) {
		return undefined;
	}
	const result: SessionSearchResult = {
		sessionId,
		role,
		text,
		snippet: readString(row, "snippet") ?? text,
		cwd,
		createdAt,
	};
	const sessionFile = readString(row, "session_file");
	if (sessionFile !== undefined) result.sessionFile = sessionFile;
	const messageKey = readString(row, "message_key");
	if (messageKey !== undefined) result.messageKey = messageKey;
	return result;
}

function readString(row: Record<string, unknown>, key: string): string | undefined {
	const value = row[key];
	return typeof value === "string" ? value : undefined;
}

function readRole(value: unknown): SessionIndexRole | undefined {
	if (value === "user" || value === "assistant" || value === "toolResult") return value;
	return undefined;
}

function isSessionHeader(entry: FileEntry): entry is SessionHeader {
	return entry.type === "session";
}

function isSessionMessageEntry(entry: FileEntry): entry is SessionMessageEntry {
	return entry.type === "message";
}

function extractSessionId(sessionFile: string): string | undefined {
	const name = sessionFile.slice(sessionFile.lastIndexOf("/") + 1);
	const withoutExtension = name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : name;
	const separator = withoutExtension.lastIndexOf("_");
	if (separator === -1) return undefined;
	return withoutExtension.slice(separator + 1);
}
