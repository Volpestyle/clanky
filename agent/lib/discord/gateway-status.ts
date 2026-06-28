import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscordInboundMessage, DiscordScopeOptions } from "./acceptance.ts";
import { resolveDiscordScopeOptions } from "./acceptance.ts";
import { type DiscordCredentialKind, resolveDiscordCredentialKind, resolveDiscordToken } from "./gateway.ts";

export type DiscordGatewayLock =
	| { status: "acquired"; path: string; ownerPid: number }
	| { status: "held"; path: string; ownerPid?: number };

export type DiscordGatewayOwner = "this-context" | "other-context" | "other-process" | "none";

export interface DiscordGatewaySessionStatus {
	channelId: string;
	sessionId: string;
	kind: DiscordInboundMessage["kind"];
	updatedAt: string;
	guildId?: string;
	authorId?: string;
	authorName?: string;
	newestMessageId?: string;
	newestMessageTextPreview?: string;
}

export interface DiscordGatewayStatus {
	pid: number;
	repo: string;
	startedAt: string;
	updatedAt: string;
	state: "starting" | "ready" | "failed";
	ready: boolean;
	credentialKind: DiscordCredentialKind;
	voice: boolean;
	scope: DiscordScopeOptions;
	sessions: DiscordGatewaySessionStatus[];
	error?: string;
}

export interface DiscordGatewayHealth {
	ok: boolean;
	running: boolean;
	ready: boolean | null;
	owner: DiscordGatewayOwner;
	lock: DiscordGatewayLock | null;
	scope: DiscordScopeOptions;
	error: string | null;
	status: DiscordGatewayStatus | null;
}

export interface DiscordGatewayToolStatus {
	ok: boolean;
	running: boolean;
	ready: boolean | null;
	owner: DiscordGatewayOwner;
	presenceEnabled: boolean;
	credentialConfigured: boolean;
	credentialKind: DiscordCredentialKind;
	voiceEnabled: boolean;
	scope: DiscordScopeOptions;
	state: DiscordGatewayStatus["state"] | "not-started";
	activeSessionCount: number;
	activeSessions: DiscordGatewaySessionStatus[];
	note: string;
	error?: string;
	pid?: number;
	repo?: string;
	startedAt?: string;
	updatedAt?: string;
}

const DISCORD_GATEWAY_TEXT_PREVIEW_CHARS = 500;

export function discordGatewayLockPath(env: NodeJS.ProcessEnv = process.env): string {
	const repo = discordGatewayRepo(env);
	const hash = createHash("sha1").update(repo).digest("hex").slice(0, 16);
	return join(tmpdir(), `clanky-discord-gateway-${hash}.lock`);
}

export function acquireDiscordGatewayLock(env: NodeJS.ProcessEnv = process.env): DiscordGatewayLock {
	const path = discordGatewayLockPath(env);
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			mkdirSync(path);
			const lock: DiscordGatewayLock = { status: "acquired", path, ownerPid: process.pid };
			writeFileSync(
				join(path, "owner.json"),
				JSON.stringify({ pid: process.pid, repo: discordGatewayRepo(env), startedAt: new Date().toISOString() }),
			);
			process.once("exit", () => releaseDiscordGatewayLock(lock));
			return lock;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw error;
			const ownerPid = readDiscordGatewayLockOwner(path);
			if (ownerPid !== undefined && !isProcessAlive(ownerPid)) {
				rmSync(path, { recursive: true, force: true });
				continue;
			}
			return { status: "held", path, ...(ownerPid === undefined ? {} : { ownerPid }) };
		}
	}
	return { status: "held", path, ownerPid: readDiscordGatewayLockOwner(path) };
}

export function releaseDiscordGatewayLock(lock: DiscordGatewayLock | null): void {
	if (lock?.status !== "acquired") return;
	rmSync(lock.path, { recursive: true, force: true });
}

export function readDiscordGatewayLock(env: NodeJS.ProcessEnv = process.env): DiscordGatewayLock | null {
	const path = discordGatewayLockPath(env);
	if (!existsSync(path)) return null;
	const ownerPid = readDiscordGatewayLockOwner(path);
	if (ownerPid !== undefined && !isProcessAlive(ownerPid)) return null;
	return { status: "held", path, ...(ownerPid === undefined ? {} : { ownerPid }) };
}

export function writeDiscordGatewayStatus(
	lock: DiscordGatewayLock | null,
	status: {
		state: DiscordGatewayStatus["state"];
		ready: boolean;
		credentialKind: DiscordGatewayStatus["credentialKind"];
		voice: boolean;
		sessions: DiscordGatewayStatus["sessions"];
		error?: string;
	},
	options: { env?: NodeJS.ProcessEnv; startedAt: string },
): void {
	if (lock?.status !== "acquired") return;
	const env = options.env ?? process.env;
	const snapshot: DiscordGatewayStatus = {
		pid: process.pid,
		repo: discordGatewayRepo(env),
		startedAt: options.startedAt,
		updatedAt: new Date().toISOString(),
		state: status.state,
		ready: status.ready,
		credentialKind: status.credentialKind,
		voice: status.voice,
		scope: resolveDiscordScopeOptions(env),
		sessions: status.sessions,
		...(status.error === undefined ? {} : { error: status.error }),
	};
	writeFileSync(discordGatewayStatusPath(lock.path), JSON.stringify(snapshot, null, 2));
}

export function readDiscordGatewayStatus(lock: DiscordGatewayLock | null): DiscordGatewayStatus | null {
	if (lock === null) return null;
	try {
		const parsed = JSON.parse(readFileSync(discordGatewayStatusPath(lock.path), "utf8")) as unknown;
		if (!isRecord(parsed)) return null;
		return parsed as unknown as DiscordGatewayStatus;
	} catch {
		return null;
	}
}

export function resolveDiscordGatewayHealth(
	options: {
		env?: NodeJS.ProcessEnv;
		lock?: DiscordGatewayLock | null;
		hostPresent?: boolean;
		hostReady?: boolean;
		startError?: string | null;
	} = {},
): DiscordGatewayHealth {
	const env = options.env ?? process.env;
	const lock = options.lock === undefined ? readDiscordGatewayLock(env) : options.lock;
	const status = readDiscordGatewayStatus(lock);
	const owner = resolveDiscordGatewayOwner(lock, options.hostPresent === true);
	const ready = options.hostReady ?? status?.ready ?? (owner === "other-context" ? null : false);
	const error = options.startError ?? status?.error ?? null;
	return {
		ok: error === null,
		running: owner !== "none",
		ready,
		owner,
		lock,
		scope: resolveDiscordScopeOptions(env),
		error,
		status,
	};
}

export function discordGatewayToolStatus(env: NodeJS.ProcessEnv = process.env): DiscordGatewayToolStatus {
	const health = resolveDiscordGatewayHealth({ env });
	const status = health.status;
	const error = health.error ?? status?.error;
	const activeSessions = status?.sessions ?? [];
	return {
		ok: health.ok,
		running: health.running,
		ready: health.ready,
		owner: health.owner,
		presenceEnabled: env.CLANKY_DISCORD_PRESENCE === "1",
		credentialConfigured: resolveDiscordToken(env) !== undefined,
		credentialKind: status?.credentialKind ?? resolveDiscordCredentialKind(env),
		voiceEnabled: status?.voice ?? env.CLANKY_DISCORD_VOICE === "1",
		scope: health.scope,
		state: status?.state ?? "not-started",
		activeSessionCount: activeSessions.length,
		activeSessions,
		note: discordGatewayToolStatusNote(health, env),
		...(error === undefined || error === null ? {} : { error }),
		...(status?.pid === undefined ? {} : { pid: status.pid }),
		...(status?.repo === undefined ? {} : { repo: status.repo }),
		...(status?.startedAt === undefined ? {} : { startedAt: status.startedAt }),
		...(status?.updatedAt === undefined ? {} : { updatedAt: status.updatedAt }),
	};
}

export function discordGatewaySessionStatusFromMessage(
	message: DiscordInboundMessage,
	sessionId: string,
	updatedAt: string = new Date().toISOString(),
): DiscordGatewaySessionStatus {
	const text = message.text.trim();
	return {
		channelId: message.channelId,
		sessionId,
		kind: message.kind,
		updatedAt,
		...(message.guildId === undefined ? {} : { guildId: message.guildId }),
		authorId: message.authorId,
		...(message.authorName === undefined ? {} : { authorName: message.authorName }),
		newestMessageId: message.externalMessageId,
		...(text.length === 0 ? {} : { newestMessageTextPreview: truncateText(text, DISCORD_GATEWAY_TEXT_PREVIEW_CHARS) }),
	};
}

function resolveDiscordGatewayOwner(lock: DiscordGatewayLock | null, hostPresent: boolean): DiscordGatewayOwner {
	if (hostPresent) return "this-context";
	if (lock === null) return "none";
	if (lock.status === "acquired") return "this-context";
	if (lock.ownerPid === process.pid) return "other-context";
	return "other-process";
}

function discordGatewayToolStatusNote(health: DiscordGatewayHealth, env: NodeJS.ProcessEnv): string {
	if (env.CLANKY_DISCORD_PRESENCE !== "1") return "Discord gateway presence is disabled for this runtime.";
	if (resolveDiscordToken(env) === undefined) return "Discord gateway presence is enabled, but no Discord token is configured.";
	if (!health.running) return "Discord gateway presence is configured, but no live gateway owner is recorded.";
	if (health.ready !== true) return "Discord gateway presence is running, but it is not ready yet.";
	if ((health.status?.sessions.length ?? 0) === 0) return "Discord gateway is ready, but no accepted presence sessions are recorded.";
	return "Discord gateway is ready; activeSessions are live accepted Discord presence sessions, not full message history.";
}

function discordGatewayStatusPath(lockPath: string): string {
	return join(lockPath, "status.json");
}

function discordGatewayRepo(env: NodeJS.ProcessEnv): string {
	return env.CLANKY_REPO_DIR ?? process.cwd();
}

function readDiscordGatewayLockOwner(path: string): number | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as { pid?: unknown };
		return typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : undefined;
	} catch {
		return undefined;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars - 3)}...`;
}
