import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendTranscriptChunk,
	createTranscriptRun,
	finishTranscriptRun,
	lastLines,
	latestTranscriptRun,
	listTranscriptRuns,
	normalizeTerminalText,
	readTranscript,
	resolveTranscriptRunPath,
} from "../agent/lib/transcripts.ts";

function expectEqual(actual: unknown, expected: unknown, label: string): void {
	const actualJson = JSON.stringify(actual);
	const expectedJson = JSON.stringify(expected);
	if (actualJson !== expectedJson) throw new Error(`${label}: expected ${expectedJson}, got ${actualJson}`);
}

const home = await mkdtemp(join(tmpdir(), "clanky-transcript-registry-"));
const env = { ...process.env, CLANKY_HOME: home, HERDR_SESSION: "smoke-session" };

try {
	const run = await createTranscriptRun({
		agent: "clanky:alpha",
		cwd: "/repo",
		argv: ["printf", "ok"],
		runId: "run-1",
		env,
		now: new Date("2026-06-25T12:00:00.000Z"),
	});
	await appendTranscriptChunk(run, "stdout", Buffer.from("one\n"));
	await appendTranscriptChunk(run, "stdout", Buffer.from("\x1b[31mtwo\x1b[0m\r\nthree\n"));
	const finished = await finishTranscriptRun(run, {
		exitCode: 0,
		signal: null,
		now: new Date("2026-06-25T12:00:01.000Z"),
	});

	expectEqual(resolveTranscriptRunPath({ agent: "clanky:alpha", runId: "run-1", env }), run.dir, "run path resolves");
	expectEqual(finished.manifest.endedAt, "2026-06-25T12:00:01.000Z", "finish writes endedAt");
	expectEqual(await readFile(run.textPath, "utf8"), "one\ntwo\nthree\n", "text transcript strips ansi");
	expectEqual(lastLines("a\nb\nc\n", 2), "b\nc\n", "line trimming preserves trailing newline");
	expectEqual(normalizeTerminalText("ab\bC\x1b[2J\r\n"), "aC\n", "normalization handles controls");

	const read = await readTranscript("clanky:alpha", { lines: 2, env });
	expectEqual({ source: read.source, fallback: read.fallback, text: read.text, runId: read.runId }, {
		source: "clanky-transcript",
		fallback: false,
		text: "two\nthree\n",
		runId: "run-1",
	}, "read returns latest transcript lines");

	const latest = await latestTranscriptRun("clanky:alpha", { env });
	expectEqual(latest.manifest.runId, "run-1", "latest lookup finds agent run");

	const listed = await listTranscriptRuns(env);
	expectEqual(listed.map((item) => [item.agent, item.runId]), [["clanky:alpha", "run-1"]], "list returns transcript summary");
} finally {
	await rm(home, { recursive: true, force: true });
}

console.log("transcript-registry-smoke: ok");
