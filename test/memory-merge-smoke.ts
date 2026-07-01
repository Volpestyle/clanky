// Offline smoke for cross-process memory write safety and importance-aware
// eviction (agent/lib/memory.ts). Two child Node processes hammer
// rememberMemory concurrently against the same temp CLANKY_HOME; without the
// advisory file lock the interleaved read-modify-write cycles lose facts.
// Run: node test/memory-merge-smoke.ts
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readMemories, rememberMemory, type MemoryFact } from "../agent/lib/memory.ts";

const run = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(label: string, ok: boolean): void {
	console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
	if (!ok) failures += 1;
}

const WRITES_PER_CHILD = 20;

function syntheticFact(index: number, importance: number, updatedAt: string): MemoryFact {
	return {
		id: `seed-${index}`,
		subjectKind: "other",
		fact: `seed fact ${index}`,
		tags: [],
		importance,
		createdAt: updatedAt,
		updatedAt,
	};
}

async function main(): Promise<void> {
	const home = await mkdtemp(join(tmpdir(), "clanky-memory-merge-"));
	const env = { ...process.env, CLANKY_HOME: home };
	try {
		// --- two concurrent writer processes -------------------------------------
		const writerScript = join(home, "writer.ts");
		await writeFile(
			writerScript,
			[
				`import { rememberMemory } from ${JSON.stringify(join(repo, "agent/lib/memory.ts"))};`,
				"const writer = process.argv[2];",
				"const count = Number(process.argv[3]);",
				"for (let index = 0; index < count; index += 1) {",
				'\tawait rememberMemory({ subjectKind: "other", fact: `fact ${writer} ${index}` });',
				"}",
				"",
			].join("\n"),
		);
		await Promise.all([
			run(process.execPath, [writerScript, "alpha", String(WRITES_PER_CHILD)], { env }),
			run(process.execPath, [writerScript, "beta", String(WRITES_PER_CHILD)], { env }),
		]);
		const merged = await readMemories(env);
		const facts = new Set(merged.map((memory) => memory.fact));
		let missing = 0;
		for (let index = 0; index < WRITES_PER_CHILD; index += 1) {
			if (!facts.has(`fact alpha ${index}`)) missing += 1;
			if (!facts.has(`fact beta ${index}`)) missing += 1;
		}
		check(`no facts lost across two concurrent writer processes (missing=${missing})`, missing === 0);
		check("merged store holds both writers' facts", merged.length === 2 * WRITES_PER_CHILD);
		check("no leftover lock after writers exit", !(await pathExists(join(home, "memory/facts.json.lock"))));

		// --- stale lock is stolen, not waited on forever --------------------------
		const originalHome = process.env.CLANKY_HOME;
		process.env.CLANKY_HOME = home;
		try {
			const lockDir = join(home, "memory/facts.json.lock");
			await mkdir(lockDir, { recursive: true });
			const stale = new Date(Date.now() - 60_000);
			await utimes(lockDir, stale, stale);
			const written = await rememberMemory({ subjectKind: "other", fact: "written past a stale lock" });
			check("stale lock is stolen and the write lands", written.fact === "written past a stale lock");

			// --- importance-aware eviction ---------------------------------------
			const base = new Date("2026-01-01T00:00:00.000Z").getTime();
			const seeds: MemoryFact[] = [];
			// One old but important fact, then enough low-importance filler to
			// overflow the 5000-fact cap once one more fact is remembered.
			seeds.push(syntheticFact(0, 5, new Date(base).toISOString()));
			for (let index = 1; index < 5000; index += 1) {
				seeds.push(syntheticFact(index, 1, new Date(base + index * 1000).toISOString()));
			}
			await writeFile(join(home, "memory/facts.json"), `${JSON.stringify(seeds)}\n`);
			await rememberMemory({ subjectKind: "other", fact: "newest fact", importance: 3 });
			const evicted = await readMemories(env);
			const ids = new Set(evicted.map((memory) => memory.id));
			check("store is capped at the max fact count", evicted.length === 5000);
			check("old high-importance fact survives eviction", ids.has("seed-0"));
			check("oldest low-importance fact is evicted", !ids.has("seed-1"));
			check("new fact lands despite the cap", evicted.some((memory) => memory.fact === "newest fact"));
		} finally {
			if (originalHome === undefined) delete process.env.CLANKY_HOME;
			else process.env.CLANKY_HOME = originalHome;
		}
	} finally {
		await rm(home, { recursive: true, force: true });
	}

	console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
	process.exit(failures === 0 ? 0 : 1);
}

async function pathExists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

void main();
