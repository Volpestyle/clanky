import { mkdtemp, appendFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	startTranscriptFileTail,
	type TranscriptFileTail,
} from "../agent/lib/transcript-file-tail.ts";
import type { TranscriptRun, TranscriptStream } from "../agent/lib/transcripts.ts";

const WAIT_TIMEOUT_MS = 1_000;

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function testRun(dir: string): TranscriptRun {
	return {
		ansiPath: join(dir, "stream.ansi"),
		dir,
		eventsPath: join(dir, "events.ndjson"),
		manifest: {
			agent: "tail-smoke",
			argv: ["bash", "-lc", "printf ok"],
			cwd: dir,
			runId: "tail-smoke-run",
			session: "tail-smoke-session",
			startedAt: new Date(0).toISOString(),
			version: 1,
		},
		manifestPath: join(dir, "manifest.json"),
		pending: { stderr: "", stdout: "" },
		textPath: join(dir, "stream.txt"),
	};
}

async function waitForText(read: () => string, expected: string): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < WAIT_TIMEOUT_MS) {
		if (read() === expected) return;
		await sleep(10);
	}
	throw new Error(`timed out waiting for ${JSON.stringify(expected)}; got ${JSON.stringify(read())}`);
}

async function withTail(
	dir: string,
	file: string,
	captured: Buffer[],
	run: (tail: TranscriptFileTail) => Promise<void>,
): Promise<void> {
	const tail = await startTranscriptFileTail(testRun(dir), file, {
		appendChunk: async (_run: TranscriptRun, stream: TranscriptStream, chunk: Buffer | Uint8Array): Promise<void> => {
			assert(stream === "stdout", "script transcript tail should record stdout chunks");
			captured.push(Buffer.from(chunk));
		},
		debounceMs: 5,
	});
	await run(tail);
	const error = await tail.stop();
	assert(error === undefined, `tail stop should not report an error: ${error?.message}`);
}

const dir = await mkdtemp(join(tmpdir(), "clanky-tail-"));
try {
	const watchedFile = join(dir, "stream.script.ansi");
	const watchedChunks: Buffer[] = [];
	await writeFile(watchedFile, "");
	await withTail(dir, watchedFile, watchedChunks, async (tail) => {
		await appendFile(watchedFile, "hello");
		await waitForText(() => Buffer.concat(watchedChunks).toString("utf8"), "hello");
		await appendFile(watchedFile, " world");
		await waitForText(() => Buffer.concat(watchedChunks).toString("utf8"), "hello world");
		const stats = tail.stats();
		assert(stats.bytes === "hello world".length, `tail should count captured bytes; got ${stats.bytes}`);
		assert(stats.chunks >= 1, `tail should capture at least one chunk; got ${stats.chunks}`);
		assert(stats.flushes >= 1, `tail should flush at least once; got ${stats.flushes}`);
	});

	const finalFlushFile = join(dir, "stream-final.script.ansi");
	const finalChunks: Buffer[] = [];
	await writeFile(finalFlushFile, "");
	await withTail(dir, finalFlushFile, finalChunks, async () => {
		await appendFile(finalFlushFile, "final");
	});
	assert(Buffer.concat(finalChunks).toString("utf8") === "final", "tail stop should flush bytes even when no watch callback has fired");

	console.log("transcript-file-tail-smoke: ok");
} finally {
	await rm(dir, { force: true, recursive: true });
}
