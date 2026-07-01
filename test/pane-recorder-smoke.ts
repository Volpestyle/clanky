// Offline smoke for the session-wide pane recorder store and history search
// (agent/lib/pane-recorder.ts, agent/lib/history-search.ts): chunk appends
// with split escapes, seed snapshots, segment rotation + archive pruning,
// head/tail/skip reads across archives, finalize, retention-sweep coverage,
// and search attribution across both capture planes.
// Run: node test/pane-recorder-smoke.ts
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchHerdrHistory } from "../agent/lib/history-search.ts";
import {
	appendRecordingChunk,
	createPaneRecording,
	finalizePaneRecording,
	findPaneRecording,
	listPaneRecordings,
	readPaneRecording,
	writeRecordingSeed,
} from "../agent/lib/pane-recorder.ts";
import { appendTranscriptChunk, createTranscriptRun, sweepTranscriptRetention } from "../agent/lib/transcripts.ts";

let failures = 0;
function check(label: string, ok: boolean): void {
	console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
	if (!ok) failures += 1;
}

async function main(): Promise<void> {
	const home = await mkdtemp(join(tmpdir(), "clanky-pane-recorder-"));
	const env = { ...process.env, CLANKY_HOME: home, HERDR_SESSION: "recorder-smoke" };
	try {
		const recording = await createPaneRecording(
			{ pane_id: "w1:p7", workspace_id: "w1", terminal_id: "term_smoke1", agent: "claude", label: "smoke" },
			{ env, budgets: { segmentRotateBytes: 4_096, recordingMaxBytes: 16_384 } },
		);

		// Escape split across chunk boundary: OSC title opener in one chunk, the
		// terminator + text in the next. stream.txt must contain only clean text.
		await appendRecordingChunk(recording, Buffer.from("line one\n\x1b]2;tit"));
		await appendRecordingChunk(recording, Buffer.from("le\x07line two\nline three\n"));
		const tail = await readPaneRecording("w1:p7", { lines: 2, env });
		check("tail read returns newest normalized lines", tail.text === "line two\nline three\n");
		check("tail read attributes the recording", tail.paneId === "w1:p7" && tail.source === "clanky-pane-recording");

		const head = await readPaneRecording("w1:p7", { lines: 1, anchor: "head", env });
		check("head read returns the first line", head.text === "line one\n");

		// Bare pane number resolves via suffix match.
		const bare = await readPaneRecording("p7", { lines: 1, env });
		check("bare pane id suffix-matches", bare.recordingId === recording.manifest.recordingId);

		// Rotation: push past segmentRotateBytes, then keep writing.
		for (let index = 0; index < 60; index++) {
			await appendRecordingChunk(recording, Buffer.from(`bulk line ${String(index).padStart(4, "0")} ${"x".repeat(90)}\n`));
		}
		await appendRecordingChunk(recording, Buffer.from("after rotation marker\n"));
		const names = await readdir(recording.dir);
		check(
			"rotation produced gzipped archives",
			names.some((name) => /^archive-\d{6}\.ansi\.gz$/.test(name)) &&
				names.some((name) => /^archive-\d{6}\.txt\.gz$/.test(name)),
		);

		// Cross-segment reads: head still reaches pre-rotation lines, tail the newest.
		const headAfter = await readPaneRecording("w1:p7", { lines: 1, anchor: "head", env });
		check("head read spans archives", headAfter.text === "line one\n");
		const tailAfter = await readPaneRecording("w1:p7", { lines: 1, env });
		check("tail read sees post-rotation line", tailAfter.text === "after rotation marker\n");
		const skipped = await readPaneRecording("w1:p7", { lines: 1, skip: 1, env });
		check("tail skip pages backward", skipped.text.startsWith("bulk line 0059"));
		const headSkip = await readPaneRecording("w1:p7", { lines: 1, anchor: "head", skip: 3, env });
		check("head skip pages forward", headSkip.text.startsWith("bulk line 0000"));

		// Seeds: a fresh recording with no streamed bytes serves its seed.
		const seeded = await createPaneRecording(
			{ pane_id: "w1:p9", terminal_id: "term_smoke2" },
			{ env },
		);
		await writeRecordingSeed(seeded, "seed alpha\nseed beta\n", "attach");
		const seedRead = await readPaneRecording("w1:p9", { lines: 1, env });
		check("seed-only recording serves seed tail", seedRead.text === "seed beta\n" && seedRead.seededOnly === true);

		await finalizePaneRecording(seeded, "pane_closed");
		const summaries = await listPaneRecordings(env);
		const seededSummary = summaries.find((summary) => summary.paneId === "w1:p9");
		check("finalize stamps endedAt", seededSummary?.endedAt !== undefined);
		const open = await findPaneRecording("w1:p7", { env });
		check("open recording still listed newest-first", open?.recordingId === recording.manifest.recordingId);

		// Search spans worker transcripts and pane recordings, incl. gz archives.
		const run = await createTranscriptRun({ agent: "clanky:worker", cwd: "/repo", argv: ["echo"], env });
		await appendTranscriptChunk(run, "stdout", Buffer.from("needle-in-worker\n"));
		await appendRecordingChunk(recording, Buffer.from("needle-in-pane\n"));
		const search = await searchHerdrHistory("needle-in-", { env, limit: 10 });
		const kinds = new Set(search.matches.map((match) => match.kind));
		check(`search finds both planes (engine: ${search.engine})`, kinds.has("worker") && kinds.has("pane"));
		const bulkSearch = await searchHerdrHistory("bulk line 0001", { env, limit: 5 });
		check("search reaches gzipped archives", bulkSearch.matches.length > 0);

		// Retention sweep counts recording dirs (flat files) without touching
		// fresh ones, and worker runs keep having no events.jsonl.
		const runFiles = await readdir(run.dir);
		check("worker runs still have no events.jsonl", !runFiles.includes("events.jsonl"));
		const deleted = await sweepTranscriptRetention(env, {
			minAgeMs: 60 * 60 * 1000,
			maxAgeMs: 30 * 24 * 60 * 60 * 1000,
			maxRuns: 10,
			maxTotalBytes: 10 * 1024 * 1024,
		});
		check("sweep leaves fresh recordings alone", deleted === 0);
		const survivors = await listPaneRecordings(env);
		check("recordings survive sweep", survivors.length === 2);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
	if (failures > 0) {
		console.error(`${failures} check(s) failed`);
		process.exit(1);
	}
}

await main();
