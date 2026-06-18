// Live smoke for the eve->herdr spawn seam. Requires running inside a herdr
// session (HERDR_ENV=1). Spawns a harmless bash pane (not a real agent),
// confirms the pane exists, then closes it.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import tool from "../agent/tools/herdr_spawn.ts";

const run = promisify(execFile);
const SLUG = "spawn-smoke";
const AGENT = `clanky:${SLUG}`;

// Best-effort pre-clean in case a prior run left it.
await closeAgentPane(AGENT);

let paneId: string | null = null;
let ok = false;
try {
	const res = (await tool.execute(
		{
			slug: SLUG,
			task: "Smoke task",
			performer: "claude",
			command: [
				"bash",
				"-lc",
				"printf '%s\\n' \"$1\" | grep -q 'skills/clanky-herdr-worker/SKILL.md'; echo SPAWN_OK; read line; echo GOT:$line; sleep 20",
				"bash",
				"{KICKOFF}",
			],
		},
		undefined as never,
	)) as { agent: string; paneId: string | null; started: boolean };
	paneId = res.paneId;
	console.log("spawn result:", JSON.stringify(res));

	const got = await run("herdr", ["agent", "get", AGENT], { encoding: "utf8" }).then((r) => r.stdout.trim());
	ok = got.includes(AGENT);
	console.log(ok ? "PANE VISIBLE OK" : "FAIL: pane not found");
} finally {
	if (paneId !== null) await run("herdr", ["pane", "close", paneId]).catch(() => {});
	await closeAgentPane(AGENT);
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
