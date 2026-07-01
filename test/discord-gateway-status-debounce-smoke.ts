// Offline smoke for the debounced gateway status writes: hot-path schedules
// coalesce to one trailing write, an immediate write cancels stale pending
// snapshots, and releasing the lock drops pending writes without crashing.
// Run: node test/discord-gateway-status-debounce-smoke.ts
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type DiscordGatewayStatusInput,
	acquireDiscordGatewayLock,
	flushDiscordGatewayStatusWrites,
	readDiscordGatewayStatus,
	releaseDiscordGatewayLock,
	scheduleDiscordGatewayStatusWrite,
	writeDiscordGatewayStatus,
} from "../agent/lib/discord/gateway-status.ts";

let failures = 0;
function check(label: string, ok: boolean): void {
	console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
	if (!ok) failures += 1;
}

function status(overrides: Partial<DiscordGatewayStatusInput>): DiscordGatewayStatusInput {
	return {
		state: "ready",
		ready: true,
		credentialKind: "bot-token",
		voice: false,
		sessions: [],
		...overrides,
	};
}

const repo = await mkdtemp(join(tmpdir(), "clanky-discord-gateway-debounce-"));
const env: NodeJS.ProcessEnv = { CLANKY_REPO_DIR: repo, DISCORD_BOT_TOKEN: "test-token" };
const writeOptions = { env, startedAt: "2026-07-01T00:00:00.000Z" };
const session = (channelId: string) => ({
	channelId,
	sessionId: `wrun_${channelId}`,
	kind: "channel" as const,
	updatedAt: "2026-07-01T00:00:01.000Z",
	authorId: "u1",
});

const lock = acquireDiscordGatewayLock(env);
try {
	writeDiscordGatewayStatus(lock, status({ state: "starting", ready: false }), writeOptions);
	check("immediate write lands synchronously", readDiscordGatewayStatus(lock)?.state === "starting");

	// Two hot-path schedules coalesce; nothing hits disk until flush.
	scheduleDiscordGatewayStatusWrite(lock, status({ sessions: [session("c1")] }), writeOptions);
	scheduleDiscordGatewayStatusWrite(lock, status({ sessions: [session("c1"), session("c2")] }), writeOptions);
	check("scheduled writes do not land before the debounce", readDiscordGatewayStatus(lock)?.state === "starting");
	flushDiscordGatewayStatusWrites();
	const flushed = readDiscordGatewayStatus(lock);
	check("flush lands the newest coalesced snapshot", flushed?.state === "ready" && flushed.sessions.length === 2);
	flushDiscordGatewayStatusWrites();
	check("flush is idempotent", readDiscordGatewayStatus(lock)?.sessions.length === 2);

	// An immediate state-transition write supersedes an older pending snapshot.
	scheduleDiscordGatewayStatusWrite(lock, status({ sessions: [session("stale")] }), writeOptions);
	writeDiscordGatewayStatus(lock, status({ state: "failed", ready: false, error: "boom", sessions: [] }), writeOptions);
	flushDiscordGatewayStatusWrites();
	const superseded = readDiscordGatewayStatus(lock);
	check(
		"immediate write cancels the stale pending snapshot",
		superseded?.state === "failed" && superseded.error === "boom" && superseded.sessions.length === 0,
	);
} finally {
	// Release with a pending write: it must be dropped, not crash later.
	scheduleDiscordGatewayStatusWrite(lock, status({ sessions: [session("late")] }), writeOptions);
	releaseDiscordGatewayLock(lock);
}
flushDiscordGatewayStatusWrites();
check("release drops pending writes and the lock directory", lock.status === "acquired" && !existsSync(lock.path));

console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
