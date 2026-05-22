import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Platform } from "./types.ts";

export interface MirrorTarget {
	platform: Platform;
	chatId: string;
	threadId?: string;
}

export interface MirrorRoute {
	id: string;
	source: MirrorTarget;
	destinations: MirrorTarget[];
	enabled: boolean;
	includeInbound: boolean;
	includeOutbound: boolean;
	prefix?: string;
	createdAt: string;
	updatedAt: string;
}

export interface CreateMirrorRouteInput {
	source: MirrorTarget;
	destinations: readonly MirrorTarget[];
	includeInbound?: boolean;
	includeOutbound?: boolean;
	prefix?: string;
}

interface MirrorFile {
	version: 1;
	routes: MirrorRoute[];
}

const CURRENT_VERSION = 1;

export class MirrorRouter {
	private readonly file: string;
	private routes: Map<string, MirrorRoute> = new Map();
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
				const parsed = JSON.parse(raw) as MirrorFile;
				if (parsed.version === CURRENT_VERSION && Array.isArray(parsed.routes)) {
					for (const route of parsed.routes) {
						if (!isMirrorRoute(route)) continue;
						this.routes.set(route.id, route);
					}
				}
			} catch {
				// ignore corrupt file
			}
		}
		this.loaded = true;
	}

	async create(input: CreateMirrorRouteInput): Promise<MirrorRoute> {
		await this.load();
		const id = `${input.source.platform}:${input.source.chatId}:${input.source.threadId ?? "root"}`;
		const now = new Date().toISOString();
		const route: MirrorRoute = {
			id,
			source: input.source,
			destinations: [...input.destinations],
			enabled: true,
			includeInbound: input.includeInbound ?? true,
			includeOutbound: input.includeOutbound ?? true,
			createdAt: now,
			updatedAt: now,
		};
		if (input.prefix !== undefined) route.prefix = input.prefix;
		this.routes.set(id, route);
		await this.persist();
		return route;
	}

	async remove(id: string): Promise<boolean> {
		await this.load();
		const existed = this.routes.delete(id);
		if (existed) await this.persist();
		return existed;
	}

	async setEnabled(id: string, enabled: boolean): Promise<MirrorRoute | undefined> {
		await this.load();
		const existing = this.routes.get(id);
		if (existing === undefined) return undefined;
		const updated: MirrorRoute = { ...existing, enabled, updatedAt: new Date().toISOString() };
		this.routes.set(id, updated);
		await this.persist();
		return updated;
	}

	async list(): Promise<MirrorRoute[]> {
		await this.load();
		return [...this.routes.values()];
	}

	async destinationsFor(source: MirrorTarget, direction: "inbound" | "outbound"): Promise<MirrorTarget[]> {
		await this.load();
		const destinations: MirrorTarget[] = [];
		for (const route of this.routes.values()) {
			if (!route.enabled) continue;
			if (!matchesSource(route.source, source)) continue;
			if (direction === "inbound" && !route.includeInbound) continue;
			if (direction === "outbound" && !route.includeOutbound) continue;
			destinations.push(...route.destinations);
		}
		return destinations;
	}

	private async persist(): Promise<void> {
		const next = this.writeLock.then(async () => {
			await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
			const data: MirrorFile = { version: CURRENT_VERSION, routes: [...this.routes.values()] };
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

function matchesSource(routeSource: MirrorTarget, candidate: MirrorTarget): boolean {
	if (routeSource.platform !== candidate.platform) return false;
	if (routeSource.chatId !== candidate.chatId) return false;
	if (routeSource.threadId !== candidate.threadId) return false;
	return true;
}

function isMirrorRoute(value: unknown): value is MirrorRoute {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (typeof record.id !== "string") return false;
	if (!isMirrorTarget(record.source)) return false;
	if (!Array.isArray(record.destinations) || !record.destinations.every(isMirrorTarget)) return false;
	if (typeof record.enabled !== "boolean") return false;
	if (typeof record.includeInbound !== "boolean") return false;
	if (typeof record.includeOutbound !== "boolean") return false;
	return true;
}

function isMirrorTarget(value: unknown): value is MirrorTarget {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (record.platform !== "telegram" && record.platform !== "discord") return false;
	if (typeof record.chatId !== "string") return false;
	if (record.threadId !== undefined && typeof record.threadId !== "string") return false;
	return true;
}
