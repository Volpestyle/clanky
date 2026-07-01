/**
 * The single .env.local store for Clanky.
 *
 * .env.local at the repo root is the durable, uncommitted config store every
 * Clanky surface edits (face slash commands, the headless command host, and the
 * iOS relay menus). This module is the one parser/reader/writer; the face, the
 * CLI, and the lifecycle script previously each carried their own divergent
 * copy.
 *
 * Precedence rule (readEffectiveEnv): **process.env wins over .env.local.**
 * This matches how the brain itself sees config — eve loads .env/.env.local
 * dotenv-style, which never overrides an already-set environment variable — so
 * every Clanky process computes the same effective value, and a per-launch
 * `CLANKY_X=... clanky dev` override deliberately beats saved config. Readers
 * that care only about what is durably saved (config menus that display and
 * edit the file) use readEnvLocal, the raw file map.
 *
 * Writes are atomic (tmp file + rename), 0600 (the file holds secrets), and
 * serialized through a lock file because up to three processes write it
 * concurrently (face, command host, iOS relay menu flows). The merge itself is
 * the tested comment/order-preserving upsert from discord/env-file.ts.
 */
import { readFileSync } from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { applyEnvRemovals, applyEnvUpserts } from "./discord/env-file.ts";

const LOCK_SUFFIX = ".lock";
const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 10_000;

export function resolveClankyRepoDir(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.CLANKY_REPO_DIR?.trim() || join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
}

export function resolveEnvLocalPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(resolveClankyRepoDir(env), ".env.local");
}

function parseEnvContent(content: string): Record<string, string> {
	if (content.trim().length === 0) return {};
	const parsed = parseEnv(content);
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (typeof value === "string") out[key] = value;
	}
	return out;
}

/** The raw saved file map (no process.env merged in). Missing file → {}. */
export async function readEnvLocal(env: NodeJS.ProcessEnv = process.env): Promise<Record<string, string>> {
	const content = await readFile(resolveEnvLocalPath(env), "utf8").catch(() => "");
	return parseEnvContent(content);
}

/** Synchronous variant for startup/signal paths that cannot await. */
export function readEnvLocalSync(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
	let content: string;
	try {
		content = readFileSync(resolveEnvLocalPath(env), "utf8");
	} catch {
		return {};
	}
	return parseEnvContent(content);
}

/** Saved file values with process.env layered on top (process.env wins). */
export async function readEffectiveEnv(env: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
	return { ...(await readEnvLocal(env)), ...env };
}

/**
 * Apply removals then upserts to .env.local, preserving comments and line
 * order, atomically (tmp + rename), mode 0600, serialized via a lock file.
 */
export async function updateEnvLocal(
	input: { updates?: Record<string, string>; removals?: readonly string[] },
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const path = resolveEnvLocalPath(env);
	const updates = input.updates ?? {};
	const removals = input.removals ?? [];
	if (Object.keys(updates).length === 0 && removals.length === 0) return;
	await withEnvLocalLock(path, async () => {
		const existing = await readFile(path, "utf8").catch(() => "");
		const withoutRemovals = removals.length === 0 ? existing : applyEnvRemovals(existing, removals);
		const next = Object.keys(updates).length === 0 ? withoutRemovals : applyEnvUpserts(withoutRemovals, updates);
		const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
		await writeFile(tmp, next, { encoding: "utf8", mode: 0o600 });
		await rename(tmp, path);
	});
}

async function withEnvLocalLock<T>(path: string, action: () => Promise<T>): Promise<T> {
	const lockPath = `${path}${LOCK_SUFFIX}`;
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	for (;;) {
		try {
			await writeFile(lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			await breakStaleLock(lockPath);
			if (Date.now() > deadline) {
				throw new Error(`timed out waiting for ${lockPath}; another Clanky process is writing .env.local`);
			}
			await new Promise((resolvePromise) => setTimeout(resolvePromise, LOCK_RETRY_MS));
		}
	}
	try {
		return await action();
	} finally {
		await rm(lockPath, { force: true }).catch(() => undefined);
	}
}

async function breakStaleLock(lockPath: string): Promise<void> {
	try {
		const raw = await readFile(lockPath, "utf8");
		const pid = Number.parseInt(raw.trim(), 10);
		const holderAlive = Number.isSafeInteger(pid) && pid > 0 && isPidAlive(pid);
		const info = await stat(lockPath);
		const age = Date.now() - info.mtimeMs;
		if (!holderAlive || age > LOCK_STALE_MS) await rm(lockPath, { force: true });
	} catch {
		// Lock vanished between check and read; the retry loop handles it.
	}
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
