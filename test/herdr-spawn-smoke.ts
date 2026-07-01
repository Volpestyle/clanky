// Live smoke for the eve->herdr spawn seam. Requires running inside a herdr
// session (HERDR_ENV=1). Spawns a harmless bash pane (not a real agent),
// confirms the pane exists, then closes it.
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import tool from "../agent/tools/herdr_spawn.ts";

const run = promisify(execFile);

const cases = [
	{
		slug: "spawn-smoke",
		task: "Smoke task",
		command:
			"set -e; printf '%s\\n' \"$1\" | grep -q 'skills/clanky-herdr-worker/SKILL.md'; printf '%s\\n' \"$1\" | grep -q 'Do not load Clanky coding skill package paths'; ! printf '%s\\n' \"$1\" | grep -q 'skills/clanky-coding-worker/SKILL.md'; ! printf '%s\\n' \"$1\" | grep -q 'skills/clanky-coding-reviewer/SKILL.md'; echo SPAWN_OK; read line; echo GOT:$line; sleep 20",
	},
	{
		slug: "spawn-smoke-opencode-custom",
		task: "OpenCode custom smoke task",
		command:
			"set -e; printf '%s\\n' \"$1\" | grep -q 'skills/clanky-herdr-worker/SKILL.md'; ! printf '%s\\n' \"$1\" | grep -q 'skills/clanky-coding-worker/SKILL.md'; ! printf '%s\\n' \"$1\" | grep -q 'skills/clanky-coding-reviewer/SKILL.md'; echo SPAWN_OK; read line; echo GOT:$line; sleep 20",
	},
];

let ok = false;
const home = await mkdtemp(join(tmpdir(), "clanky-herdr-spawn-smoke-"));
const originalHome = process.env.CLANKY_HOME;
process.env.CLANKY_HOME = home;
try {
	for (const item of cases) {
		const agent = `clanky:${item.slug}`;
		await closeAgentPane(agent);
		let paneId: string | null = null;
		try {
			const res = (await tool.execute(
				{
					slug: item.slug,
					task: item.task,
					harness: "custom",
					command: ["bash", "-lc", item.command, "bash", "{KICKOFF}"],
					// The smoke pane closes seconds after spawn; do not arm a
					// completion watcher that would wake the real lead pane.
					watch: false,
				},
				undefined as never,
			)) as { agent: string; paneId: string | null; started: boolean };
			paneId = res.paneId;
			console.log("spawn result:", JSON.stringify(res));

			const got = await run("herdr", ["agent", "get", agent], { encoding: "utf8" }).then((r) => r.stdout.trim());
			if (!got.includes(agent)) {
				console.log(`FAIL: pane not found for ${agent}`);
				ok = false;
				break;
			}
			ok = true;
			console.log(`PANE VISIBLE OK ${agent}`);
		} finally {
			if (paneId !== null) await run("herdr", ["pane", "close", paneId]).catch(() => {});
			await closeAgentPane(agent);
		}
	}
} finally {
	for (const item of cases) await closeAgentPane(`clanky:${item.slug}`);
	if (originalHome === undefined) delete process.env.CLANKY_HOME;
	else process.env.CLANKY_HOME = originalHome;
	await rm(home, { recursive: true, force: true });
}

process.exit(ok ? 0 : 1);

async function closeAgentPane(agent: string): Promise<void> {
	const paneId = await run("herdr", ["agent", "get", agent], { encoding: "utf8" }).then(
		(result) => {
			const envelope = JSON.parse(result.stdout) as { result?: { agent?: { pane_id?: string } } };
			return envelope.result?.agent?.pane_id;
		},
		() => undefined,
	);
	if (paneId !== undefined) await run("herdr", ["pane", "close", paneId]).catch(() => {});
}
