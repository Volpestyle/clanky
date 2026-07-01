import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendTranscriptChunk, createTranscriptRun } from "../agent/lib/transcripts.ts";
import tool from "../agent/tools/herdr_read.ts";

function expectEqual(actual: unknown, expected: unknown, label: string): void {
	const actualJson = JSON.stringify(actual);
	const expectedJson = JSON.stringify(expected);
	if (actualJson !== expectedJson) throw new Error(`${label}: expected ${expectedJson}, got ${actualJson}`);
}

const home = await mkdtemp(join(tmpdir(), "clanky-herdr-read-transcript-"));
const originalHome = process.env.CLANKY_HOME;
const originalSession = process.env.HERDR_SESSION;
process.env.CLANKY_HOME = home;
process.env.HERDR_SESSION = "read-smoke";

try {
	const run = await createTranscriptRun({
		agent: "clanky:reader",
		cwd: "/repo",
		argv: ["echo", "ok"],
		runId: "run-1",
	});
	await appendTranscriptChunk(run, "stdout", Buffer.from("alpha\nbeta\n"));

	const explicit = await tool.execute(
		{ agent: "clanky:reader", source: "transcript", lines: 1, anchor: "tail", skip: 0 },
		undefined as never,
	);
	expectEqual(
		{ source: (explicit as { source?: unknown }).source, text: (explicit as { text?: unknown }).text },
		{ source: "clanky-transcript", text: "beta\n" },
		"explicit transcript read returns durable text",
	);

	const auto = await tool.execute({ agent: "clanky:reader", source: "auto", lines: 2, anchor: "tail", skip: 0 }, undefined as never);
	expectEqual(
		{ source: (auto as { source?: unknown }).source, fallback: (auto as { fallback?: unknown }).fallback },
		{ source: "clanky-transcript", fallback: false },
		"auto read prefers transcript",
	);
} finally {
	if (originalHome === undefined) delete process.env.CLANKY_HOME;
	else process.env.CLANKY_HOME = originalHome;
	if (originalSession === undefined) delete process.env.HERDR_SESSION;
	else process.env.HERDR_SESSION = originalSession;
	await rm(home, { recursive: true, force: true });
}

console.log("herdr-read-transcript-smoke: ok");
