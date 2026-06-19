import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveClankyDataPath } from "./paths.ts";

export type MemorySubjectKind = "main_user" | "discord_user" | "discord_server" | "project" | "other";

export interface MemoryFact {
	id: string;
	subjectKind: MemorySubjectKind;
	subjectId?: string;
	subjectName?: string;
	fact: string;
	source?: string;
	tags: string[];
	importance: number;
	createdAt: string;
	updatedAt: string;
}

export interface RememberMemoryInput {
	subjectKind: MemorySubjectKind;
	subjectId?: string;
	subjectName?: string;
	fact: string;
	source?: string;
	tags?: string[];
	importance?: number;
}

export interface SearchMemoryInput {
	query?: string;
	subjectKind?: MemorySubjectKind;
	subjectId?: string;
	tags?: string[];
	limit?: number;
}

export interface MemoryContextInput {
	limit?: number;
	messages?: readonly unknown[];
	channelMetadata?: Readonly<Record<string, unknown>>;
	authPrincipalId?: string;
	authAuthenticator?: string;
	authAttributes?: Readonly<Record<string, unknown>>;
	query?: string;
	discordUserId?: string;
	discordUserName?: string;
	discordServerId?: string;
	includeMainUser?: boolean;
}

interface MemoryContextScope {
	query: string;
	discordUserId?: string;
	discordUserName?: string;
	discordServerId?: string;
	includeMainUser: boolean;
}

const MEMORY_FILE = "memory/facts.json";
const DEFAULT_CONTEXT_LIMIT = 16;

// Serialize the read-modify-write of the facts file. Multiple writers run
// concurrently in practice (the voice/Discord bindings persist facts from
// fire-and-forget listeners), and an unsynchronized read-then-write loses
// updates because each writer starts from the same base array.
let memoryWriteChain: Promise<unknown> = Promise.resolve();

function withMemoryWriteLock<T>(task: () => Promise<T>): Promise<T> {
	const run = memoryWriteChain.then(task, task);
	memoryWriteChain = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

export async function rememberMemory(input: RememberMemoryInput): Promise<MemoryFact> {
	const fact = input.fact.trim();
	if (fact.length === 0) throw new Error("memory fact must not be empty");
	const now = new Date().toISOString();
	const next: MemoryFact = {
		id: randomUUID(),
		subjectKind: input.subjectKind,
		fact,
		tags: normalizeTags(input.tags),
		importance: clampImportance(input.importance ?? 3),
		createdAt: now,
		updatedAt: now,
	};
	if (input.subjectId?.trim()) next.subjectId = input.subjectId.trim();
	if (input.subjectName?.trim()) next.subjectName = input.subjectName.trim();
	if (input.source?.trim()) next.source = input.source.trim();

	return withMemoryWriteLock(async () => {
		const memories = await readMemories();
		memories.push(next);
		await writeMemories(dedupeMemories(memories));
		return next;
	});
}

export async function searchMemories(input: SearchMemoryInput = {}): Promise<MemoryFact[]> {
	const memories = await readMemories();
	const queryTokens = tokenize(input.query ?? "");
	const tagSet = new Set(normalizeTags(input.tags));
	const requestedLimit = Math.floor(input.limit ?? DEFAULT_CONTEXT_LIMIT);
	const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(100, requestedLimit)) : DEFAULT_CONTEXT_LIMIT;
	return memories
		.filter((memory) => input.subjectKind === undefined || memory.subjectKind === input.subjectKind)
		.filter((memory) => input.subjectId === undefined || memory.subjectId === input.subjectId)
		.filter((memory) => tagSet.size === 0 || memory.tags.some((tag) => tagSet.has(tag)))
		.map((memory) => ({ memory, score: memoryScore(memory, queryTokens) }))
		.filter((entry) => queryTokens.length === 0 || entry.score > 0)
		.sort((left, right) => right.score - left.score || right.memory.updatedAt.localeCompare(left.memory.updatedAt))
		.slice(0, limit)
		.map((entry) => entry.memory);
}

export async function buildMemoryContext(input: number | MemoryContextInput = DEFAULT_CONTEXT_LIMIT): Promise<string> {
	const normalized = typeof input === "number" ? { limit: input } : input;
	const limit = normalizeContextLimit(normalized.limit);
	const scope = inferMemoryContextScope(normalized);
	const memories = await collectScopedMemories(scope, limit);
	if (memories.length === 0) return "";
	const lines = memories.map((memory) => {
		const subject = [memory.subjectKind, memory.subjectName ?? memory.subjectId].filter(Boolean).join(":");
		const tags = memory.tags.length === 0 ? "" : ` tags=${memory.tags.join(",")}`;
		return `- [${subject || memory.subjectKind}; importance=${memory.importance}${tags}] ${memory.fact}`;
	});
	const scopeLines = formatMemoryScope(scope);
	return [
		"## Durable Clanky Memory",
		"These are scoped user, server, project, or owner facts selected for this turn from Clanky's durable store. Use them when relevant, but explicit user instructions and fresh evidence win.",
		...(scopeLines.length === 0 ? [] : ["Memory selection scope:", ...scopeLines]),
		...lines,
	].join("\n");
}

export function inferMemoryContextScope(input: MemoryContextInput = {}): MemoryContextScope {
	const messageText = latestMessageText(input.messages ?? []);
	const metadata = input.channelMetadata ?? {};
	const authAttributes = input.authAttributes ?? {};
	const discordAuthPrincipalId =
		isDiscordAuthenticator(input.authAuthenticator) ? trimmed(input.authPrincipalId) : undefined;
	const discordUserId =
		trimmed(input.discordUserId) ??
		metadataString(metadata, ["discordUserId", "discordAuthorId", "authorId", "speakerUserId", "userId"]) ??
		metadataString(authAttributes, [
			"discordUserId",
			"discord_user_id",
			"discordAuthorId",
			"authorId",
			"userId",
			"user_id",
			"speakerUserId",
		]) ??
		discordAuthPrincipalId ??
		parsePromptField(messageText, ["authorId", "speakerUserId"]);
	const discordUserName =
		trimmed(input.discordUserName) ??
		metadataString(metadata, ["discordUserName", "authorName", "speakerName", "userName"]) ??
		metadataString(authAttributes, [
			"discordUserName",
			"discord_user_name",
			"authorName",
			"speakerName",
			"userName",
			"user_name",
			"username",
			"global_name",
			"member_nick",
			"name",
		]) ??
		parsePromptField(messageText, ["authorName", "speakerName"]) ??
		parseFreeformField(messageText, "From");
	const discordServerId =
		trimmed(input.discordServerId) ??
		metadataString(metadata, ["discordServerId", "guildId", "serverId"]) ??
		metadataString(authAttributes, ["discordServerId", "discord_server_id", "guildId", "guild_id", "serverId"]) ??
		parsePromptField(messageText, ["serverId", "guildId"]);
	const query = trimmed(input.query) ?? promptQuery(messageText);
	const hasDiscordScope = discordUserId !== undefined || discordServerId !== undefined || isDiscordPrompt(messageText);
	return {
		query,
		...(discordUserId === undefined ? {} : { discordUserId }),
		...(discordUserName === undefined ? {} : { discordUserName }),
		...(discordServerId === undefined ? {} : { discordServerId }),
		includeMainUser: input.includeMainUser ?? !hasDiscordScope,
	};
}

export async function readMemories(env: NodeJS.ProcessEnv = process.env): Promise<MemoryFact[]> {
	const path = resolveClankyDataPath(MEMORY_FILE, env);
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.flatMap(parseMemoryFact);
	} catch (error) {
		if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") return [];
		throw error;
	}
}

async function writeMemories(memories: readonly MemoryFact[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const path = resolveClankyDataPath(MEMORY_FILE, env);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmp, `${JSON.stringify(memories, null, "\t")}\n`, { mode: 0o600 });
	await rename(tmp, path);
}

function parseMemoryFact(value: unknown): MemoryFact[] {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
	const record = value as Record<string, unknown>;
	if (typeof record.id !== "string" || typeof record.fact !== "string") return [];
	if (!isSubjectKind(record.subjectKind)) return [];
	const tags = Array.isArray(record.tags)
		? record.tags.flatMap((tag) => (typeof tag === "string" ? [tag] : []))
		: [];
	return [
		{
			id: record.id,
			subjectKind: record.subjectKind,
			fact: record.fact,
			tags: normalizeTags(tags),
			importance: typeof record.importance === "number" ? clampImportance(record.importance) : 3,
			createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date(0).toISOString(),
			updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date(0).toISOString(),
			...(typeof record.subjectId === "string" ? { subjectId: record.subjectId } : {}),
			...(typeof record.subjectName === "string" ? { subjectName: record.subjectName } : {}),
			...(typeof record.source === "string" ? { source: record.source } : {}),
		},
	];
}

function dedupeMemories(memories: readonly MemoryFact[]): MemoryFact[] {
	const seen = new Set<string>();
	const out: MemoryFact[] = [];
	for (const memory of memories) {
		const key = `${memory.subjectKind}\u0000${memory.subjectId ?? ""}\u0000${memory.fact.toLowerCase()}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(memory);
	}
	return out.slice(-5000);
}

async function collectScopedMemories(scope: MemoryContextScope, limit: number): Promise<MemoryFact[]> {
	if (limit <= 0) return [];
	const perBucketLimit = Math.max(limit, DEFAULT_CONTEXT_LIMIT);
	const buckets: MemoryFact[][] = [];
	if (scope.discordUserId !== undefined) {
		buckets.push(await searchMemories({ subjectKind: "discord_user", subjectId: scope.discordUserId, limit: perBucketLimit }));
	}
	if (scope.discordServerId !== undefined) {
		buckets.push(await searchMemories({ subjectKind: "discord_server", subjectId: scope.discordServerId, limit: perBucketLimit }));
	}
	if (scope.includeMainUser) {
		buckets.push(await searchMemories({ subjectKind: "main_user", limit: perBucketLimit }));
	}
	if (scope.query.length > 0) {
		buckets.push(await searchMemories({ query: scope.query, subjectKind: "project", limit: perBucketLimit }));
		buckets.push(await searchMemories({ query: scope.query, subjectKind: "other", limit: perBucketLimit }));
	}
	const seen = new Set<string>();
	const out: MemoryFact[] = [];
	for (const memory of buckets.flat()) {
		if (seen.has(memory.id)) continue;
		seen.add(memory.id);
		out.push(memory);
		if (out.length >= limit) break;
	}
	return out;
}

function normalizeContextLimit(limit: number | undefined): number {
	if (limit === undefined) return DEFAULT_CONTEXT_LIMIT;
	if (!Number.isFinite(limit)) return DEFAULT_CONTEXT_LIMIT;
	return Math.max(0, Math.min(50, Math.floor(limit)));
}

function formatMemoryScope(scope: MemoryContextScope): string[] {
	return [
		scope.discordUserId === undefined
			? undefined
			: `- discordUserId: ${scope.discordUserId}${scope.discordUserName === undefined ? "" : ` (${scope.discordUserName})`}`,
		scope.discordServerId === undefined ? undefined : `- discordServerId: ${scope.discordServerId}`,
		scope.includeMainUser ? "- mainUser: included" : undefined,
		scope.query.length === 0 ? undefined : `- query: ${scope.query.slice(0, 160)}`,
	].filter((line): line is string => line !== undefined);
}

function latestMessageText(messages: readonly unknown[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const text = messageText(messages[index]);
		if (text.length > 0) return text;
	}
	return "";
}

function messageText(message: unknown): string {
	if (!isRecord(message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap(contentPartText).join("\n").trim();
}

function contentPartText(part: unknown): string[] {
	if (!isRecord(part)) return [];
	if (part.type !== "text") return [];
	return typeof part.text === "string" ? [part.text] : [];
}

function metadataString(metadata: Readonly<Record<string, unknown>>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = metadataValue(metadata[key]);
		if (value !== undefined) return value;
	}
	return undefined;
}

function metadataValue(value: unknown): string | undefined {
	const single = trimmed(value);
	if (single !== undefined) return single;
	if (!Array.isArray(value)) return undefined;
	for (const item of value) {
		const itemValue = trimmed(item);
		if (itemValue !== undefined) return itemValue;
	}
	return undefined;
}

function parsePromptField(text: string, labels: readonly string[]): string | undefined {
	for (const label of labels) {
		const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const match = new RegExp(`(?:^|\\n)-\\s*${escaped}:\\s*([^\\n]+)`, "iu").exec(text);
		const value = trimmed(match?.[1]);
		if (value !== undefined && value !== "(none)") return value;
	}
	return undefined;
}

function parseFreeformField(text: string, label: string): string | undefined {
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = new RegExp(`(?:^|\\n)${escaped}:\\s*([^\\n]+)`, "iu").exec(text);
	return trimmed(match?.[1]);
}

function promptQuery(text: string): string {
	const voiceMarker = "\nNewest voice transcript:\n";
	const voiceIndex = text.indexOf(voiceMarker);
	if (voiceIndex >= 0) return text.slice(voiceIndex + voiceMarker.length).trim();
	const discordText = parseFreeformField(text, "Text");
	return discordText ?? text.slice(-1000).trim();
}

function isDiscordPrompt(text: string): boolean {
	return text.includes("Discord conversation update:") || text.includes("Discord voice conversation update:");
}

function trimmed(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isDiscordAuthenticator(value: string | undefined): boolean {
	return value?.toLowerCase().startsWith("discord") === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function memoryScore(memory: MemoryFact, queryTokens: readonly string[]): number {
	const haystack = tokenize([memory.subjectKind, memory.subjectId, memory.subjectName, memory.fact, memory.tags.join(" ")].join(" "));
	const hay = new Set(haystack);
	const matches = queryTokens.filter((token) => hay.has(token)).length;
	return matches * 10 + memory.importance * 2 + recencyScore(memory.updatedAt);
}

function recencyScore(value: string): number {
	const ageMs = Date.now() - Date.parse(value);
	if (!Number.isFinite(ageMs) || ageMs < 0) return 0;
	const ageDays = ageMs / 86_400_000;
	return Math.max(0, 7 - Math.floor(ageDays));
}

function tokenize(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^a-z0-9_@#:-]+/)
		.filter((token) => token.length >= 2);
}

function normalizeTags(tags: readonly string[] | undefined): string[] {
	if (tags === undefined) return [];
	const seen = new Set<string>();
	for (const tag of tags) {
		const normalized = tag.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
		if (normalized.length > 0) seen.add(normalized);
	}
	return [...seen].slice(0, 20);
}

function clampImportance(value: number): number {
	if (!Number.isFinite(value)) return 3;
	return Math.max(1, Math.min(5, Math.floor(value)));
}

function isSubjectKind(value: unknown): value is MemorySubjectKind {
	return (
		value === "main_user" ||
		value === "discord_user" ||
		value === "discord_server" ||
		value === "project" ||
		value === "other"
	);
}
