/**
 * Device-token registry for mobile push (SPEC §4.4). Clients register an APNs
 * or FCM token over the relay after pairing; Clanky's push watcher reads this
 * list to decide who to notify. File-backed so registrations survive a brain
 * restart.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type PushPlatform = "ios" | "android";

export interface PushDevice {
	token: string;
	platform: PushPlatform;
	/** Notify-worthy statuses, e.g. ["blocked","done"]. Empty = registry defaults. */
	events: string[];
	registeredAt: string;
}

function registryPath(): string {
	const home = process.env.CLANKY_HOME ?? join(homedir(), ".config", "clanky");
	return join(home, "push-tokens.json");
}

let cache: Map<string, PushDevice> | undefined;

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

async function load(): Promise<Map<string, PushDevice>> {
	if (cache) return cache;
	try {
		const raw = await readFile(registryPath(), "utf8");
		const parsed = JSON.parse(raw) as unknown;
		const list = Array.isArray(parsed) ? parsed : [];
		cache = new Map();
		for (const entry of list) {
			const device = parsePushDevice(entry);
			if (device !== undefined) cache.set(deviceKey(device), device);
		}
	} catch {
		cache = new Map();
	}
	return cache;
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
