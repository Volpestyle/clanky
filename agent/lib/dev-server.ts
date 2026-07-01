/**
 * Shared eve dev-server discovery/health/stop plumbing.
 *
 * The face (scripts/clanky.ts) and the CLI (bin/clanky.ts) both attach to or
 * own a headless `eve dev --no-ui` brain and previously carried byte-similar
 * copies of this logic that drifted on timeouts. This is the single copy.
 *
 * Timeouts are env-tunable (the face's behavior, adopted for both callers):
 *   CLANKY_EVE_HEALTH_TIMEOUT_MS  wait for a starting brain (default 180000)
 *   CLANKY_EVE_STOP_TIMEOUT_MS    SIGTERM grace before SIGKILL (default 5000)
 *   CLANKY_EVE_KILL_TIMEOUT_MS    SIGKILL wait (default 2000)
 *   CLANKY_EVE_PROBE_TIMEOUT_MS   per-probe fetch timeout (default 2000)
 */
import type { ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DevServerRecord {
	readonly pid: number;
	readonly updatedAt?: string;
	readonly url: string;
}

export interface DiscoveredDevServer {
	readonly host: string;
	readonly record: DevServerRecord;
	readonly state: "healthy" | "reachable";
}

export interface DevServerTimeouts {
	readonly healthTimeoutMs: number;
	readonly stopTimeoutMs: number;
	readonly killTimeoutMs: number;
	readonly probeTimeoutMs: number;
	readonly recordStartupGraceMs: number;
	readonly unhealthySettleMs: number;
	readonly reprobeMs: number;
}

export function resolveDurationMs(value: string | undefined, fallback: number, envName: string): number {
	const raw = value?.trim();
	if (raw === undefined || raw.length === 0) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isInteger(parsed) || String(parsed) !== raw || parsed < 1) {
		throw new Error(`${envName} must be a positive integer number of milliseconds; got ${JSON.stringify(value)}`);
	}
	return parsed;
}

export function resolveDevServerTimeouts(env: NodeJS.ProcessEnv = process.env): DevServerTimeouts {
	return {
		healthTimeoutMs: resolveDurationMs(env.CLANKY_EVE_HEALTH_TIMEOUT_MS, 180_000, "CLANKY_EVE_HEALTH_TIMEOUT_MS"),
		stopTimeoutMs: resolveDurationMs(env.CLANKY_EVE_STOP_TIMEOUT_MS, 5_000, "CLANKY_EVE_STOP_TIMEOUT_MS"),
		killTimeoutMs: resolveDurationMs(env.CLANKY_EVE_KILL_TIMEOUT_MS, 2_000, "CLANKY_EVE_KILL_TIMEOUT_MS"),
		probeTimeoutMs: resolveDurationMs(env.CLANKY_EVE_PROBE_TIMEOUT_MS, 2_000, "CLANKY_EVE_PROBE_TIMEOUT_MS"),
		recordStartupGraceMs: 15_000,
		unhealthySettleMs: 5_000,
		reprobeMs: 500,
	};
}

export function devServerRecordPath(repoDir: string): string {
	return join(repoDir, ".eve", "dev-server.json");
}

export async function readDevServerRecord(file: string): Promise<DevServerRecord | undefined> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const record = parsed as { pid?: unknown; url?: unknown; updatedAt?: unknown };
	if (typeof record.pid !== "number" || !Number.isSafeInteger(record.pid)) return undefined;
	if (typeof record.url !== "string" || record.url.trim().length === 0) return undefined;
	return {
		pid: record.pid,
		updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : undefined,
		url: record.url,
	};
}

/** GET /eve/v1/info with a timeout so a wedged server can't hang the caller. */
export async function probeEveHost(host: string, timeoutMs = 2_000): Promise<"healthy" | "reachable" | "down"> {
	try {
		const response = await fetch(`${host}/eve/v1/info`, { signal: AbortSignal.timeout(timeoutMs) });
		return response.ok ? "healthy" : "reachable";
	} catch {
		return "down";
	}
}

export function normalizeHost(value: string): string | undefined {
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		return url.origin;
	} catch {
		return undefined;
	}
}

export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return typeof error === "object" && error !== null && "code" in error && String(error.code) === "EPERM";
	}
}

export async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
	if (!isPidAlive(pid)) return true;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await sleep(100);
		if (!isPidAlive(pid)) return true;
	}
	return !isPidAlive(pid);
}

/**
 * Recorded pids can be recycled by the OS. Before signaling one, confirm the
 * live process actually looks like our eve dev server (its argv mentions eve)
 * rather than an innocent process that inherited the pid.
 */
export async function pidLooksLikeEveDevServer(pid: number): Promise<boolean> {
	try {
		const { stdout } = await execFileAsync("ps", ["-o", "command=", "-p", String(pid)], {
			encoding: "utf8",
			timeout: 2_000,
		});
		const command = stdout.trim().toLowerCase();
		if (command.length === 0) return false;
		return command.includes("eve");
	} catch {
		// ps failed (process already gone, or no ps); treat as not ours.
		return false;
	}
}

export interface StopDevServerRecordOptions {
	readonly stopTimeoutMs: number;
	readonly killTimeoutMs: number;
	/** Called when SIGTERM grace elapses and SIGKILL is about to be sent. */
	readonly onForceKill?: (pid: number) => void;
	/** Called when the pid identity check refuses to signal a recycled pid. */
	readonly onIdentityMismatch?: (pid: number) => void;
}

export async function stopDevServerRecord(record: DevServerRecord, options: StopDevServerRecordOptions): Promise<void> {
	if (record.pid === process.pid) return;
	if (!isPidAlive(record.pid)) return;
	if (!(await pidLooksLikeEveDevServer(record.pid))) {
		options.onIdentityMismatch?.(record.pid);
		return;
	}
	try {
		process.kill(record.pid, "SIGTERM");
	} catch {
		return;
	}
	if (await waitForPidExit(record.pid, options.stopTimeoutMs)) return;
	options.onForceKill?.(record.pid);
	try {
		process.kill(record.pid, "SIGKILL");
	} catch {
		return;
	}
	await waitForPidExit(record.pid, options.killTimeoutMs);
}

/**
 * Remaining startup grace for a freshly written dev-server record: a brain that
 * updated its record within the last `recordStartupGraceMs` may still be
 * booting, so probes should keep retrying that long before declaring it dead.
 */
export function devServerRecordStartupGraceMs(record: DevServerRecord, graceMs: number): number {
	if (record.updatedAt === undefined) return 0;
	const updatedAt = Date.parse(record.updatedAt);
	if (!Number.isFinite(updatedAt)) return 0;
	const ageMs = Math.max(0, Date.now() - updatedAt);
	return Math.max(0, graceMs - ageMs);
}

export async function discoverDevServer(
	file: string,
	timeouts: DevServerTimeouts,
): Promise<DiscoveredDevServer | undefined> {
	const record = await readDevServerRecord(file);
	if (record === undefined || !isPidAlive(record.pid)) return undefined;
	const host = normalizeHost(record.url);
	if (host === undefined) return undefined;
	const initialState = await probeEveHost(host, timeouts.probeTimeoutMs);
	if (initialState === "healthy" || initialState === "reachable") return { host, record, state: initialState };

	const graceMs = devServerRecordStartupGraceMs(record, timeouts.recordStartupGraceMs);
	if (graceMs <= 0) return undefined;
	const deadline = Date.now() + graceMs;
	while (Date.now() < deadline && isPidAlive(record.pid)) {
		await sleep(Math.min(timeouts.reprobeMs, Math.max(0, deadline - Date.now())));
		const state = await probeEveHost(host, timeouts.probeTimeoutMs);
		if (state === "healthy" || state === "reachable") return { host, record, state };
	}
	return undefined;
}

export async function waitForHostHealth(
	host: string,
	timeoutMs: number,
	timeouts: DevServerTimeouts,
	shouldContinue: () => boolean = () => true,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline && shouldContinue()) {
		await sleep(Math.min(timeouts.reprobeMs, Math.max(0, deadline - Date.now())));
		if ((await probeEveHost(host, timeouts.probeTimeoutMs)) === "healthy") return true;
	}
	return false;
}

export async function waitForDiscoveredDevServerHealth(
	discovered: DiscoveredDevServer,
	timeouts: DevServerTimeouts,
): Promise<boolean> {
	const graceMs = Math.max(timeouts.unhealthySettleMs, devServerRecordStartupGraceMs(discovered.record, timeouts.recordStartupGraceMs));
	if (graceMs <= 0) return false;
	return await waitForHostHealth(discovered.host, graceMs, timeouts, () => isPidAlive(discovered.record.pid));
}

export function hasChildExited(child: ChildProcess): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

export async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (hasChildExited(child)) return true;
	return await new Promise<boolean>((resolvePromise) => {
		let settled = false;
		const finish = (exited: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			child.off("exit", onExit);
			child.off("error", onError);
			resolvePromise(exited);
		};
		const onExit = (): void => finish(true);
		const onError = (): void => finish(true);
		const timeout = setTimeout(() => finish(false), timeoutMs);
		child.once("exit", onExit);
		child.once("error", onError);
		if (hasChildExited(child)) finish(true);
	});
}

export async function stopDevServerChild(child: ChildProcess, options: { stopTimeoutMs: number; killTimeoutMs: number }): Promise<void> {
	if (hasChildExited(child)) return;
	child.kill("SIGTERM");
	if (await waitForChildExit(child, options.stopTimeoutMs)) return;
	child.kill("SIGKILL");
	await waitForChildExit(child, options.killTimeoutMs);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
