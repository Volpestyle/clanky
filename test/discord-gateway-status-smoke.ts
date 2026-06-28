import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acquireDiscordGatewayLock,
	discordGatewaySessionStatusFromMessage,
	discordGatewayToolStatus,
	releaseDiscordGatewayLock,
	resolveDiscordGatewayHealth,
	writeDiscordGatewayStatus,
} from "../agent/lib/discord/gateway-status.ts";

let failures = 0;
function check(label: string, ok: boolean): void {
	console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
	if (!ok) failures += 1;
}

const repo = await mkdtemp(join(tmpdir(), "clanky-discord-gateway-status-"));
const env: NodeJS.ProcessEnv = {
	CLANKY_REPO_DIR: repo,
	CLANKY_DISCORD_PRESENCE: "1",
	DISCORD_BOT_TOKEN: "test-token",
	CLANKY_DISCORD_CREDENTIAL_KIND: "user-token",
	CLANKY_DISCORD_VOICE: "1",
	CLANKY_DISCORD_ALLOWED_GUILD_IDS: "g1 g2",
	CLANKY_DISCORD_ALLOWED_CHANNEL_IDS: "c1",
	CLANKY_DISCORD_ALLOW_DMS: "off",
};

const lock = acquireDiscordGatewayLock(env);
try {
	const session = discordGatewaySessionStatusFromMessage(
		{
			externalMessageId: "m1",
			channelId: "dm1",
			authorId: "u1",
			authorName: "vuhlp",
			text: "clanka",
			kind: "dm",
			mentionsSelf: false,
		},
		"wrun_1",
		"2026-06-28T20:27:01.000Z",
	);
	writeDiscordGatewayStatus(
		lock,
		{
			state: "ready",
			ready: true,
			credentialKind: "user-token",
			voice: true,
			sessions: [session],
		},
		{ env, startedAt: "2026-06-28T20:00:00.000Z" },
	);

	const health = resolveDiscordGatewayHealth({ env, lock, hostPresent: true, hostReady: true, startError: null });
	check("health reports running gateway", health.running && health.ready === true && health.owner === "this-context");
	check("health preserves session metadata", health.status?.sessions[0]?.authorName === "vuhlp");
	check("health preserves scope", health.status?.scope.allowDms === false && health.status.scope.allowedChannelIds?.[0] === "c1");

	const toolStatus = discordGatewayToolStatus(env);
	check("tool reports active session count", toolStatus.activeSessionCount === 1);
	check("tool exposes newest message author", toolStatus.activeSessions[0]?.authorId === "u1");
	check("tool never exposes token value", !JSON.stringify(toolStatus).includes("test-token"));
	check("tool note points at live sessions", toolStatus.note.includes("activeSessions"));
} finally {
	releaseDiscordGatewayLock(lock);
}

console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
