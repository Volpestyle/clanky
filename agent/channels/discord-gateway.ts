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
 *   CLANKY_DISCORD_ALLOWED_GUILD_IDS    optional comma/space server allowlist
 *   CLANKY_DISCORD_ALLOWED_CHANNEL_IDS  optional comma/space channel/thread allowlist
 *   CLANKY_DISCORD_ALLOW_DMS=0           disable DM replies (DMs are allowed by default)
 *   CLANKY_MAIN_AGENT           herdr agent name of the main face pane (default clanky)
 *   CLANKY_FACE_HERDR_TAB_ID    herdr tab that owns the main Clanky face
 *   CLANKY_FACE_HERDR_WORKSPACE_ID  herdr workspace that owns the main Clanky face
 *   CLANKY_REPO_DIR             repo checkout dir, for resolving the mirror script
 */
import { defineChannel, GET } from "eve/channels";
import {
	attachVoiceRuntime,
	getActiveVoiceVox,
	joinVoice,
	leaveVoice,
	recordActiveVoiceStreamWatchConnect,
} from "./voice.ts";
import { type BridgeCommand, DiscordPresenceHost, reportVoiceFault } from "../lib/discord/host.ts";
import { resolveDiscordCredentialKind, resolveDiscordToken } from "../lib/discord/gateway.ts";
import {
	type DiscordGatewayLock,
	type DiscordGatewaySessionStatus,
	type DiscordGatewayStatus,
	acquireDiscordGatewayLock,
	readDiscordGatewayStatus,
	releaseDiscordGatewayLock,
	resolveDiscordGatewayHealth,
	writeDiscordGatewayStatus,
} from "../lib/discord/gateway-status.ts";
import { type GoLiveSink, GoLiveController, clearActiveGoLive, setActiveGoLive } from "../lib/discord/golive.ts";
import { attachPrivateCallAutoAnswer, fetchPrivateCallContext, type PrivateCallInfo } from "../lib/discord/private-call.ts";
import { type DiscordInboundMessage, resolveDiscordScopeOptions } from "../lib/discord/acceptance.ts";
import { buildGuildVoiceRuntime, buildPrivateCallVoiceRuntime } from "../lib/discord/voice-runtime.ts";
import type { VoiceIntent } from "../lib/discord/voice-intent.ts";
import { spawnSessionPaneMirror } from "../lib/discord/pane-mirror-spawn.ts";
import { herdrRequest } from "../lib/herdr-socket.ts";

type DiscordGatewayState = {
	host: DiscordPresenceHost | null;
	startError: string | null;
	lock: DiscordGatewayLock | null;
};
const DISCORD_GATEWAY_STATE_KEY = "__clankyDiscordGatewayState" as const;
type DiscordGatewayGlobal = typeof globalThis & { [DISCORD_GATEWAY_STATE_KEY]?: DiscordGatewayState };
const discordGatewayState = ((globalThis as DiscordGatewayGlobal)[DISCORD_GATEWAY_STATE_KEY] ??= {
	host: null,
	startError: null,
	lock: null,
});
const discordGatewayStartedAt = new Date().toISOString();
let activeVoiceTarget: { kind: "guild" | "call"; channelId: string } | null = null;

function eveHost(): string {
	return process.env.CLANKY_EVE_HOST ?? "http://127.0.0.1:2000";
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

function activeVoiceSessionId(fallback?: string): string {
	return getActiveVoiceVox()?.getLastVoiceSessionId() ?? fallback ?? "";
}

function activateGoLive(
	presence: DiscordPresenceHost,
	streamKind: "guild" | "call",
	fallbackSessionId?: () => string | undefined,
): void {
	if (resolveDiscordCredentialKind(process.env) !== "user-token") return;
	const sink: GoLiveSink = {
		watch: (creds) => {
			const vox = getActiveVoiceVox();
			if (vox === null) return;
			vox.streamWatchConnect({ ...creds, sessionId: activeVoiceSessionId(fallbackSessionId?.()) });
			recordActiveVoiceStreamWatchConnect();
		},
		publish: (creds) =>
			getActiveVoiceVox()?.streamPublishConnect({ ...creds, sessionId: activeVoiceSessionId(fallbackSessionId?.()) }),
	};
	setActiveGoLive(
		new GoLiveController(presence.discordGateway.rawGatewayClient(), {
			streamKind,
			selfUserId: () => presence.discordGateway.selfUserId,
			sink,
		}),
	);
}

async function joinGuildVoice(presence: DiscordPresenceHost, message: DiscordInboundMessage): Promise<void> {
	if (message.guildId === undefined) throw new Error("voice join requires a guild message");
	const client = presence.discordGateway.discordClient;
	const guild = await client.guilds.fetch(message.guildId);
	const member = await guild.members.fetch(message.authorId);
	const channel = member.voice.channel;
	if (channel === null) throw new Error(`${message.authorName ?? message.authorId} is not in a voice channel`);
	const runtime = buildGuildVoiceRuntime(guild, process.env, {
		userId: message.authorId,
		...(message.authorName === undefined ? {} : { userName: message.authorName }),
	});
	// Surface an unexpected voice drop back into the channel that asked Clanky to
	// join, so he never silently vanishes from VC (SPEC.md §5.3, no reconnect), and
	// clear Go Live since the dropped session's ClankVox transport is gone too.
	runtime.reportFault = (fault) =>
		reportVoiceFault(message.channelId, fault, {
			clearGoLive: clearActiveGoLive,
			sendMessage: (channelId, text) => presence.discordGateway.sendMessage(channelId, text),
			onError: (error) => console.error("voice drop notice failed:", error),
		});
	attachVoiceRuntime(runtime);
	await joinVoice(guild.id, channel.id);
	activeVoiceTarget = { kind: "guild", channelId: channel.id };
	activateGoLive(presence, "guild", () => guild.members.me?.voice.sessionId ?? undefined);
}

async function joinPrivateCall(
	presence: DiscordPresenceHost,
	channelId: string,
	context: Pick<PrivateCallInfo, "peer" | "speakers"> = {},
): Promise<void> {
	if (resolveDiscordCredentialKind(process.env) !== "user-token") {
		throw new Error("private Discord calls require CLANKY_DISCORD_CREDENTIAL_KIND=user-token");
	}
	const client = presence.discordGateway.discordClient;
	const resolvedContext = context.peer === undefined && context.speakers === undefined ? await fetchPrivateCallContext(client, channelId) : context;
	const runtime = buildPrivateCallVoiceRuntime(
		client,
		channelId,
		process.env,
		resolvedContext.peer,
		resolvedContext.speakers,
	);
	runtime.reportFault = (fault) =>
		reportVoiceFault(channelId, fault, {
			clearGoLive: clearActiveGoLive,
			sendMessage: (targetChannelId, text) => presence.discordGateway.sendMessage(targetChannelId, text),
			onError: (error) => console.error("private call voice drop notice failed:", error),
		});
	attachVoiceRuntime(runtime);
	// For Discord private calls, the DM channel id is also the voice server id
	// that the voice gateway expects in Identify.
	await joinVoice(channelId, channelId);
	activeVoiceTarget = { kind: "call", channelId };
	activateGoLive(presence, "call");
}

async function handlePrivateCallDeleted(channelId: string): Promise<void> {
	if (activeVoiceTarget?.kind !== "call" || activeVoiceTarget.channelId !== channelId) return;
	clearActiveGoLive();
	await leaveVoice();
	activeVoiceTarget = null;
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
		activeVoiceTarget = null;
		return;
	}
	if (message.guildId === undefined) {
		if (message.kind !== "dm") throw new Error("voice join requires a guild message, DM call, or group DM call");
		await joinPrivateCall(presence, message.channelId, {
			peer: {
				userId: message.authorId,
				...(message.authorName === undefined ? {} : { userName: message.authorName }),
			},
			speakers: [
				{
					userId: message.authorId,
					...(message.authorName === undefined ? {} : { userName: message.authorName }),
				},
			],
		});
		return;
	}
	await joinGuildVoice(presence, message);
}

function ensureStarted(): void {
	if (discordGatewayState.host !== null || discordGatewayState.startError !== null) return;
	if (discordGatewayState.lock?.status === "held") return;
	const token = resolveDiscordToken(process.env);
	if (process.env.CLANKY_DISCORD_PRESENCE !== "1" || token === undefined || token.length === 0) return;
	if (discordGatewayState.lock === null) {
		const lock = acquireDiscordGatewayLock();
		discordGatewayState.lock = lock;
		if (lock.status === "held") {
			console.info(
				`discord presence not started: gateway lock held${lock.ownerPid === undefined ? "" : ` by pid ${lock.ownerPid}`}`,
			);
			return;
		}
	}
	const voiceEnabled = process.env.CLANKY_DISCORD_VOICE === "1";
	const credentialKind = resolveDiscordCredentialKind(process.env);
	const sessions = new Map<string, DiscordGatewaySessionStatus>();
	const writeStatus = (status: {
		state: DiscordGatewayStatus["state"];
		ready: boolean;
		error?: string;
	}): void =>
		writeDiscordGatewayStatus(
			discordGatewayState.lock,
			{
				...status,
				credentialKind,
				voice: voiceEnabled,
				sessions: [...sessions.values()],
			},
			{ startedAt: discordGatewayStartedAt },
		);
	writeStatus({ state: "starting", ready: false });
	const presence: DiscordPresenceHost = new DiscordPresenceHost({
		token,
		credentialKind,
		eveHost: eveHost(),
		voice: voiceEnabled,
		onPresenceActivity: (info) => {
			sessions.set(info.channelId, info);
			writeStatus({ state: "ready", ready: presence.discordGateway.isReady() });
		},
		onPresenceSession: async (info) => {
			sessions.set(info.channelId, info);
			writeStatus({ state: "ready", ready: presence.discordGateway.isReady() });
			await spawnSessionPaneMirror(`discord-${info.channelId.slice(-6)}`, info.sessionId);
		},
		onBridgeToMain: (command) =>
			routeBridgeToMain(command).catch((error: unknown) => console.error("discord bridge-to-main failed:", error)),
		onVoiceIntent: voiceEnabled
			? (intent, message) => handleVoiceIntent(presence, intent, message)
			: undefined,
	});
	if (voiceEnabled && credentialKind === "user-token") {
		attachPrivateCallAutoAnswer({
			client: presence.discordGateway.discordClient,
			scope: resolveDiscordScopeOptions(process.env),
			onIncoming: (call) => joinPrivateCall(presence, call.channelId, call),
			onDeleted: (channelId) => handlePrivateCallDeleted(channelId),
			onError: (error) => console.error("discord private call auto-answer failed:", error),
		});
	}
	discordGatewayState.host = presence;
	presence
		.start()
		.then(() => {
			writeStatus({ state: "ready", ready: presence.discordGateway.isReady() });
		})
		.catch((error: unknown) => {
			const message = (error as Error).message;
			discordGatewayState.startError = message;
			discordGatewayState.host = null;
			writeStatus({ state: "failed", ready: false, error: message });
			releaseDiscordGatewayLock(discordGatewayState.lock);
			discordGatewayState.lock = null;
			console.error("discord presence failed to start:", error);
		});
}

// Guarded boot: connects only in the always-on runtime, never during build/info.
ensureStarted();

export default defineChannel({
	routes: [
		GET("/discord-gateway/health", async () => {
			ensureStarted();
			const status = readDiscordGatewayStatus(discordGatewayState.lock);
			const health = resolveDiscordGatewayHealth({
				lock: discordGatewayState.lock,
				hostPresent: discordGatewayState.host !== null,
				hostReady: discordGatewayState.host?.discordGateway.isReady(),
				startError: discordGatewayState.startError,
			});
			return Response.json({
				...health,
				scope: resolveDiscordScopeOptions(process.env),
				status,
			});
		}),
	],
});
