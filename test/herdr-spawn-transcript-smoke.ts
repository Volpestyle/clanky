import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import readTool from "../agent/tools/herdr_read.ts";
import spawnTool from "../agent/tools/herdr_spawn.ts";

const run = promisify(execFile);
const agent = "clanky:spawn-transcript";
const home = await mkdtemp(join(tmpdir(), "clanky-herdr-spawn-transcript-"));
const originalHome = process.env.CLANKY_HOME;
process.env.CLANKY_HOME = home;

try {
	await closeAgentPane(agent);
	const result = (await spawnTool.execute(
		{
			slug: "spawn-transcript",
			task: "Transcript smoke task",
			harness: "custom",
			command: [
				"bash",
				"-lc",
				'printf "early\\n"; printf "\\033[2J\\033[Hafter-clear\\n"; printf "late\\n"; sleep 5',
			],
		},
		undefined as never,
	)) as { transcript?: { path?: string | null }; paneId?: string | null };

	const transcriptPath = result.transcript?.path;
	if (transcriptPath === undefined || transcriptPath === null) throw new Error("spawn result missing transcript path");
	const textPath = join(transcriptPath, "stream.txt");
	const text = await waitForText(textPath, "late", 10_000);
	for (const expected of ["early", "after-clear", "late"]) {
		if (!text.includes(expected)) throw new Error(`spawn transcript missing ${expected}: ${JSON.stringify(text)}`);
	}

	const auto = await readTool.execute({ agent, source: "auto", lines: 20 }, undefined as never);
	const autoText = (auto as { text?: unknown }).text;
	if (typeof autoText !== "string" || !autoText.includes("early") || !autoText.includes("late")) {
		throw new Error(`herdr_read auto did not return transcript text: ${JSON.stringify(auto)}`);
	}

	const visible = await readTool.execute({ agent, source: "visible", lines: 20 }, undefined as never);
	if (!JSON.stringify(visible).includes("late")) {
		throw new Error(`herdr_read visible did not return live Herdr text: ${JSON.stringify(visible)}`);
	}

	if (result.paneId !== null && result.paneId !== undefined) await run("herdr", ["pane", "close", result.paneId]).catch(() => {});
	await closeAgentPane(agent);
} finally {
	await closeAgentPane(agent);
	if (originalHome === undefined) delete process.env.CLANKY_HOME;
	else process.env.CLANKY_HOME = originalHome;
	await rm(home, { recursive: true, force: true });
}

console.log("herdr-spawn-transcript-smoke: ok");

async function waitForText(path: string, match: string, timeoutMs: number): Promise<string> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const text = await readFile(path, "utf8").catch(() => "");
		if (text.includes(match)) return text;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
	}
	throw new Error(`timed out waiting for ${match} in ${path}`);
}

async function closeAgentPane(target: string): Promise<void> {
	const paneId = await run("herdr", ["agent", "get", target], { encoding: "utf8" }).then(
		(result) => {
			const envelope = JSON.parse(result.stdout) as { result?: { agent?: { pane_id?: string } } };
			return envelope.result?.agent?.pane_id;
		},
		() => undefined,
	);
	if (paneId !== undefined) await run("herdr", ["pane", "close", paneId]).catch(() => {});
}
