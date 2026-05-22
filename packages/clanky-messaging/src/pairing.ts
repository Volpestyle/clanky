import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Platform } from "./types.ts";

export type PairingState = "pending" | "active" | "revoked";

export interface PairingRecord {
	id: string;
	platform: Platform;
	userId: string;
	chatId?: string;
	displayName?: string;
	state: PairingState;
	createdAt: string;
	updatedAt: string;
	expiresAt?: string;
	code?: string;
	scopes: string[];
}

export interface CreatePairingInput {
	platform: Platform;
	userId: string;
	chatId?: string;
	displayName?: string;
	expiresInSeconds?: number;
	scopes?: readonly string[];
}

interface PairingFile {
	version: 1;
	records: PairingRecord[];
}

const CURRENT_VERSION = 1;
const DEFAULT_TTL_SECONDS = 600;

export class PairingStore {
	private readonly file: string;
	private records: Map<string, PairingRecord> = new Map();
	private loaded = false;
	private writeLock: Promise<void> = Promise.resolve();

	constructor(file: string) {
		this.file = file;
	}

	async load(): Promise<void> {
		if (this.loaded) return;
		const raw = await readFile(this.file, "utf8").catch(() => undefined);
		if (raw !== undefined) {
			try {
				const parsed = JSON.parse(raw) as PairingFile;
				if (parsed.version === CURRENT_VERSION && Array.isArray(parsed.records)) {
					for (const record of parsed.records) {
						if (!isPairingRecord(record)) continue;
						this.records.set(record.id, record);
					}
				}
			} catch {
				// ignore corrupt file
			}
		}
		this.loaded = true;
	}

	async create(input: CreatePairingInput): Promise<PairingRecord> {
		await this.load();
		const id = `${input.platform}:${input.userId}:${Date.now()}`;
		const code = generatePairingCode();
		const ttlSeconds = input.expiresInSeconds ?? DEFAULT_TTL_SECONDS;
		const now = new Date();
		const expiresAt = new Date(now.getTime() + ttlSeconds * 1_000);
		const record: PairingRecord = {
			id,
			platform: input.platform,
			userId: input.userId,
			state: "pending",
			createdAt: now.toISOString(),
			updatedAt: now.toISOString(),
			expiresAt: expiresAt.toISOString(),
			code,
			scopes: [...(input.scopes ?? [])],
		};
		if (input.chatId !== undefined) record.chatId = input.chatId;
		if (input.displayName !== undefined) record.displayName = input.displayName;
		this.records.set(id, record);
		await this.persist();
		return record;
	}

	async confirm(
		code: string,
		options: { confirmedBy: { platform: Platform; userId: string } },
	): Promise<PairingRecord | undefined> {
		await this.load();
		const trimmed = code.trim();
		for (const record of this.records.values()) {
			if (record.code === trimmed && record.state === "pending" && !isExpired(record)) {
				if (record.platform !== options.confirmedBy.platform || record.userId !== options.confirmedBy.userId) {
					continue;
				}
				const updated: PairingRecord = {
					...record,
					state: "active",
					updatedAt: new Date().toISOString(),
				};
				delete updated.code;
				this.records.set(record.id, updated);
				await this.persist();
				return updated;
			}
		}
		return undefined;
	}

	async revoke(id: string): Promise<boolean> {
		await this.load();
		const record = this.records.get(id);
		if (record === undefined) return false;
		const updated: PairingRecord = { ...record, state: "revoked", updatedAt: new Date().toISOString() };
		this.records.set(id, updated);
		await this.persist();
		return true;
	}

	async list(platform?: Platform): Promise<PairingRecord[]> {
		await this.load();
		const records = [...this.records.values()];
		return platform === undefined ? records : records.filter((record) => record.platform === platform);
	}

	async isActive(platform: Platform, userId: string): Promise<boolean> {
		await this.load();
		for (const record of this.records.values()) {
			if (record.platform === platform && record.userId === userId && record.state === "active") return true;
		}
		return false;
	}

	private async persist(): Promise<void> {
		const next = this.writeLock.then(async () => {
			await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
			const file: PairingFile = { version: CURRENT_VERSION, records: [...this.records.values()] };
			const tmp = `${this.file}.${process.pid}.tmp`;
			await writeFile(tmp, `${JSON.stringify(file, null, "\t")}\n`, { mode: 0o600 });
			await rename(tmp, this.file);
		});
		this.writeLock = next.then(
			() => undefined,
			() => undefined,
		);
		await next;
	}
}

function generatePairingCode(): string {
	return randomBytes(4).readUInt32BE(0).toString().padStart(6, "0").slice(0, 6);
}

function isExpired(record: PairingRecord): boolean {
	if (record.expiresAt === undefined) return false;
	const parsed = Date.parse(record.expiresAt);
	return Number.isFinite(parsed) && parsed <= Date.now();
}

function isPairingRecord(value: unknown): value is PairingRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (record.platform !== "telegram" && record.platform !== "discord") return false;
	if (typeof record.id !== "string" || typeof record.userId !== "string") return false;
	if (record.state !== "pending" && record.state !== "active" && record.state !== "revoked") return false;
	if (typeof record.createdAt !== "string" || typeof record.updatedAt !== "string") return false;
	if (!Array.isArray(record.scopes)) return false;
	return true;
}
