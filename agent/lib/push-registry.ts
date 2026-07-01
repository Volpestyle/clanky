/**
 * Device-token registry for mobile push (SPEC §4.4). Clients register an APNs
 * or FCM token over the relay after pairing; Clanky's push watcher reads this
 * list to decide who to notify. File-backed so registrations survive a brain
 * restart. Lives at resolveClankyDataPath("push-tokens.json") — the shared
 * Clanky home (~/.clanky by default); earlier builds defaulted to
 * ~/.config/clanky, so load() copies that file forward when the current home
 * has none.
 */
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveClankyDataPath } from "./paths.ts";

const REGISTRY_FILENAME = "push-tokens.json";

export type PushPlatform = "ios" | "android";

export interface PushDevice {
	token: string;
	platform: PushPlatform;
	/** Notify-worthy statuses, e.g. ["blocked","done"]. Empty = registry defaults. */
	events: string[];
	registeredAt: string;
}

function registryPath(): string {
	return resolveClankyDataPath(REGISTRY_FILENAME);
}

// Keyed on the resolved path so a CLANKY_HOME change (tests, profile switches)
// invalidates instead of serving another home's devices.
let cache: { path: string; devices: Map<string, PushDevice> } | undefined;

export function parsePushPlatform(value: unknown): PushPlatform | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "ios") return "ios";
	if (normalized === "android") return "android";
	return undefined;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function rec(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function deviceKey(device: Pick<PushDevice, "platform" | "token">): string {
	return `${device.platform}\0${device.token}`;
}

function parsePushDevice(value: unknown): PushDevice | undefined {
	const raw = rec(value);
	const token = str(raw.token);
	if (token === undefined) return undefined;
	const platform = parsePushPlatform(raw.platform) ?? "ios";
	const events = Array.isArray(raw.events) ? raw.events.map(String).filter((event) => event.length > 0) : [];
	const registeredAt = str(raw.registeredAt) ?? new Date().toISOString();
	return { token, platform, events, registeredAt };
}

function parseRegistry(raw: string): Map<string, PushDevice> {
	const parsed = JSON.parse(raw) as unknown;
	if (!Array.isArray(parsed)) throw new Error("expected a JSON array of devices");
	const devices = new Map<string, PushDevice>();
	for (const entry of parsed) {
		const device = parsePushDevice(entry);
		if (device !== undefined) devices.set(deviceKey(device), device);
	}
	return devices;
}

// The registry used to live under CLANKY_HOME with a ~/.config/clanky default
// while the rest of Clanky's data resolved to ~/.clanky. Copy (not move) a
// legacy file into the current home the first time it is missing there, so
// live registrations survive the path unification. COPYFILE_EXCL makes this a
// no-op once the current file exists.
async function migrateLegacyRegistry(path: string): Promise<void> {
	const legacyHome = process.env.CLANKY_HOME ?? join(homedir(), ".config", "clanky");
	const legacy = resolve(legacyHome, REGISTRY_FILENAME);
	if (legacy === path) return;
	try {
		await mkdir(dirname(path), { recursive: true });
		await copyFile(legacy, path, constants.COPYFILE_EXCL);
		console.error(`push registry migrated from ${legacy} to ${path}`);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		// ENOENT: no legacy file. EEXIST: current file already present.
		if (code !== "ENOENT" && code !== "EEXIST") {
			console.error(`push registry migration from ${legacy} failed:`, error);
		}
	}
}

async function load(): Promise<Map<string, PushDevice>> {
	const path = registryPath();
	if (cache !== undefined && cache.path === path) return cache.devices;
	await migrateLegacyRegistry(path);
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.error(`push registry read failed (${path}):`, error);
		}
		cache = { path, devices: new Map() };
		return cache.devices;
	}
	let devices: Map<string, PushDevice>;
	try {
		devices = parseRegistry(raw);
	} catch (error) {
		// Never silently reset live registrations: preserve the bytes, log
		// loudly, then start fresh.
		const backup = `${path}.corrupt-${new Date().toISOString().replaceAll(":", "-")}`;
		console.error(`push registry corrupt; backing up to ${backup} and starting fresh:`, error);
		try {
			await rename(path, backup);
		} catch (backupError) {
			console.error(`push registry corrupt-file backup failed (${backup}):`, backupError);
		}
		devices = new Map();
	}
	cache = { path, devices };
	return devices;
}

async function persist(map: Map<string, PushDevice>): Promise<void> {
	const path = registryPath();
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify([...map.values()], null, 2));
}

export async function registerPushDevice(device: Omit<PushDevice, "registeredAt">): Promise<void> {
	const map = await load();
	map.set(deviceKey(device), { ...device, registeredAt: new Date().toISOString() });
	await persist(map);
}

export async function unregisterPushDevice(token: string, platform?: PushPlatform): Promise<void> {
	const map = await load();
	if (platform !== undefined) {
		if (map.delete(deviceKey({ token, platform }))) await persist(map);
		return;
	}
	let changed = false;
	for (const [key, device] of map) {
		if (device.token !== token) continue;
		map.delete(key);
		changed = true;
	}
	if (changed) await persist(map);
}

export async function listPushDevices(): Promise<PushDevice[]> {
	return [...(await load()).values()];
}
