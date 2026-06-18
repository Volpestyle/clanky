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
await run("herdr", ["agent", "close", AGENT]).catch(() => {});

const res = (await tool.execute(
	{ slug: SLUG, task: "echo SPAWN_OK; sleep 20", performer: "claude", command: ["bash", "-lc", "{KICKOFF}"] },
	undefined as never,
)) as { agent: string; paneId: string; started: boolean };
console.log("spawn result:", JSON.stringify(res));

const got = await run("herdr", ["agent", "get", AGENT], { encoding: "utf8" }).then((r) => r.stdout.trim());
const ok = got.includes(AGENT);
console.log(ok ? "PANE VISIBLE OK" : "FAIL: pane not found");

await run("herdr", ["agent", "close", AGENT]).catch(() => {});
process.exit(ok ? 0 : 1);
