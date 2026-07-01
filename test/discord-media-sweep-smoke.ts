// Offline smoke for the Discord media retention sweep
// (agent/lib/discord/media.ts, via __discordMediaTestHooks). Runs entirely in
// a temp dir; no live data is touched. Run: node test/discord-media-sweep-smoke.ts
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __discordMediaTestHooks } from "../agent/lib/discord/media.ts";

let failures = 0;
function check(label: string, ok: boolean): void {
	console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
	if (!ok) failures += 1;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

async function writeAgedFile(dir: string, name: string, bytes: number, ageMs: number, now: number): Promise<string> {
	const path = join(dir, name);
	await writeFile(path, Buffer.alloc(bytes, 0x61));
	const at = new Date(now - ageMs);
	await utimes(path, at, at);
	return path;
}

async function main(): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "clanky-media-sweep-"));
	try {
		const now = Date.now();
		const budget = { minAgeMs: HOUR_MS, maxAgeMs: 30 * DAY_MS, maxTotalBytes: 1_000 };

		await writeAgedFile(dir, "ancient.png", 100, 45 * DAY_MS, now);
		await writeAgedFile(dir, "big-old.png", 900, 10 * DAY_MS, now);
		await writeAgedFile(dir, "mid.png", 600, 5 * DAY_MS, now);
		await writeAgedFile(dir, "newer.png", 300, 2 * DAY_MS, now);
		await writeAgedFile(dir, "fresh.png", 50, 10 * 60 * 1000, now);

		const result = await __discordMediaTestHooks.sweepDiscordMediaDir(dir, budget, now);
		const remaining = (await readdir(dir)).sort();
		// Newest-first accounting: fresh (50) + newer (300) + mid (600) fit the
		// 1000-byte budget; big-old busts it and ancient is over max age.
		check("sweep keeps files inside the byte budget", remaining.join("|") === "fresh.png|mid.png|newer.png");
		check("sweep reports deleted file count", result.deletedFiles === 2);
		check("sweep reports deleted byte count", result.deletedBytes === 1_000);

		const again = await __discordMediaTestHooks.sweepDiscordMediaDir(dir, budget, now);
		check("sweep is idempotent", again.deletedFiles === 0 && (await readdir(dir)).length === 3);

		// Min-age guard: a fresh download over the whole budget is never deleted.
		const youngDir = await mkdtemp(join(tmpdir(), "clanky-media-sweep-young-"));
		try {
			await writeAgedFile(youngDir, "young-big.png", 5_000, 10 * 60 * 1000, now);
			const young = await __discordMediaTestHooks.sweepDiscordMediaDir(youngDir, budget, now);
			check("min-age file survives even over the byte budget", young.deletedFiles === 0 && (await readdir(youngDir)).length === 1);
		} finally {
			await rm(youngDir, { recursive: true, force: true });
		}

		const missing = await __discordMediaTestHooks.sweepDiscordMediaDir(join(dir, "does-not-exist"), budget, now);
		check("sweep of a missing dir is a no-op", missing.deletedFiles === 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}

	console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
	process.exit(failures === 0 ? 0 : 1);
}

void main();
