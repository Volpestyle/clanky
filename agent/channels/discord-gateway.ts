/**
 * Boot seam for Clanky's free-will Discord presence (SPEC.md §5.2).
 *
 * Unlike discord.ts (stock HTTP Interactions, request/response), this owns the
 * always-on Discord Gateway connection so Clanky can listen to whole channels
 * and decide for himself when to speak. The gateway must run inside the
 * conductor process (so voice can attach in-process and dispatch can reach the
 * agent's own session API over loopback), so it is started here as a guarded
 * module side effect when the runtime — not a build/info pass — sets
 * CLANKY_DISCORD_PRESENCE=1 and a bot token is present.
 *
 * Env:
 *   CLANKY_DISCORD_PRESENCE=1   opt in (set by the always-on runtime, not build)
 *   DISCORD_BOT_TOKEN           the agent-owned credential (bot or user/self token)
 *   CLANKY_DISCORD_CREDENTIAL_KIND  bot-token (default) | user-token (Go Live)
 *   CLANKY_EVE_HOST             loopback base URL of this eve server (default :2000)
 *   CLANKY_DISCORD_VOICE=1      include voice intents for "hop in vc"
 *   CLANKY_MAIN_AGENT           herdr agent name of the main face pane (default clanky)
 *   CLANKY_REPO_DIR             repo checkout dir, for resolving the mirror script
 */
import { join } from "node:path";
import { defineChannel, GET } from "eve/channels";
import { attachVoiceRuntime, getActiveVoiceVox, joinVoice, leaveVoice } from "./voice.ts";
import { type BridgeCommand, DiscordPresenceHost } from "../lib/discord/host.ts";
import { resolveDiscordCredentialKind } from "../lib/discord/gateway.ts";
import { type GoLiveSink, GoLiveController, clearActiveGoLive, setActiveGoLive } from "../lib/discord/golive.ts";
import type { DiscordInboundMessage } from "../lib/discord/acceptance.ts";
import { buildGuildVoiceRuntime } from "../lib/discord/voice-runtime.ts";
import type { VoiceIntent } from "../lib/discord/voice-intent.ts";
import { herdrRequest } from "../lib/herdr-socket.ts";

let host: DiscordPresenceHost | null = null;
let startError: string | null = null;

function eveHost(): string {
	return process.env.CLANKY_EVE_HOST ?? "http://127.0.0.1:2000";
}

function mirrorScriptPath(): string {
	return join(process.env.CLANKY_REPO_DIR ?? process.cwd(), "scripts", "discord-pane-mirror.ts");
}

/** Spawn a read-only herdr pane that tails a presence session's event stream. */
async function spawnPaneMirror(channelId: string, sessionId: string): Promise<void> {
	const slug = `discord-${channelId.slice(-6)}`;
	const agent = `clanky:${slug}`;
	const exists = await herdrRequest("agent.get", { target: agent }).then(
		() => true,
		() => false,
	);
	if (exists) return;
	await herdrRequest("agent.start", {
		name: agent,
		focus: false,
		argv: ["node", mirrorScriptPath(), eveHost(), sessionId, slug],
	});
}

/** Route a bridge command to the main Clanky face pane via the herdr socket. */
async function routeBridgeToMain(command: BridgeCommand): Promise<void> {
	const mainAgent = process.env.CLANKY_MAIN_AGENT ?? "clanky";
	const text =
		command.type === "new"
			? "/new"
			: command.type === "compact"
				? `/compact ${command.prompt}`.trim()
				: command.prompt;
	if (text.length === 0) return;
	await herdrRequest("agent.send", { target: mainAgent, text });
}

/** Resolve the speaker's current voice channel and join/leave it via ClankVox. */
async function handleVoiceIntent(
	presence: DiscordPresenceHost,
	intent: VoiceIntent,
	message: DiscordInboundMessage,
): Promise<void> {
	if (intent === "leave") {
		clearActiveGoLive();
		await leaveVoice();
		return;
	}
	if (message.guildId === undefined) throw new Error("voice join requires a guild message");
	const client = presence.discordGateway.discordClient;
	const guild = await client.guilds.fetch(message.guildId);
	const member = await guild.members.fetch(message.authorId);
	const channel = member.voice.channel;
	if (channel === null) throw new Error(`${message.authorName ?? message.authorId} is not in a voice channel`);
	attachVoiceRuntime(buildGuildVoiceRuntime(guild, process.env));
	await joinVoice(guild.id, channel.id);

	// Go Live needs the user-token raw seam + a live ClankVox to decode/publish.
	if (resolveDiscordCredentialKind(process.env) === "user-token") {
		const sink: GoLiveSink = {
			watch: (creds) =>
				getActiveVoiceVox()?.streamWatchConnect({ ...creds, sessionId: guild.members.me?.voice.sessionId ?? "" }),
			publish: (creds) =>
				getActiveVoiceVox()?.streamPublishConnect({ ...creds, sessionId: guild.members.me?.voice.sessionId ?? "" }),
		};
		setActiveGoLive(
			new GoLiveController(presence.discordGateway.rawGatewayClient(), {
				selfUserId: () => presence.discordGateway.selfUserId,
				sink,
			}),
		);
	}
}

function ensureStarted(): void {
	if (host !== null || startError !== null) return;
	const token = process.env.DISCORD_BOT_TOKEN;
	if (process.env.CLANKY_DISCORD_PRESENCE !== "1" || token === undefined || token.length === 0) return;
	const voiceEnabled = process.env.CLANKY_DISCORD_VOICE === "1";
	const presence: DiscordPresenceHost = new DiscordPresenceHost({
		token,
		credentialKind: resolveDiscordCredentialKind(process.env),
		eveHost: eveHost(),
		voice: voiceEnabled,
		onPresenceSession: ({ channelId, sessionId }) =>
			spawnPaneMirror(channelId, sessionId).catch((error: unknown) =>
				console.error("discord pane mirror spawn failed:", error),
			),
		onBridgeToMain: (command) =>
			routeBridgeToMain(command).catch((error: unknown) => console.error("discord bridge-to-main failed:", error)),
		onVoiceIntent: voiceEnabled
			? (intent, message) =>
					handleVoiceIntent(presence, intent, message).catch((error: unknown) =>
						console.error("discord voice intent failed:", error),
					)
			: undefined,
	});
	host = presence;
	presence.start().catch((error: unknown) => {
		startError = (error as Error).message;
		host = null;
		console.error("discord presence failed to start:", error);
	});
}

// Guarded boot: connects only in the always-on runtime, never during build/info.
ensureStarted();

export default defineChannel({
	routes: [
		GET("/discord-gateway/health", async () => {
			ensureStarted();
			return Response.json({
				ok: startError === null,
				running: host !== null,
				ready: host?.discordGateway.isReady() ?? false,
				error: startError,
			});
		}),
	],
});
