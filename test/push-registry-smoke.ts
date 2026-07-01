/**
 * Offline smoke for agent/lib/push-registry.ts under temp homes: fresh read,
 * legacy ~/.config/clanky migration, and corrupt-file backup. HOME is
 * overridden to a temp dir for the migration scenario so the real user
 * directories are never touched (os.homedir() reads $HOME per call).
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPushDevices, registerPushDevice, unregisterPushDevice } from "../agent/lib/push-registry.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const originalHome = process.env.HOME;
const originalClankyHome = process.env.CLANKY_HOME;
const roots: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

try {
	// Scenario 1: fresh read — no file anywhere, then a registration persists
	// under CLANKY_HOME.
	const freshHome = await tempRoot("clanky-push-fresh-");
	process.env.CLANKY_HOME = freshHome;
	assert((await listPushDevices()).length === 0, "fresh registry should be empty");
	await registerPushDevice({ token: "fresh-token", platform: "ios", events: [] });
	const freshRaw = JSON.parse(await readFile(join(freshHome, "push-tokens.json"), "utf8")) as unknown;
	assert(Array.isArray(freshRaw) && freshRaw.length === 1, "registration should persist to CLANKY_HOME/push-tokens.json");
	assert((await listPushDevices())[0]?.token === "fresh-token", "fresh registration should round-trip");

	// Scenario 2: legacy migration — CLANKY_HOME unset, a registry exists only
	// at the old default ~/.config/clanky; first read copies it to ~/.clanky.
	const fakeUserHome = await tempRoot("clanky-push-home-");
	delete process.env.CLANKY_HOME;
	process.env.HOME = fakeUserHome;
	const legacyDir = join(fakeUserHome, ".config", "clanky");
	await mkdir(legacyDir, { recursive: true });
	const legacyDevice = { token: "legacy-token", platform: "android", events: ["done"], registeredAt: "2026-01-01T00:00:00.000Z" };
	await writeFile(join(legacyDir, "push-tokens.json"), JSON.stringify([legacyDevice], null, 2));
	const migrated = await listPushDevices();
	assert(migrated.length === 1 && migrated[0]?.token === "legacy-token", "legacy registrations should survive the home unification");
	assert(migrated[0]?.platform === "android" && migrated[0]?.events[0] === "done", "legacy device fields should migrate intact");
	const migratedRaw = JSON.parse(await readFile(join(fakeUserHome, ".clanky", "push-tokens.json"), "utf8")) as unknown;
	assert(Array.isArray(migratedRaw) && migratedRaw.length === 1, "legacy file should be copied to the new resolved path");
	const legacyRaw = JSON.parse(await readFile(join(legacyDir, "push-tokens.json"), "utf8")) as unknown;
	assert(Array.isArray(legacyRaw) && legacyRaw.length === 1, "migration copies; the legacy file is left in place");
	// Writes go to the new path only.
	await unregisterPushDevice("legacy-token", "android");
	assert((await listPushDevices()).length === 0, "unregister after migration should apply");
	const legacyAfter = JSON.parse(await readFile(join(legacyDir, "push-tokens.json"), "utf8")) as unknown;
	assert(Array.isArray(legacyAfter) && legacyAfter.length === 1, "legacy file must stay untouched by later writes");
	process.env.HOME = originalHome;

	// Scenario 2b: an existing file at the new path wins over a legacy file.
	const bothHome = await tempRoot("clanky-push-both-");
	delete process.env.CLANKY_HOME;
	process.env.HOME = bothHome;
	await mkdir(join(bothHome, ".config", "clanky"), { recursive: true });
	await writeFile(join(bothHome, ".config", "clanky", "push-tokens.json"), JSON.stringify([{ token: "old", platform: "ios", events: [] }]));
	await mkdir(join(bothHome, ".clanky"), { recursive: true });
	await writeFile(join(bothHome, ".clanky", "push-tokens.json"), JSON.stringify([{ token: "new", platform: "ios", events: [] }]));
	const both = await listPushDevices();
	assert(both.length === 1 && both[0]?.token === "new", "an existing current-path registry must not be clobbered by migration");
	process.env.HOME = originalHome;

	// Scenario 3: corrupt file — backed up (not silently reset), then fresh.
	const corruptHome = await tempRoot("clanky-push-corrupt-");
	process.env.CLANKY_HOME = corruptHome;
	await writeFile(join(corruptHome, "push-tokens.json"), "{not json[[[");
	assert((await listPushDevices()).length === 0, "corrupt registry should read as empty");
	const entries = await readdir(corruptHome);
	const backup = entries.find((name) => name.startsWith("push-tokens.json.corrupt-"));
	assert(backup !== undefined, "corrupt registry should be backed up as push-tokens.json.corrupt-<timestamp>");
	assert(!entries.includes("push-tokens.json"), "corrupt file should be moved aside, not reparsed forever");
	assert((await readFile(join(corruptHome, backup), "utf8")) === "{not json[[[", "backup should preserve the corrupt bytes");
	await registerPushDevice({ token: "recovered", platform: "ios", events: [] });
	assert((await listPushDevices())[0]?.token === "recovered", "registry should accept registrations after corrupt recovery");

	// Non-array but valid JSON also counts as corrupt.
	const nonArrayHome = await tempRoot("clanky-push-nonarray-");
	process.env.CLANKY_HOME = nonArrayHome;
	await writeFile(join(nonArrayHome, "push-tokens.json"), JSON.stringify({ token: "not-a-list" }));
	assert((await listPushDevices()).length === 0, "non-array registry should read as empty");
	const nonArrayEntries = await readdir(nonArrayHome);
	assert(nonArrayEntries.some((name) => name.startsWith("push-tokens.json.corrupt-")), "non-array registry should be backed up");

	console.log("push registry smoke OK");
} finally {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalClankyHome === undefined) delete process.env.CLANKY_HOME;
	else process.env.CLANKY_HOME = originalClankyHome;
	for (const root of roots) await rm(root, { recursive: true, force: true });
}
