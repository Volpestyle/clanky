import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Platform } from "./types.ts";

export type ChatMode = "mention" | "opt_in_channel" | "dm_relationship" | "server";

export interface ChatSessionMapping {
	platform: Platform;
	chatId: string;
	threadId?: string;
	userId?: string;
	sessionId: string;
	createdAt: string;
	lastUsedAt: string;
	resetCount: number;
	displayName?: string;
	mode: ChatMode;
	consentedAt?: string;
}

export interface ChatSessionKey {
	platform: Platform;
	chatId: string;
	threadId?: string;
	userId?: string;
}

interface SessionsFile {
	version: 1;
	mappings: ChatSessionMapping[];
}

const CURRENT_VERSION = 1;

export class ChatSessionStore {
	private readonly file: string;
	private mappings: Map<string, ChatSessionMapping> = new Map();
	private loaded = false;
	private writeLock: Promise<void> = Promise.resolve();

	constructor(file: string) {
		this.file = file;
	}

	async load(): Promise<void> {
		if (this.loaded) return;
		const raw = await readFile(this.file, "utf8").catch(() => undefined);
		if (raw === undefined) {
			this.loaded = true;
			return;
		}
		try {
			const parsed = JSON.parse(raw) as SessionsFile;
			if (parsed.version === CURRENT_VERSION && Array.isArray(parsed.mappings)) {
				for (const mapping of parsed.mappings) {
					if (!isMapping(mapping)) continue;
					this.mappings.set(keyOf(mapping), mapping);
				}
			}
		} catch {
			// ignore corrupt file
		}
		this.loaded = true;
	}

	async get(key: ChatSessionKey): Promise<ChatSessionMapping | undefined> {
		await this.load();
		return this.mappings.get(keyString(key));
	}

	async set(mapping: ChatSessionMapping): Promise<void> {
		await this.load();
		this.mappings.set(keyOf(mapping), mapping);
		await this.persist();
	}

	async touch(key: ChatSessionKey, at: Date = new Date()): Promise<ChatSessionMapping | undefined> {
		await this.load();
		const existing = this.mappings.get(keyString(key));
		if (existing === undefined) return undefined;
		const updated: ChatSessionMapping = { ...existing, lastUsedAt: at.toISOString() };
		this.mappings.set(keyOf(updated), updated);
		await this.persist();
		return updated;
	}

	async reset(
		key: ChatSessionKey,
		newSessionId: string,
		options: { at?: Date; mode?: ChatMode } = {},
	): Promise<ChatSessionMapping> {
		await this.load();
		const existing = this.mappings.get(keyString(key));
		const ts = (options.at ?? new Date()).toISOString();
		const mapping: ChatSessionMapping = {
			platform: key.platform,
			chatId: key.chatId,
			sessionId: newSessionId,
			createdAt: ts,
			lastUsedAt: ts,
			resetCount: (existing?.resetCount ?? 0) + (existing === undefined ? 0 : 1),
			mode: options.mode ?? existing?.mode ?? "mention",
		};
		if (key.threadId !== undefined) mapping.threadId = key.threadId;
		if (key.userId !== undefined) mapping.userId = key.userId;
		if (existing?.displayName !== undefined) mapping.displayName = existing.displayName;
		if (existing?.consentedAt !== undefined) mapping.consentedAt = existing.consentedAt;
		this.mappings.set(keyOf(mapping), mapping);
		await this.persist();
		return mapping;
	}

	async setMode(
		key: ChatSessionKey,
		mode: ChatMode,
		consentedAt: Date = new Date(),
	): Promise<ChatSessionMapping | undefined> {
		await this.load();
		const existing = this.mappings.get(keyString(key));
		if (existing === undefined) return undefined;
		const updated: ChatSessionMapping = { ...existing, mode, consentedAt: consentedAt.toISOString() };
		this.mappings.set(keyOf(updated), updated);
		await this.persist();
		return updated;
	}

	async list(platform?: Platform): Promise<ChatSessionMapping[]> {
		await this.load();
		const all = [...this.mappings.values()];
		return platform === undefined ? all : all.filter((mapping) => mapping.platform === platform);
	}

	async remove(key: ChatSessionKey): Promise<boolean> {
		await this.load();
		const removed = this.mappings.delete(keyString(key));
		if (removed) await this.persist();
		return removed;
	}

	private async persist(): Promise<void> {
		const next = this.writeLock.then(async () => {
			await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
			const data: SessionsFile = { version: CURRENT_VERSION, mappings: [...this.mappings.values()] };
			const tmp = `${this.file}.${process.pid}.tmp`;
			await writeFile(tmp, `${JSON.stringify(data, null, "\t")}\n`, { mode: 0o600 });
			await rename(tmp, this.file);
		});
		this.writeLock = next.then(
			() => undefined,
			() => undefined,
		);
		await next;
	}
}

export function buildChatSessionKey(input: ChatSessionKey): string {
	return keyString(input);
}

function keyOf(mapping: ChatSessionMapping): string {
	const key: ChatSessionKey = { platform: mapping.platform, chatId: mapping.chatId };
	if (mapping.threadId !== undefined) key.threadId = mapping.threadId;
	if (mapping.userId !== undefined) key.userId = mapping.userId;
	return keyString(key);
}

function keyString(key: ChatSessionKey): string {
	const thread = key.threadId === undefined ? "" : `:t=${key.threadId}`;
	const user = key.userId === undefined ? "" : `:u=${key.userId}`;
	return `${key.platform}:${key.chatId}${thread}${user}`;
}

function isMapping(value: unknown): value is ChatSessionMapping {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (record.platform !== "telegram" && record.platform !== "discord") return false;
	if (typeof record.chatId !== "string" || record.chatId.length === 0) return false;
	if (typeof record.sessionId !== "string" || record.sessionId.length === 0) return false;
	if (typeof record.createdAt !== "string") return false;
	if (typeof record.lastUsedAt !== "string") return false;
	if (typeof record.resetCount !== "number") return false;
	if (record.threadId !== undefined && typeof record.threadId !== "string") return false;
	if (record.userId !== undefined && typeof record.userId !== "string") return false;
	if (
		record.mode !== "mention" &&
		record.mode !== "opt_in_channel" &&
		record.mode !== "dm_relationship" &&
		record.mode !== "server" &&
		record.mode !== undefined
	) {
		return false;
	}
	if (record.consentedAt !== undefined && typeof record.consentedAt !== "string") return false;
	return true;
}
