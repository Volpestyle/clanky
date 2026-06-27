/**
 * Device-token registry for iOS push (SPEC §4.4). A phone registers its APNs
 * token over the relay after pairing; Clanky's push watcher reads this list to
 * decide who to notify. File-backed so registrations survive a brain restart.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface PushDevice {
	token: string;
	platform: string;
	/** Notify-worthy statuses, e.g. ["blocked","done"]. Empty = registry defaults. */
	events: string[];
	registeredAt: string;
}

function registryPath(): string {
	const home = process.env.CLANKY_HOME ?? join(homedir(), ".config", "clanky");
	return join(home, "push-tokens.json");
}

let cache: Map<string, PushDevice> | undefined;

async function load(): Promise<Map<string, PushDevice>> {
	if (cache) return cache;
	try {
		const raw = await readFile(registryPath(), "utf8");
		const list = JSON.parse(raw) as PushDevice[];
		cache = new Map(list.map((device) => [device.token, device]));
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
	map.set(device.token, { ...device, registeredAt: new Date().toISOString() });
	await persist(map);
}

export async function unregisterPushDevice(token: string): Promise<void> {
	const map = await load();
	if (map.delete(token)) await persist(map);
}

export async function listPushDevices(): Promise<PushDevice[]> {
	return [...(await load()).values()];
}
