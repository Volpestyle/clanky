// Offline smoke for transcript retention and bounded tail reads
// (agent/lib/transcripts.ts). Uses a temp CLANKY_HOME; backdates file mtimes
// with utimes to simulate idle runs. Run: node test/transcript-retention-smoke.ts
import { mkdtemp, readdir, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendTranscriptChunk,
	createTranscriptRun,
	readTranscript,
	sweepTranscriptRetention,
	type TranscriptRetentionBudget,
	type TranscriptRun,
} from "../agent/lib/transcripts.ts";

let failures = 0;
function check(label: string, ok: boolean): void {
	console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
	if (!ok) failures += 1;
}

async function backdateRun(run: TranscriptRun, at: Date): Promise<void> {
	for (const name of await readdir(run.dir)) {
		await utimes(join(run.dir, name), at, at);
	}
}

async function dirExists(path: string): Promise<boolean> {
	return await stat(path).then(
		(info) => info.isDirectory(),
		() => false,
	);
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
	const home = await mkdtemp(join(tmpdir(), "clanky-transcript-retention-"));
	const env = { ...process.env, CLANKY_HOME: home, HERDR_SESSION: "retention-smoke" };
	try {
		const budget: TranscriptRetentionBudget = {
			minAgeMs: 60 * 60 * 1000,
			maxAgeMs: 30 * DAY_MS,
			maxRuns: 3,
			maxTotalBytes: 10_000,
		};
		const now = Date.now();

		// A run only ever written through createTranscriptRun has no events.jsonl.
		const fresh = await createTranscriptRun({ agent: "clanky:fresh", cwd: "/repo", argv: ["x"], runId: "run-1", env });
		await appendTranscriptChunk(fresh, "stdout", Buffer.from("alive\n"));
		const freshFiles = (await readdir(fresh.dir)).sort();
		check("run dir holds only manifest + ansi + txt", freshFiles.join("|") === "manifest.json|stream.ansi|stream.txt");

		// Ancient run: idle far past maxAgeMs.
		const ancient = await createTranscriptRun({ agent: "clanky:old", cwd: "/repo", argv: ["x"], runId: "run-old", env });
		await appendTranscriptChunk(ancient, "stdout", Buffer.from("old\n"));
		await backdateRun(ancient, new Date(now - 45 * DAY_MS));

		// Mid-age runs inside maxAgeMs; enough of them to exceed maxRuns.
		const midRuns: TranscriptRun[] = [];
		for (let index = 0; index < 4; index += 1) {
			const run = await createTranscriptRun({
				agent: "clanky:mid",
				cwd: "/repo",
				argv: ["x"],
				runId: `run-${index}`,
				env,
			});
			await appendTranscriptChunk(run, "stdout", Buffer.from(`mid ${index}\n`));
			// Older index = older activity, all safely past minAgeMs.
			await backdateRun(run, new Date(now - (10 - index) * DAY_MS));
			midRuns.push(run);
		}

		const midDirs = midRuns.map((run) => run.dir);
		const deleted = await sweepTranscriptRetention(env, budget, now);
		check("sweep deletes over-age and over-count runs", deleted === 3);
		check("ancient run is deleted by age", !(await dirExists(ancient.dir)));
		check("oldest mid run is deleted by run budget", !(await dirExists(midDirs[0] ?? "")));
		check("second-oldest mid run is deleted by run budget", !(await dirExists(midDirs[1] ?? "")));
		check("newest mid runs survive", (await dirExists(midDirs[2] ?? "")) && (await dirExists(midDirs[3] ?? "")));
		check("fresh (min-age) run always survives", await dirExists(fresh.dir));
		check("emptied agent dir is pruned", !(await dirExists(join(home, "herdr-transcripts", "retention-smoke", "clanky:old"))));

		// Byte budget: one idle run bigger than the whole budget is dropped even
		// though the run count is fine.
		const big = await createTranscriptRun({ agent: "clanky:big", cwd: "/repo", argv: ["x"], runId: "run-big", env });
		await appendTranscriptChunk(big, "stdout", Buffer.from("x".repeat(50_000)));
		await backdateRun(big, new Date(now - 2 * DAY_MS));
		const deletedBig = await sweepTranscriptRetention(env, budget, now);
		check("sweep deletes an idle run that busts the byte budget", deletedBig >= 1 && !(await dirExists(big.dir)));

		// Bounded tail read: a large transcript reads back only the requested tail
		// without loading it whole, and lines are complete.
		const tailRun = await createTranscriptRun({ agent: "clanky:tail", cwd: "/repo", argv: ["x"], runId: "run-tail", env });
		const lineCount = 200_000; // ~1.4 MB of text, larger than the read window
		const bigText = Array.from({ length: lineCount }, (_, index) => `line-${index}`).join("\n");
		await appendTranscriptChunk(tailRun, "stdout", Buffer.from(`${bigText}\n`));
		const read = await readTranscript("clanky:tail", { lines: 3, env });
		check(
			"tail read returns the last lines of a large transcript",
			read.text === `line-${lineCount - 3}\nline-${lineCount - 2}\nline-${lineCount - 1}\n`,
		);
		const readWide = await readTranscript("clanky:tail", { lines: 500, env });
		const wideLines = readWide.text.replace(/\n$/, "").split("\n");
		check("wide tail read returns exactly the requested line count", wideLines.length === 500);
		check("wide tail read first line is complete", /^line-\d+$/.test(wideLines[0] ?? ""));
		check("wide tail read ends at the newest line", wideLines.at(-1) === `line-${lineCount - 1}`);
	} finally {
		await rm(home, { recursive: true, force: true });
	}

	console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
	process.exit(failures === 0 ? 0 : 1);
}

void main();
