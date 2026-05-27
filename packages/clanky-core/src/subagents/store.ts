import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ClankyPaths } from "../paths.ts";
import { loadDatabaseSync } from "../sqlite.ts";

export type ClankySubagentKind = string;
export type ClankySubagentState = "idle" | "queued" | "running" | "failed" | "stale";
export type DiscordInboxStatus = "queued" | "claimed" | "answered" | "failed";

export interface DiscordInboxAttachment {
	url?: string;
	filename?: string;
	mime?: string;
	contentType?: string;
}

export interface EnqueueDiscordInboxMessageInput {
	workerId: string;
	kind: ClankySubagentKind;
	scopeId: string;
	scopeName?: string;
	guildId?: string;
	guildName?: string;
	conversationId: string;
	conversationName?: string;
	conversationKind: string;
	conversationThreadId?: string;
	conversationParentId?: string;
	senderId: string;
	senderName?: string;
	externalMessageId: string;
	replyToExternalMessageId?: string;
	acceptanceReason: string;
	text: string;
	attachments?: DiscordInboxAttachment[];
	priority?: number;
	receivedAt?: string;
}

export interface DiscordInboxMessage {
	id: string;
	workerId: string;
	kind: ClankySubagentKind;
	scopeId: string;
	scopeName?: string;
	guildId?: string;
	guildName?: string;
	conversationId: string;
	conversationName?: string;
	conversationKind: string;
	conversationThreadId?: string;
	conversationParentId?: string;
	senderId: string;
	senderName?: string;
	externalMessageId: string;
	replyToExternalMessageId?: string;
	acceptanceReason: string;
	text: string;
	attachments: DiscordInboxAttachment[];
	status: DiscordInboxStatus;
	priority: number;
	receivedAt: string;
	claimedAt?: string;
	finishedAt?: string;
	error?: string;
	responseExternalMessageId?: string;
}

export interface UpsertSubagentInput {
	id: string;
	kind: ClankySubagentKind;
	scopeId: string;
	scopeName?: string;
	state: ClankySubagentState;
	activeConversationId?: string;
	activeSummary?: string;
	sessionFile?: string;
	thinkingLevel?: string;
	pid?: number;
	lastHeartbeatAt?: string;
	lastError?: string;
}

export interface ClankySubagentSummary {
	id: string;
	kind: ClankySubagentKind;
	scopeId: string;
	state: ClankySubagentState;
	queueDepth: number;
	createdAt: string;
	updatedAt: string;
	scopeName?: string;
	activeConversationId?: string;
	activeSummary?: string;
	sessionFile?: string;
	thinkingLevel?: string;
	pid?: number;
	lastHeartbeatAt?: string;
	lastError?: string;
}

interface SqliteRunResult {
	changes: number;
}

export class DiscordSubagentStore {
	private readonly paths: ClankyPaths;
	private db: DatabaseSync | undefined;

	constructor(paths: ClankyPaths) {
		this.paths = paths;
	}

	async enqueueDiscordMessage(input: EnqueueDiscordInboxMessageInput): Promise<DiscordInboxMessage> {
		await this.ensure();
		const message = normalizeDiscordInboxInput(input);
		const db = this.database();
		const insertResult = db
			.prepare(`
				INSERT OR IGNORE INTO discord_inbox (
					id,
					worker_id,
					kind,
					scope_id,
					scope_name,
					guild_id,
					guild_name,
					conversation_id,
					conversation_name,
					conversation_kind,
					conversation_thread_id,
					conversation_parent_id,
					sender_id,
					sender_name,
					external_message_id,
					reply_to_external_message_id,
					acceptance_reason,
					text,
					attachments_json,
					status,
					priority,
					received_at
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`)
			.run(
				message.id,
				message.workerId,
				message.kind,
				message.scopeId,
				message.scopeName ?? null,
				message.guildId ?? null,
				message.guildName ?? null,
				message.conversationId,
				message.conversationName ?? null,
				message.conversationKind,
				message.conversationThreadId ?? null,
				message.conversationParentId ?? null,
				message.senderId,
				message.senderName ?? null,
				message.externalMessageId,
				message.replyToExternalMessageId ?? null,
				message.acceptanceReason,
				message.text,
				JSON.stringify(message.attachments),
				message.status,
				message.priority,
				message.receivedAt,
			) as SqliteRunResult;
		if (insertResult.changes === 0) {
			const existing = db
				.prepare(`
					SELECT *
					FROM discord_inbox
					WHERE external_message_id = ?
				`)
				.get(message.externalMessageId);
			const existingMessage =
				typeof existing === "object" && existing !== null
					? readDiscordInboxRow(existing as Record<string, unknown>)
					: undefined;
			return existingMessage ?? message;
		}
		await this.upsertSubagent({
			id: message.workerId,
			kind: message.kind,
			scopeId: message.scopeId,
			...(message.scopeName === undefined ? {} : { scopeName: message.scopeName }),
			state: "queued",
			activeConversationId: message.conversationId,
			activeSummary: `queued Discord message from ${message.senderName ?? message.senderId}`,
		});
		return message;
	}

	async claimNextDiscordMessage(workerId: string, now = new Date()): Promise<DiscordInboxMessage | undefined> {
		await this.ensure();
		const db = this.database();
		db.exec("BEGIN IMMEDIATE");
		try {
			const row = db
				.prepare(`
					SELECT *
					FROM discord_inbox
					WHERE worker_id = ? AND status = 'queued'
					ORDER BY priority DESC, received_at ASC
					LIMIT 1
				`)
				.get(workerId);
			if (row === undefined) {
				db.exec("COMMIT");
				return undefined;
			}
			const message = readDiscordInboxRow(row);
			if (message === undefined) {
				db.exec("COMMIT");
				return undefined;
			}
			const claimedAt = now.toISOString();
			db.prepare(`
				UPDATE discord_inbox
				SET status = 'claimed', claimed_at = ?
				WHERE id = ? AND status = 'queued'
			`).run(claimedAt, message.id);
			db.exec("COMMIT");
			return { ...message, status: "claimed", claimedAt };
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}

	async completeDiscordMessage(
		id: string,
		responseExternalMessageId: string | undefined,
		now = new Date(),
	): Promise<void> {
		await this.ensure();
		this.database()
			.prepare(`
				UPDATE discord_inbox
				SET status = 'answered',
					finished_at = ?,
					response_external_message_id = ?,
					error = NULL
				WHERE id = ?
			`)
			.run(now.toISOString(), responseExternalMessageId ?? null, id);
	}

	async failDiscordMessage(id: string, error: string, now = new Date()): Promise<void> {
		await this.ensure();
		this.database()
			.prepare(`
				UPDATE discord_inbox
				SET status = 'failed',
					finished_at = ?,
					error = ?
				WHERE id = ?
			`)
			.run(now.toISOString(), error.slice(0, 1000), id);
	}

	async upsertSubagent(input: UpsertSubagentInput): Promise<void> {
		await this.ensure();
		const now = new Date().toISOString();
		this.database()
			.prepare(`
				INSERT INTO subagents (
					id,
					kind,
					scope_id,
					scope_name,
					state,
					active_conversation_id,
					active_summary,
					session_file,
					thinking_level,
					pid,
					last_heartbeat_at,
					last_error,
					created_at,
					updated_at
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET
					kind = excluded.kind,
					scope_id = excluded.scope_id,
					scope_name = COALESCE(excluded.scope_name, subagents.scope_name),
					state = CASE
						WHEN subagents.state = 'running' AND excluded.state = 'queued' THEN subagents.state
						ELSE excluded.state
					END,
					active_conversation_id = CASE
						WHEN subagents.state = 'running' AND excluded.state = 'queued' THEN subagents.active_conversation_id
						ELSE excluded.active_conversation_id
					END,
					active_summary = CASE
						WHEN subagents.state = 'running' AND excluded.state = 'queued' THEN subagents.active_summary
						ELSE excluded.active_summary
					END,
					session_file = COALESCE(excluded.session_file, subagents.session_file),
					thinking_level = COALESCE(excluded.thinking_level, subagents.thinking_level),
					pid = COALESCE(excluded.pid, subagents.pid),
					last_heartbeat_at = COALESCE(excluded.last_heartbeat_at, subagents.last_heartbeat_at),
					last_error = excluded.last_error,
					updated_at = excluded.updated_at
			`)
			.run(
				input.id,
				input.kind,
				input.scopeId,
				input.scopeName ?? null,
				input.state,
				input.activeConversationId ?? null,
				input.activeSummary ?? null,
				input.sessionFile ?? null,
				input.thinkingLevel ?? null,
				input.pid ?? null,
				input.lastHeartbeatAt ?? now,
				input.lastError ?? null,
				now,
				now,
			);
	}

	async setSubagentState(
		id: string,
		state: ClankySubagentState,
		details: {
			activeConversationId?: string;
			activeSummary?: string;
			sessionFile?: string;
			thinkingLevel?: string;
			lastError?: string;
		} = {},
	): Promise<void> {
		await this.ensure();
		const now = new Date().toISOString();
		this.database()
			.prepare(`
				UPDATE subagents
				SET state = ?,
					active_conversation_id = ?,
					active_summary = ?,
					session_file = COALESCE(?, session_file),
					thinking_level = COALESCE(?, thinking_level),
					last_heartbeat_at = ?,
					last_error = ?,
					updated_at = ?
				WHERE id = ?
			`)
			.run(
				state,
				details.activeConversationId ?? null,
				details.activeSummary ?? null,
				details.sessionFile ?? null,
				details.thinkingLevel ?? null,
				now,
				details.lastError ?? null,
				now,
				id,
			);
	}

	async setAllSubagentThinkingLevel(thinkingLevel: string, now = new Date()): Promise<number> {
		await this.ensure();
		const result = this.database()
			.prepare(`
				UPDATE subagents
				SET thinking_level = ?,
					updated_at = ?
			`)
			.run(thinkingLevel, now.toISOString()) as SqliteRunResult;
		return result.changes;
	}

	async getSubagent(id: string): Promise<ClankySubagentSummary | undefined> {
		await this.ensure();
		const row = this.database()
			.prepare(`
				SELECT
					subagents.*,
					COUNT(discord_inbox.id) AS queue_depth
				FROM subagents
				LEFT JOIN discord_inbox
					ON discord_inbox.worker_id = subagents.id
					AND discord_inbox.status IN ('queued', 'claimed')
				WHERE subagents.id = ?
				GROUP BY subagents.id
			`)
			.get(id);
		return typeof row === "object" && row !== null ? readSubagentRow(row as Record<string, unknown>) : undefined;
	}

	async listSubagents(): Promise<ClankySubagentSummary[]> {
		await this.ensure();
		const rows = this.database()
			.prepare(`
				SELECT
					subagents.*,
					COUNT(discord_inbox.id) AS queue_depth
				FROM subagents
				LEFT JOIN discord_inbox
					ON discord_inbox.worker_id = subagents.id
					AND discord_inbox.status IN ('queued', 'claimed')
				GROUP BY subagents.id
				ORDER BY subagents.updated_at DESC
			`)
			.all();
		return rows.map(readSubagentRow).filter((row): row is ClankySubagentSummary => row !== undefined);
	}

	async listDiscordWorkersWithQueuedMessages(): Promise<string[]> {
		await this.ensure();
		const rows = this.database()
			.prepare(`
				SELECT DISTINCT worker_id
				FROM discord_inbox
				WHERE status = 'queued'
				ORDER BY worker_id
			`)
			.all();
		return rows.flatMap((row) => {
			const workerId = readString(row, "worker_id");
			return workerId === undefined ? [] : [workerId];
		});
	}

	async discordQueueDepth(workerId: string): Promise<number> {
		await this.ensure();
		const row = this.database()
			.prepare(`
				SELECT COUNT(*) AS count
				FROM discord_inbox
				WHERE worker_id = ? AND status IN ('queued', 'claimed')
			`)
			.get(workerId);
		if (typeof row !== "object" || row === null) return 0;
		const count = (row as Record<string, unknown>).count;
		return typeof count === "number" ? count : 0;
	}

	async ensure(): Promise<void> {
		await mkdir(dirname(this.paths.subagentsDbFile), { recursive: true, mode: 0o700 });
		const db = this.database();
		db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS subagents (
				id TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				scope_id TEXT NOT NULL,
				scope_name TEXT,
				state TEXT NOT NULL,
				active_conversation_id TEXT,
				active_summary TEXT,
				session_file TEXT,
				thinking_level TEXT,
				pid INTEGER,
				last_heartbeat_at TEXT,
				last_error TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_subagents_kind_scope
				ON subagents (kind, scope_id);
			CREATE TABLE IF NOT EXISTS discord_inbox (
				id TEXT PRIMARY KEY,
				worker_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				scope_id TEXT NOT NULL,
				scope_name TEXT,
				guild_id TEXT,
				guild_name TEXT,
				conversation_id TEXT NOT NULL,
				conversation_name TEXT,
				conversation_kind TEXT NOT NULL,
				conversation_thread_id TEXT,
				conversation_parent_id TEXT,
				sender_id TEXT NOT NULL,
				sender_name TEXT,
				external_message_id TEXT NOT NULL UNIQUE,
				reply_to_external_message_id TEXT,
				acceptance_reason TEXT NOT NULL,
				text TEXT NOT NULL,
				attachments_json TEXT NOT NULL,
				status TEXT NOT NULL,
				priority INTEGER NOT NULL,
				received_at TEXT NOT NULL,
				claimed_at TEXT,
				finished_at TEXT,
				error TEXT,
				response_external_message_id TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_discord_inbox_worker_status
				ON discord_inbox (worker_id, status, priority, received_at);
			CREATE INDEX IF NOT EXISTS idx_discord_inbox_conversation
				ON discord_inbox (conversation_id, received_at);
		`);
		ensureColumn(db, "discord_inbox", "conversation_thread_id", "TEXT");
		ensureColumn(db, "discord_inbox", "conversation_parent_id", "TEXT");
		ensureColumn(db, "subagents", "thinking_level", "TEXT");
	}

	close(): void {
		if (this.db === undefined) return;
		this.db.close();
		this.db = undefined;
	}

	private database(): DatabaseSync {
		if (this.db !== undefined) return this.db;
		const Database = loadDatabaseSync();
		this.db = new Database(this.paths.subagentsDbFile);
		return this.db;
	}
}

function normalizeDiscordInboxInput(input: EnqueueDiscordInboxMessageInput): DiscordInboxMessage {
	const now = input.receivedAt ?? new Date().toISOString();
	const workerId = requiredString(input.workerId, "workerId");
	const scopeName = optionalString(input.scopeName);
	const guildId = optionalString(input.guildId);
	const guildName = optionalString(input.guildName);
	const conversationName = optionalString(input.conversationName);
	const conversationThreadId = optionalString(input.conversationThreadId);
	const conversationParentId = optionalString(input.conversationParentId);
	const senderName = optionalString(input.senderName);
	const replyToExternalMessageId = optionalString(input.replyToExternalMessageId);
	const message: DiscordInboxMessage = {
		id: randomUUID(),
		workerId,
		kind: normalizeKind(input.kind),
		scopeId: requiredString(input.scopeId, "scopeId"),
		conversationId: requiredString(input.conversationId, "conversationId"),
		conversationKind: requiredString(input.conversationKind, "conversationKind"),
		senderId: requiredString(input.senderId, "senderId"),
		externalMessageId: requiredString(input.externalMessageId, "externalMessageId"),
		acceptanceReason: requiredString(input.acceptanceReason, "acceptanceReason"),
		text: input.text.trim() || "(no text)",
		attachments: input.attachments ?? [],
		status: "queued",
		priority: normalizedPriority(input.priority),
		receivedAt: normalizedTimestamp(now, "receivedAt"),
	};
	if (scopeName !== undefined) message.scopeName = scopeName;
	if (guildId !== undefined) message.guildId = guildId;
	if (guildName !== undefined) message.guildName = guildName;
	if (conversationName !== undefined) message.conversationName = conversationName;
	if (conversationThreadId !== undefined) message.conversationThreadId = conversationThreadId;
	if (conversationParentId !== undefined) message.conversationParentId = conversationParentId;
	if (senderName !== undefined) message.senderName = senderName;
	if (replyToExternalMessageId !== undefined) message.replyToExternalMessageId = replyToExternalMessageId;
	return message;
}

function readDiscordInboxRow(row: Record<string, unknown>): DiscordInboxMessage | undefined {
	const id = readString(row, "id");
	const workerId = readString(row, "worker_id");
	const kind = readKind(row.kind);
	const scopeId = readString(row, "scope_id");
	const conversationId = readString(row, "conversation_id");
	const conversationKind = readString(row, "conversation_kind");
	const senderId = readString(row, "sender_id");
	const externalMessageId = readString(row, "external_message_id");
	const acceptanceReason = readString(row, "acceptance_reason");
	const text = readString(row, "text");
	const status = readDiscordInboxStatus(row.status);
	const priority = readNumber(row, "priority");
	const receivedAt = readString(row, "received_at");
	if (
		id === undefined ||
		workerId === undefined ||
		kind === undefined ||
		scopeId === undefined ||
		conversationId === undefined ||
		conversationKind === undefined ||
		senderId === undefined ||
		externalMessageId === undefined ||
		acceptanceReason === undefined ||
		text === undefined ||
		status === undefined ||
		priority === undefined ||
		receivedAt === undefined
	) {
		return undefined;
	}
	const message: DiscordInboxMessage = {
		id,
		workerId,
		kind,
		scopeId,
		conversationId,
		conversationKind,
		senderId,
		externalMessageId,
		acceptanceReason,
		text,
		attachments: readAttachments(row.attachments_json),
		status,
		priority,
		receivedAt,
	};
	const scopeName = readString(row, "scope_name");
	if (scopeName !== undefined) message.scopeName = scopeName;
	const guildId = readString(row, "guild_id");
	if (guildId !== undefined) message.guildId = guildId;
	const guildName = readString(row, "guild_name");
	if (guildName !== undefined) message.guildName = guildName;
	const conversationName = readString(row, "conversation_name");
	if (conversationName !== undefined) message.conversationName = conversationName;
	const conversationThreadId = readString(row, "conversation_thread_id");
	if (conversationThreadId !== undefined) message.conversationThreadId = conversationThreadId;
	const conversationParentId = readString(row, "conversation_parent_id");
	if (conversationParentId !== undefined) message.conversationParentId = conversationParentId;
	const senderName = readString(row, "sender_name");
	if (senderName !== undefined) message.senderName = senderName;
	const replyToExternalMessageId = readString(row, "reply_to_external_message_id");
	if (replyToExternalMessageId !== undefined) message.replyToExternalMessageId = replyToExternalMessageId;
	const claimedAt = readString(row, "claimed_at");
	if (claimedAt !== undefined) message.claimedAt = claimedAt;
	const finishedAt = readString(row, "finished_at");
	if (finishedAt !== undefined) message.finishedAt = finishedAt;
	const error = readString(row, "error");
	if (error !== undefined) message.error = error;
	const responseExternalMessageId = readString(row, "response_external_message_id");
	if (responseExternalMessageId !== undefined) message.responseExternalMessageId = responseExternalMessageId;
	return message;
}

function readSubagentRow(row: Record<string, unknown>): ClankySubagentSummary | undefined {
	const id = readString(row, "id");
	const kind = readKind(row.kind);
	const scopeId = readString(row, "scope_id");
	const state = readSubagentState(row.state);
	const createdAt = readString(row, "created_at");
	const updatedAt = readString(row, "updated_at");
	const queueDepth = readNumber(row, "queue_depth");
	if (
		id === undefined ||
		kind === undefined ||
		scopeId === undefined ||
		state === undefined ||
		createdAt === undefined ||
		updatedAt === undefined ||
		queueDepth === undefined
	) {
		return undefined;
	}
	const summary: ClankySubagentSummary = { id, kind, scopeId, state, queueDepth, createdAt, updatedAt };
	const scopeName = readString(row, "scope_name");
	if (scopeName !== undefined) summary.scopeName = scopeName;
	const activeConversationId = readString(row, "active_conversation_id");
	if (activeConversationId !== undefined) summary.activeConversationId = activeConversationId;
	const activeSummary = readString(row, "active_summary");
	if (activeSummary !== undefined) summary.activeSummary = activeSummary;
	const sessionFile = readString(row, "session_file");
	if (sessionFile !== undefined) summary.sessionFile = sessionFile;
	const thinkingLevel = readString(row, "thinking_level");
	if (thinkingLevel !== undefined) summary.thinkingLevel = thinkingLevel;
	const pid = readNumber(row, "pid");
	if (pid !== undefined) summary.pid = pid;
	const lastHeartbeatAt = readString(row, "last_heartbeat_at");
	if (lastHeartbeatAt !== undefined) summary.lastHeartbeatAt = lastHeartbeatAt;
	const lastError = readString(row, "last_error");
	if (lastError !== undefined) summary.lastError = lastError;
	return summary;
}

function ensureColumn(db: DatabaseSync, table: string, column: string, type: string): void {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all();
	const hasColumn = rows.some((row) => {
		if (typeof row !== "object" || row === null) return false;
		return (row as Record<string, unknown>).name === column;
	});
	if (!hasColumn) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

function readAttachments(value: unknown): DiscordInboxAttachment[] {
	if (typeof value !== "string") return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.flatMap((item) => {
			if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
			const record = item as Record<string, unknown>;
			const attachment: DiscordInboxAttachment = {};
			if (typeof record.url === "string") attachment.url = record.url;
			if (typeof record.filename === "string") attachment.filename = record.filename;
			if (typeof record.mime === "string") attachment.mime = record.mime;
			if (typeof record.contentType === "string") attachment.contentType = record.contentType;
			return Object.keys(attachment).length === 0 ? [] : [attachment];
		});
	} catch {
		return [];
	}
}

function requiredString(value: string, label: string): string {
	const trimmed = value.trim();
	if (trimmed.length === 0) throw new Error(`${label} is required`);
	return trimmed;
}

function optionalString(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function normalizedPriority(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return 0;
	return Math.floor(value);
}

function normalizedTimestamp(value: string, label: string): string {
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) throw new Error(`${label} must be an ISO timestamp`);
	return new Date(parsed).toISOString();
}

function normalizeKind(value: ClankySubagentKind): ClankySubagentKind {
	return requiredString(value, "kind");
}

function readString(row: Record<string, unknown>, key: string): string | undefined {
	const value = row[key];
	return typeof value === "string" ? value : undefined;
}

function readNumber(row: Record<string, unknown>, key: string): number | undefined {
	const value = row[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readKind(value: unknown): ClankySubagentKind | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readSubagentState(value: unknown): ClankySubagentState | undefined {
	if (value === "idle" || value === "queued" || value === "running" || value === "failed" || value === "stale") {
		return value;
	}
	return undefined;
}

function readDiscordInboxStatus(value: unknown): DiscordInboxStatus | undefined {
	if (value === "queued" || value === "claimed" || value === "answered" || value === "failed") return value;
	return undefined;
}
