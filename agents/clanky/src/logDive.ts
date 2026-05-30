import { access, open, readdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { DatabaseSync, DatabaseSyncOptions } from "node:sqlite";
import { type ClankyPaths, errorMessage, isRecord, resolveClankyPaths } from "@clanky/core";

type SessionGroup = "main" | "subagent";
type SessionKind = "main" | "discord-voice" | "voice-worker" | "discord-guild" | "discord-dm" | "subagent";

interface ClankyLogDiveOptions {
	homeDir?: string;
	profile?: string;
	limit?: number;
	session?: string;
	logTailLines?: number;
	json?: boolean;
}

interface ParsedClankyLogDiveArgs extends ClankyLogDiveOptions {
	help: boolean;
}

interface SubagentRow {
	id: string;
	kind: string;
	scopeId: string;
	state: string;
	queueDepth: number;
	createdAt: string;
	updatedAt: string;
	scopeName?: string;
	activeConversationId?: string;
	activeSummary?: string;
	sessionFile?: string;
	pid?: number;
	lastHeartbeatAt?: string;
	lastError?: string;
}

interface InboxRow {
	externalMessageId: string;
	workerId: string;
	kind: string;
	status: string;
	receivedAt: string;
	claimedAt?: string;
	finishedAt?: string;
	acceptanceReason: string;
	text: string;
	responseExternalMessageId?: string;
	error?: string;
}

interface SessionSummary {
	path: string;
	file: string;
	group: SessionGroup;
	kind: SessionKind;
	id?: string;
	timestamp?: string;
	cwd?: string;
	updatedAt: string;
	sizeBytes: number;
	entryCount?: number;
	subagentId?: string;
	scopeId?: string;
	state?: string;
}

interface SessionTimelineEntry {
	timestamp?: string;
	role: string;
	text: string;
	toolName?: string;
}

interface SessionMetrics {
	entryCount: number;
	messageCount: number;
	toolCallCount: number;
	assistantMessageCount: number;
	totalTokens: number;
	totalCost?: number;
	duplicateToolCalls: DuplicateToolCall[];
	duplicateAssistantMessages: DuplicateAssistantMessage[];
	durationMs?: number;
}

interface DuplicateToolCall {
	name: string;
	count: number;
	firstTimestamp?: string;
	preview: string;
}

interface DuplicateAssistantMessage {
	count: number;
	firstTimestamp?: string;
	preview: string;
}

interface SessionDetails {
	summary: SessionSummary;
	timeline: SessionTimelineEntry[];
	metrics: SessionMetrics;
}

interface LogTail {
	path: string;
	lines: string[];
	missing?: boolean;
}

interface ClankyLogDiveReport {
	generatedAt: string;
	warnings: string[];
	paths: {
		homeDir: string;
		profile: string;
		profileDir: string;
		mainSessionsDir: string;
		subagentSessionsDir: string;
		subagentsDbFile: string;
		discordBridgeLog: string;
		discordVoiceLog: string;
	};
	subagents: SubagentRow[];
	inbox: InboxRow[];
	recentSessions: SessionSummary[];
	selectedSession?: SessionDetails;
	linkedWorkerSession?: SessionDetails;
	logs: {
		discordVoice: LogTail;
		discordBridge: LogTail;
	};
}

type DatabaseSyncConstructor = new (path: string, options?: DatabaseSyncOptions) => DatabaseSync;
type WarningConstructor = NonNullable<NodeJS.EmitWarningOptions["ctor"]>;
type EmitWarningFunction = (
	warning: string | Error,
	optionsOrType?: string | NodeJS.EmitWarningOptions | WarningConstructor,
	codeOrCtor?: string | WarningConstructor,
	ctor?: WarningConstructor,
) => void;

const require = createRequire(import.meta.url);
let DatabaseSyncClass: DatabaseSyncConstructor | undefined;
const DEFAULT_LIMIT = 12;
const DEFAULT_LOG_TAIL_LINES = 80;
const SESSION_TAIL_ENTRIES = 80;
const TEXT_PREVIEW_CHARS = 260;
const ANSI_STYLE_SEQUENCE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

export async function runClankyLogDiveCli(rawArgs: string[]): Promise<void> {
	const options = parseClankyLogDiveArgs(rawArgs);
	if (options.help) {
		printClankyLogDiveHelp();
		return;
	}
	const report = await collectClankyLogDive(options);
	console.log(options.json === true ? JSON.stringify(report, null, "\t") : renderClankyLogDiveReport(report));
}

export async function collectClankyLogDive(options: ClankyLogDiveOptions = {}): Promise<ClankyLogDiveReport> {
	const paths = resolveClankyPaths({
		...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
		...(options.profile === undefined ? {} : { profile: options.profile }),
	});
	const limit = normalizePositiveInteger(options.limit, DEFAULT_LIMIT);
	const logTailLines = normalizePositiveInteger(options.logTailLines, DEFAULT_LOG_TAIL_LINES);
	const warnings: string[] = [];
	const [subagents, inbox, recentSessions, discordVoiceLog, discordBridgeLog] = await Promise.all([
		readSubagents(paths).catch((error: unknown) => {
			warnings.push(`Could not read subagent state: ${errorMessage(error)}`);
			return [];
		}),
		readInbox(paths, limit).catch((error: unknown) => {
			warnings.push(`Could not read Discord inbox: ${errorMessage(error)}`);
			return [];
		}),
		listRecentSessions(paths, limit),
		readLogTail(join(paths.profileDir, "discord-voice.log"), logTailLines),
		readLogTail(join(paths.profileDir, "discord-bridge.log"), logTailLines),
	]);
	attachSubagentDetails(recentSessions, subagents);
	const selectedSummary = resolveSelectedSession(recentSessions, options.session);
	const selectedSession =
		selectedSummary === undefined ? undefined : await readSessionDetails(selectedSummary, SESSION_TAIL_ENTRIES);
	const linkedWorkerSummary = findLinkedVoiceWorkerSession(selectedSummary, subagents, recentSessions);
	const linkedWorkerSession =
		linkedWorkerSummary === undefined ? undefined : await readSessionDetails(linkedWorkerSummary, SESSION_TAIL_ENTRIES);

	return {
		generatedAt: new Date().toISOString(),
		warnings,
		paths: {
			homeDir: paths.homeDir,
			profile: paths.profile,
			profileDir: paths.profileDir,
			mainSessionsDir: paths.sessionsDir,
			subagentSessionsDir: paths.subagentSessionsDir,
			subagentsDbFile: paths.subagentsDbFile,
			discordBridgeLog: join(paths.profileDir, "discord-bridge.log"),
			discordVoiceLog: join(paths.profileDir, "discord-voice.log"),
		},
		subagents,
		inbox,
		recentSessions,
		...(selectedSession === undefined ? {} : { selectedSession }),
		...(linkedWorkerSession === undefined ? {} : { linkedWorkerSession }),
		logs: {
			discordVoice: discordVoiceLog,
			discordBridge: discordBridgeLog,
		},
	};
}

function parseClankyLogDiveArgs(rawArgs: string[]): ParsedClankyLogDiveArgs {
	const parsed: ParsedClankyLogDiveArgs = { help: false };
	for (let i = 0; i < rawArgs.length; i++) {
		const arg = rawArgs[i];
		if (arg === undefined) continue;
		const next = rawArgs[i + 1];
		if (arg === "--help" || arg === "-h") {
			parsed.help = true;
		} else if (arg === "--profile" && next !== undefined) {
			parsed.profile = next;
			i++;
		} else if (arg === "--home" && next !== undefined) {
			parsed.homeDir = next;
			i++;
		} else if ((arg === "--limit" || arg === "-n") && next !== undefined) {
			parsed.limit = parsePositiveIntegerFlag(next, arg);
			i++;
		} else if (arg === "--session" && next !== undefined) {
			parsed.session = next;
			i++;
		} else if (arg === "--tail" && next !== undefined) {
			parsed.logTailLines = parsePositiveIntegerFlag(next, arg);
			i++;
		} else if (arg === "--json") {
			parsed.json = true;
		} else {
			throw new Error(`Unknown logs argument: ${arg}`);
		}
	}
	return parsed;
}

function printClankyLogDiveHelp(): void {
	console.log(
		[
			"Usage: clanky logs [--profile <name>] [--home <dir>] [--limit <n>] [--session <latest|id|path>] [--tail <n>] [--json]",
			"",
			"Shows recent Clanky main/subagent sessions, Discord subagent state, inbox rows,",
			"voice/bridge log tails, and a focused timeline for the selected session.",
			"",
			"Examples:",
			"  clanky logs",
			"  clanky logs --session latest",
			"  clanky logs --session discord-voice --tail 120",
			"  clanky logs --json",
		].join("\n"),
	);
}

function renderClankyLogDiveReport(report: ClankyLogDiveReport): string {
	const lines: string[] = [
		"Clanky Log Dive",
		`Generated: ${formatTimestamp(report.generatedAt)}`,
		`Profile: ${report.paths.profile} (${report.paths.profileDir})`,
		"",
		"Artifacts:",
		`- subagents DB: ${report.paths.subagentsDbFile}`,
		`- main sessions: ${report.paths.mainSessionsDir}`,
		`- subagent sessions: ${report.paths.subagentSessionsDir}`,
		`- voice log: ${report.paths.discordVoiceLog}`,
		`- bridge log: ${report.paths.discordBridgeLog}`,
	];
	if (report.warnings.length > 0) {
		lines.push("", "Warnings:", ...report.warnings.map((warning) => `- ${warning}`));
	}
	lines.push(
		"",
		"Subagents:",
		...renderSubagents(report.subagents),
		"",
		"Recent Discord Inbox:",
		...renderInbox(report.inbox),
		"",
		"Recent Sessions:",
		...renderRecentSessions(report.recentSessions),
	);

	if (report.selectedSession !== undefined) {
		lines.push("", "Selected Session:", ...renderSessionDetails(report.selectedSession));
	}
	if (report.linkedWorkerSession !== undefined) {
		lines.push("", "Linked Voice Worker:", ...renderSessionDetails(report.linkedWorkerSession));
	}

	lines.push("", "Discord Voice Log Tail:", ...renderLogTail(report.logs.discordVoice));
	lines.push("", "Discord Bridge Log Tail:", ...renderLogTail(report.logs.discordBridge));
	return lines.join("\n");
}

function renderSubagents(subagents: readonly SubagentRow[]): string[] {
	if (subagents.length === 0) return ["- none"];
	return subagents.map((subagent) => {
		const queue = subagent.queueDepth > 0 ? ` queue=${subagent.queueDepth}` : "";
		const session = subagent.sessionFile === undefined ? "" : ` session=${subagent.sessionFile}`;
		const error = subagent.lastError === undefined ? "" : ` error=${truncateOneLine(subagent.lastError, 120)}`;
		return `- ${subagent.kind} ${subagent.id} state=${subagent.state}${queue} updated=${formatTimestamp(subagent.updatedAt)} summary=${truncateOneLine(subagent.activeSummary ?? "none", 120)}${session}${error}`;
	});
}

function renderInbox(inbox: readonly InboxRow[]): string[] {
	if (inbox.length === 0) return ["- none"];
	return inbox.map((message) => {
		const finished = message.finishedAt === undefined ? "" : ` finished=${formatTimestamp(message.finishedAt)}`;
		const response =
			message.responseExternalMessageId === undefined ? "" : ` response=${message.responseExternalMessageId}`;
		const error = message.error === undefined ? "" : ` error=${truncateOneLine(message.error, 100)}`;
		return `- ${formatTimestamp(message.receivedAt)} ${message.kind} ${message.status} ext=${message.externalMessageId} worker=${message.workerId} reason=${message.acceptanceReason}${finished}${response}${error} text=${truncateOneLine(message.text, 120)}`;
	});
}

function renderRecentSessions(sessions: readonly SessionSummary[]): string[] {
	if (sessions.length === 0) return ["- none"];
	return sessions.map((session, index) => {
		const selectedHint = index === 0 ? " latest" : "";
		const state = session.state === undefined ? "" : ` state=${session.state}`;
		const subagent = session.subagentId === undefined ? "" : ` subagent=${session.subagentId}`;
		return `- ${formatTimestamp(session.timestamp ?? session.updatedAt)} ${session.group}/${session.kind}${selectedHint}${state}${subagent} file=${session.path}`;
	});
}

function renderSessionDetails(details: SessionDetails): string[] {
	const duplicateLines =
		details.metrics.duplicateToolCalls.length === 0
			? []
			: [
					"  Duplicate tool calls:",
					...details.metrics.duplicateToolCalls.map(
						(dup) =>
							`  - ${dup.name} x${dup.count} first=${formatTimestamp(dup.firstTimestamp)} args=${truncateOneLine(dup.preview, 140)}`,
					),
				];
	const duplicateAssistantLines =
		details.metrics.duplicateAssistantMessages.length === 0
			? []
			: [
					"  Duplicate assistant messages:",
					...details.metrics.duplicateAssistantMessages.map(
						(dup) =>
							`  - x${dup.count} first=${formatTimestamp(dup.firstTimestamp)} text=${truncateOneLine(dup.preview, 140)}`,
					),
				];
	const cost = details.metrics.totalCost === undefined ? "" : ` cost=$${details.metrics.totalCost.toFixed(4)}`;
	const duration =
		details.metrics.durationMs === undefined ? "" : ` duration=${formatDuration(details.metrics.durationMs)}`;
	return [
		`- file: ${details.summary.path}`,
		`- kind: ${details.summary.group}/${details.summary.kind}${duration}`,
		`- metrics: entries=${details.metrics.entryCount} messages=${details.metrics.messageCount} assistant=${details.metrics.assistantMessageCount} toolCalls=${details.metrics.toolCallCount} tokens=${details.metrics.totalTokens}${cost}`,
		...duplicateLines,
		...duplicateAssistantLines,
		"  Timeline:",
		...(details.timeline.length === 0
			? ["  - no message timeline entries"]
			: details.timeline.map((entry) => {
					const tool = entry.toolName === undefined ? "" : ` tool=${entry.toolName}`;
					return `  - ${formatTimestamp(entry.timestamp)} ${entry.role}${tool}: ${truncateOneLine(entry.text, 220)}`;
				})),
	];
}

function renderLogTail(log: LogTail): string[] {
	if (log.missing === true) return [`- missing: ${log.path}`];
	if (log.lines.length === 0) return ["- empty"];
	return log.lines.map((line) => `- ${truncateOneLine(line, 260)}`);
}

async function listRecentSessions(paths: ClankyPaths, limit: number): Promise<SessionSummary[]> {
	const [main, subagents] = await Promise.all([
		listSessionDir(paths.sessionsDir, "main"),
		listSessionDir(paths.subagentSessionsDir, "subagent"),
	]);
	return [...main, ...subagents]
		.sort((a, b) => Date.parse(b.timestamp ?? b.updatedAt) - Date.parse(a.timestamp ?? a.updatedAt))
		.slice(0, limit);
}

async function listSessionDir(dir: string, group: SessionGroup): Promise<SessionSummary[]> {
	if (!(await isReadable(dir))) return [];
	const entries = await readdir(dir, { withFileTypes: true });
	const sessions: SessionSummary[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
		const path = join(dir, entry.name);
		const [fileStat, header] = await Promise.all([stat(path), readSessionHeader(path)]);
		sessions.push({
			path,
			file: entry.name,
			group,
			kind: inferSessionKind(group, entry.name, header?.id),
			...(header?.id === undefined ? {} : { id: header.id }),
			...(header?.timestamp === undefined ? {} : { timestamp: header.timestamp }),
			...(header?.cwd === undefined ? {} : { cwd: header.cwd }),
			updatedAt: fileStat.mtime.toISOString(),
			sizeBytes: fileStat.size,
		});
	}
	return sessions;
}

async function readSessionHeader(path: string): Promise<{ id?: string; timestamp?: string; cwd?: string } | undefined> {
	const lines = await readFilePrefixLines(path, 1);
	const first = lines[0];
	if (first === undefined) return undefined;
	const parsed = parseJsonObject(first);
	if (parsed === undefined || parsed.type !== "session") return undefined;
	return {
		...(typeof parsed.id === "string" ? { id: parsed.id } : {}),
		...(typeof parsed.timestamp === "string" ? { timestamp: parsed.timestamp } : {}),
		...(typeof parsed.cwd === "string" ? { cwd: parsed.cwd } : {}),
	};
}

async function readSessionDetails(summary: SessionSummary, maxEntries: number): Promise<SessionDetails> {
	const lines = await readFileLines(summary.path);
	const entries = lines.flatMap((line) => {
		const parsed = parseJsonObject(line);
		return parsed === undefined ? [] : [parsed];
	});
	const timeline = entries.flatMap(readTimelineEntry).slice(-maxEntries);
	return {
		summary: { ...summary, entryCount: entries.length },
		timeline,
		metrics: calculateSessionMetrics(entries, timeline),
	};
}

function readTimelineEntry(entry: Record<string, unknown>): SessionTimelineEntry[] {
	if (entry.type === "model_change") {
		return [createTimelineEntry("model", readString(entry.modelId) ?? "model changed", readString(entry.timestamp))];
	}
	if (entry.type === "thinking_level_change") {
		return [
			createTimelineEntry(
				"effort",
				readString(entry.thinkingLevel) ?? "thinking level changed",
				readString(entry.timestamp),
			),
		];
	}
	if (entry.type !== "message") return [];
	const message = readRecord(entry.message);
	if (message === undefined) return [];
	const role = readString(message.role) ?? "message";
	const text = formatMessageContent(message.content);
	if (text.length === 0) return [];
	return [createTimelineEntry(role, text, readString(entry.timestamp), extractToolName(text)?.toolName)];
}

function createTimelineEntry(
	role: string,
	text: string,
	timestamp: string | undefined,
	toolName?: string,
): SessionTimelineEntry {
	return {
		role,
		text,
		...(timestamp === undefined ? {} : { timestamp }),
		...(toolName === undefined ? {} : { toolName }),
	};
}

function formatMessageContent(content: unknown): string {
	if (typeof content === "string") return normalizeSessionText(content);
	if (!Array.isArray(content)) return "";
	const lines: string[] = [];
	for (const part of content) {
		if (!isRecord(part)) continue;
		if (part.type === "text" && typeof part.text === "string") {
			lines.push(normalizeSessionText(part.text));
		} else if (part.type === "toolCall") {
			const name = readString(part.name) ?? "tool";
			lines.push(`tool call: ${name} ${JSON.stringify(part.arguments ?? {})}`);
		} else if (part.type === "toolResult") {
			const name = readString(part.toolName) ?? "tool";
			lines.push(`tool result: ${name} ${truncateOneLine(formatUnknown(part.content), TEXT_PREVIEW_CHARS)}`);
		}
	}
	return lines.filter((line) => line.length > 0).join(" | ");
}

function normalizeSessionText(text: string): string {
	const voiceRequestMarker = "\n\nVoice request:\n\n";
	const voiceRequestIndex = text.lastIndexOf(voiceRequestMarker);
	if (voiceRequestIndex >= 0)
		return `Voice worker request: ${text.slice(voiceRequestIndex + voiceRequestMarker.length)}`;
	const discordMessageMarker = "\nMessage from ";
	const discordMessageIndex = text.lastIndexOf(discordMessageMarker);
	if (discordMessageIndex >= 0) return text.slice(discordMessageIndex + 1);
	return text;
}

function calculateSessionMetrics(
	entries: readonly Record<string, unknown>[],
	timeline: readonly SessionTimelineEntry[],
): SessionMetrics {
	let messageCount = 0;
	let assistantMessageCount = 0;
	let totalTokens = 0;
	let totalCost = 0;
	let sawCost = false;
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		messageCount += 1;
		const message = readRecord(entry.message);
		if (message?.role === "assistant") assistantMessageCount += 1;
		const usage = readRecord(message?.usage);
		const tokens = readNumber(usage?.totalTokens) ?? readNumber(usage?.total_tokens);
		if (tokens !== undefined) totalTokens += tokens;
		const cost = readNumber(readRecord(usage?.cost)?.total);
		if (cost !== undefined) {
			totalCost += cost;
			sawCost = true;
		}
	}
	const times = timeline.flatMap((entry) => {
		const parsed = entry.timestamp === undefined ? Number.NaN : Date.parse(entry.timestamp);
		return Number.isFinite(parsed) ? [parsed] : [];
	});
	const durationMs = times.length < 2 ? undefined : Math.max(...times) - Math.min(...times);
	return {
		entryCount: entries.length,
		messageCount,
		toolCallCount: timeline.filter((entry) => entry.text.startsWith("tool call:")).length,
		assistantMessageCount,
		totalTokens,
		...(sawCost ? { totalCost } : {}),
		duplicateToolCalls: findDuplicateToolCalls(timeline),
		duplicateAssistantMessages: findDuplicateAssistantMessages(timeline),
		...(durationMs === undefined ? {} : { durationMs }),
	};
}

function findDuplicateToolCalls(timeline: readonly SessionTimelineEntry[]): DuplicateToolCall[] {
	const byFingerprint = new Map<
		string,
		{ entry: SessionTimelineEntry; count: number; name: string; preview: string }
	>();
	for (const entry of timeline) {
		if (!entry.text.startsWith("tool call:")) continue;
		const name = entry.toolName ?? "tool";
		const preview = entry.text.slice(`tool call: ${name}`.length).trim();
		const key = `${name}\n${preview}`;
		const existing = byFingerprint.get(key);
		if (existing === undefined) {
			byFingerprint.set(key, { entry, count: 1, name, preview });
		} else {
			existing.count += 1;
		}
	}
	return [...byFingerprint.values()]
		.filter((item) => item.count > 1)
		.map((item) => {
			return {
				name: item.name,
				count: item.count,
				...(item.entry.timestamp === undefined ? {} : { firstTimestamp: item.entry.timestamp }),
				preview: item.preview,
			};
		});
}

function findDuplicateAssistantMessages(timeline: readonly SessionTimelineEntry[]): DuplicateAssistantMessage[] {
	const byText = new Map<string, { entry: SessionTimelineEntry; count: number; preview: string }>();
	for (const entry of timeline) {
		if (entry.role !== "assistant" || entry.toolName !== undefined) continue;
		const normalized = normalizeDuplicateText(entry.text);
		if (normalized.length === 0) continue;
		const existing = byText.get(normalized);
		if (existing === undefined) {
			byText.set(normalized, { entry, count: 1, preview: entry.text });
		} else {
			existing.count += 1;
		}
	}
	return [...byText.values()]
		.filter((item) => item.count > 1)
		.map((item) => {
			return {
				count: item.count,
				...(item.entry.timestamp === undefined ? {} : { firstTimestamp: item.entry.timestamp }),
				preview: item.preview,
			};
		});
}

function normalizeDuplicateText(text: string): string {
	return text.trim().replace(/\s+/g, " ").toLowerCase();
}

async function readSubagents(paths: ClankyPaths): Promise<SubagentRow[]> {
	if (!(await isReadable(paths.subagentsDbFile))) return [];
	return withReadonlyDatabase(paths.subagentsDbFile, (db) => {
		if (!hasTable(db, "chat_inbox")) {
			const rows = db
				.prepare(`
					SELECT
						subagents.*,
						0 AS queue_depth
					FROM subagents
					ORDER BY subagents.updated_at DESC
				`)
				.all();
			return rows.flatMap(readSubagentRow);
		}
		const rows = db
			.prepare(`
				SELECT
					subagents.*,
					COUNT(chat_inbox.id) AS queue_depth
				FROM subagents
				LEFT JOIN chat_inbox
					ON chat_inbox.worker_id = subagents.id
					AND chat_inbox.status IN ('queued', 'claimed')
				GROUP BY subagents.id
				ORDER BY subagents.updated_at DESC
			`)
			.all();
		return rows.flatMap(readSubagentRow);
	});
}

async function readInbox(paths: ClankyPaths, limit: number): Promise<InboxRow[]> {
	if (!(await isReadable(paths.subagentsDbFile))) return [];
	return withReadonlyDatabase(paths.subagentsDbFile, (db) => {
		if (!hasTable(db, "chat_inbox")) return [];
		const rows = db
			.prepare(`
				SELECT *
				FROM chat_inbox
				ORDER BY received_at DESC
				LIMIT ?
			`)
			.all(limit);
		return rows.flatMap(readInboxRow);
	});
}

function hasTable(db: DatabaseSync, name: string): boolean {
	const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(name);
	return row !== undefined;
}

function withReadonlyDatabase<T>(path: string, fn: (db: DatabaseSync) => T): T {
	const Database = loadDatabaseSync();
	const db = new Database(path, { readOnly: true, timeout: 5_000 });
	try {
		return fn(db);
	} finally {
		db.close();
	}
}

function loadDatabaseSync(): DatabaseSyncConstructor {
	if (DatabaseSyncClass !== undefined) return DatabaseSyncClass;

	const originalEmitWarning = process.emitWarning as EmitWarningFunction;
	const filteredEmitWarning: EmitWarningFunction = (warning, optionsOrType, codeOrCtor, ctor) => {
		const message = typeof warning === "string" ? warning : warning.message;
		const type =
			typeof optionsOrType === "string"
				? optionsOrType
				: typeof optionsOrType === "object" && optionsOrType !== null
					? optionsOrType.type
					: undefined;
		if (message.includes("SQLite is an experimental feature") && type === "ExperimentalWarning") return;
		if (typeof optionsOrType === "function") originalEmitWarning.call(process, warning, optionsOrType);
		else if (typeof optionsOrType === "object") originalEmitWarning.call(process, warning, optionsOrType);
		else if (typeof codeOrCtor === "function") originalEmitWarning.call(process, warning, optionsOrType, codeOrCtor);
		else if (ctor !== undefined) originalEmitWarning.call(process, warning, optionsOrType, codeOrCtor, ctor);
		else if (codeOrCtor !== undefined) originalEmitWarning.call(process, warning, optionsOrType, codeOrCtor);
		else if (optionsOrType !== undefined) originalEmitWarning.call(process, warning, optionsOrType);
		else originalEmitWarning.call(process, warning);
	};

	process.emitWarning = filteredEmitWarning as typeof process.emitWarning;
	try {
		const sqlite = require("node:sqlite") as { DatabaseSync: DatabaseSyncConstructor };
		DatabaseSyncClass = sqlite.DatabaseSync;
		return DatabaseSyncClass;
	} finally {
		process.emitWarning = originalEmitWarning as typeof process.emitWarning;
	}
}

function readSubagentRow(row: unknown): SubagentRow[] {
	if (!isRecord(row)) return [];
	const id = readString(row.id);
	const kind = readString(row.kind);
	const scopeId = readString(row.scope_id);
	const state = readString(row.state);
	const queueDepth = readNumber(row.queue_depth);
	const createdAt = readString(row.created_at);
	const updatedAt = readString(row.updated_at);
	if (
		id === undefined ||
		kind === undefined ||
		scopeId === undefined ||
		state === undefined ||
		queueDepth === undefined ||
		createdAt === undefined ||
		updatedAt === undefined
	) {
		return [];
	}
	const result: SubagentRow = { id, kind, scopeId, state, queueDepth, createdAt, updatedAt };
	assignOptionalString(result, "scopeName", row.scope_name);
	assignOptionalString(result, "activeConversationId", row.active_conversation_id);
	assignOptionalString(result, "activeSummary", row.active_summary);
	assignOptionalString(result, "sessionFile", row.session_file);
	assignOptionalString(result, "lastHeartbeatAt", row.last_heartbeat_at);
	assignOptionalString(result, "lastError", row.last_error);
	const pid = readNumber(row.pid);
	if (pid !== undefined) result.pid = pid;
	return [result];
}

function readInboxRow(row: unknown): InboxRow[] {
	if (!isRecord(row)) return [];
	const externalMessageId = readString(row.external_message_id);
	const workerId = readString(row.worker_id);
	const kind = readString(row.kind);
	const status = readString(row.status);
	const receivedAt = readString(row.received_at);
	const acceptanceReason = readString(row.acceptance_reason);
	const text = readString(row.text);
	if (
		externalMessageId === undefined ||
		workerId === undefined ||
		kind === undefined ||
		status === undefined ||
		receivedAt === undefined ||
		acceptanceReason === undefined ||
		text === undefined
	) {
		return [];
	}
	const result: InboxRow = { externalMessageId, workerId, kind, status, receivedAt, acceptanceReason, text };
	assignOptionalString(result, "claimedAt", row.claimed_at);
	assignOptionalString(result, "finishedAt", row.finished_at);
	assignOptionalString(result, "responseExternalMessageId", row.response_external_message_id);
	assignOptionalString(result, "error", row.error);
	return [result];
}

function attachSubagentDetails(sessions: SessionSummary[], subagents: readonly SubagentRow[]): void {
	const byPath = new Map<string, SubagentRow>();
	for (const subagent of subagents) {
		if (subagent.sessionFile !== undefined) byPath.set(resolve(subagent.sessionFile), subagent);
	}
	for (const session of sessions) {
		const subagent = byPath.get(resolve(session.path));
		if (subagent === undefined) continue;
		session.kind = inferSubagentKind(subagent.kind);
		session.subagentId = subagent.id;
		session.scopeId = subagent.scopeId;
		session.state = subagent.state;
	}
}

function resolveSelectedSession(
	sessions: readonly SessionSummary[],
	selector: string | undefined,
): SessionSummary | undefined {
	if (sessions.length === 0) return undefined;
	const normalized = selector?.trim();
	if (normalized === undefined || normalized.length === 0 || normalized === "latest") return sessions[0];
	const resolved = resolve(normalized);
	return (
		sessions.find((session) => resolve(session.path) === resolved) ??
		sessions.find((session) => session.id === normalized) ??
		sessions.find((session) => session.path.includes(normalized) || session.file.includes(normalized)) ??
		sessions.find((session) => session.kind === normalized)
	);
}

function findLinkedVoiceWorkerSession(
	selected: SessionSummary | undefined,
	subagents: readonly SubagentRow[],
	sessions: readonly SessionSummary[],
): SessionSummary | undefined {
	if (selected?.kind !== "discord-voice") return undefined;
	const voiceSubagent = subagents.find(
		(subagent) => subagent.id === selected.subagentId || subagent.sessionFile === selected.path,
	);
	const worker = subagents.find(
		(subagent) => subagent.kind === "voice-worker" && subagent.scopeId === (voiceSubagent?.scopeId ?? selected.scopeId),
	);
	const workerSessionFile = worker?.sessionFile;
	if (workerSessionFile === undefined) return undefined;
	return sessions.find((session) => resolve(session.path) === resolve(workerSessionFile));
}

function inferSessionKind(group: SessionGroup, file: string, id: string | undefined): SessionKind {
	if (group === "main") return "main";
	const value = `${file}\n${id ?? ""}`;
	if (value.includes("discord-voice-")) return "discord-voice";
	if (value.includes("voice-worker")) return "voice-worker";
	if (value.includes("discord-guild")) return "discord-guild";
	if (value.includes("discord-dm")) return "discord-dm";
	return "subagent";
}

function inferSubagentKind(kind: string): SessionKind {
	if (kind === "discord-voice" || kind === "voice-worker" || kind === "discord-guild" || kind === "discord-dm") {
		return kind;
	}
	return "subagent";
}

async function readLogTail(path: string, maxLines: number): Promise<LogTail> {
	if (!(await isReadable(path))) return { path, lines: [], missing: true };
	const lines = await readFileTailLines(path, maxLines);
	return { path, lines: lines.map((line) => stripAnsi(line).trimEnd()).filter((line) => line.length > 0) };
}

async function readFileLines(path: string): Promise<string[]> {
	const text = await readFile(path, "utf8");
	return text.split(/\r?\n/).filter((line) => line.length > 0);
}

async function readFilePrefixLines(path: string, maxLines: number): Promise<string[]> {
	const file = await open(path, "r");
	try {
		const statResult = await file.stat();
		const length = Math.min(statResult.size, 64 * 1024);
		const buffer = Buffer.alloc(length);
		await file.read(buffer, 0, length, 0);
		return buffer.toString("utf8").split(/\r?\n/).slice(0, maxLines);
	} finally {
		await file.close();
	}
}

async function readFileTailLines(path: string, maxLines: number): Promise<string[]> {
	const file = await open(path, "r");
	try {
		const statResult = await file.stat();
		const length = Math.min(statResult.size, Math.max(64 * 1024, maxLines * 512));
		if (length <= 0) return [];
		const buffer = Buffer.alloc(length);
		await file.read(buffer, 0, length, statResult.size - length);
		let text = buffer.toString("utf8");
		if (length < statResult.size) text = text.slice(Math.max(0, text.indexOf("\n") + 1));
		return text
			.split(/\r?\n/)
			.filter((line) => line.length > 0)
			.slice(-maxLines);
	} finally {
		await file.close();
	}
}

async function isReadable(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function parseJsonObject(line: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(line) as unknown;
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function extractToolName(text: string): { toolName: string } | undefined {
	const match = /^tool (?:call|result): ([^\s]+)/.exec(text);
	return match?.[1] === undefined ? undefined : { toolName: match[1] };
}

function formatUnknown(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function formatTimestamp(timestamp: string | undefined): string {
	if (timestamp === undefined) return "unknown";
	const parsed = Date.parse(timestamp);
	if (!Number.isFinite(parsed)) return timestamp;
	return new Date(parsed).toLocaleString(undefined, {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
}

function formatDuration(ms: number): string {
	if (ms < 1_000) return `${ms}ms`;
	const seconds = ms / 1_000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${Math.round(seconds % 60)}s`;
}

function truncateOneLine(text: string, maxLength: number): string {
	const normalized = stripAnsi(text).replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) return normalized;
	if (maxLength <= 3) return normalized.slice(0, maxLength);
	return `${normalized.slice(0, maxLength - 3)}...`;
}

function stripAnsi(value: string): string {
	return value.replace(ANSI_STYLE_SEQUENCE_PATTERN, "");
}

function parsePositiveIntegerFlag(value: string, label: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer.`);
	return parsed;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
	return value === undefined || !Number.isFinite(value) || value < 1 ? fallback : Math.floor(value);
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function assignOptionalString<T extends object, K extends keyof T>(target: T, key: K, value: unknown): void {
	if (typeof value === "string" && value.length > 0) {
		(target as Record<string, unknown>)[String(key)] = value;
	}
}
