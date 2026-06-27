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
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineChannel, GET } from "eve/channels";
import {
	attachVoiceRuntime,
	getActiveVoiceVox,
	joinVoice,
	leaveVoice,
	recordActiveVoiceStreamWatchConnect,
} from "./voice.ts";
import { type BridgeCommand, DiscordPresenceHost } from "../lib/discord/host.ts";
import { resolveDiscordCredentialKind, resolveDiscordToken } from "../lib/discord/gateway.ts";
import { type GoLiveSink, GoLiveController, clearActiveGoLive, setActiveGoLive } from "../lib/discord/golive.ts";
import { type DiscordInboundMessage, resolveDiscordScopeOptions } from "../lib/discord/acceptance.ts";
import { buildGuildVoiceRuntime } from "../lib/discord/voice-runtime.ts";
import type { VoiceIntent } from "../lib/discord/voice-intent.ts";
import { herdrRequest } from "../lib/herdr-socket.ts";
import {
	getHerdrAgent,
	nonEmptyString,
	paneMatchesPlacement,
	resolveClankyFacePanePlacement,
	startHerdrAgentNearPlacement,
} from "../lib/herdr-placement.ts";

type DiscordGatewayState = {
	host: DiscordPresenceHost | null;
	startError: string | null;
	lock: DiscordGatewayLock | null;
};
type DiscordGatewayLock =
	| { status: "acquired"; path: string; ownerPid: number }
	| { status: "held"; path: string; ownerPid?: number };
type DiscordGatewayStatus = {
	pid: number;
	repo: string;
	startedAt: string;
	updatedAt: string;
	state: "starting" | "ready" | "failed";
	ready: boolean;
	credentialKind: "bot-token" | "user-token";
	voice: boolean;
	scope: ReturnType<typeof resolveDiscordScopeOptions>;
	sessions: { channelId: string; sessionId: string }[];
	error?: string;
};
const DISCORD_GATEWAY_STATE_KEY = "__clankyDiscordGatewayState" as const;
type DiscordGatewayGlobal = typeof globalThis & { [DISCORD_GATEWAY_STATE_KEY]?: DiscordGatewayState };
const discordGatewayState = ((globalThis as DiscordGatewayGlobal)[DISCORD_GATEWAY_STATE_KEY] ??= {
	host: null,
	startError: null,
	lock: null,
});
const discordGatewayStartedAt = new Date().toISOString();

function eveHost(): string {
	return process.env.CLANKY_EVE_HOST ?? "http://127.0.0.1:2000";
}

function mirrorScriptPath(): string {
	return join(process.env.CLANKY_REPO_DIR ?? process.cwd(), "scripts", "discord-pane-mirror.ts");
}

function discordGatewayLockPath(): string {
	const repo = process.env.CLANKY_REPO_DIR ?? process.cwd();
	const hash = createHash("sha1").update(repo).digest("hex").slice(0, 16);
	return join(tmpdir(), `clanky-discord-gateway-${hash}.lock`);
}

function acquireDiscordGatewayLock(): DiscordGatewayLock {
	const path = discordGatewayLockPath();
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			mkdirSync(path);
			const lock: DiscordGatewayLock = { status: "acquired", path, ownerPid: process.pid };
			writeFileSync(join(path, "owner.json"), JSON.stringify({ pid: process.pid, repo: process.cwd(), startedAt: new Date().toISOString() }));
			process.once("exit", () => releaseDiscordGatewayLock(lock));
			return lock;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw error;
			const ownerPid = readDiscordGatewayLockOwner(path);
			if (ownerPid !== undefined && !isProcessAlive(ownerPid)) {
				rmSync(path, { recursive: true, force: true });
				continue;
			}
			return { status: "held", path, ...(ownerPid === undefined ? {} : { ownerPid }) };
		}
	}
	return { status: "held", path, ownerPid: readDiscordGatewayLockOwner(path) };
}

function releaseDiscordGatewayLock(lock: DiscordGatewayLock | null): void {
	if (lock?.status !== "acquired") return;
	rmSync(lock.path, { recursive: true, force: true });
}

function readDiscordGatewayLockOwner(path: string): number | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as { pid?: unknown };
		return typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : undefined;
	} catch {
		return undefined;
	}
}

function discordGatewayStatusPath(lockPath: string): string {
	return join(lockPath, "status.json");
}

function writeDiscordGatewayStatus(
	lock: DiscordGatewayLock | null,
	status: {
		state: DiscordGatewayStatus["state"];
		ready: boolean;
		credentialKind: DiscordGatewayStatus["credentialKind"];
		voice: boolean;
		sessions: DiscordGatewayStatus["sessions"];
		error?: string;
	},
): void {
	if (lock?.status !== "acquired") return;
	const snapshot: DiscordGatewayStatus = {
		pid: process.pid,
		repo: process.env.CLANKY_REPO_DIR ?? process.cwd(),
		startedAt: discordGatewayStartedAt,
		updatedAt: new Date().toISOString(),
		state: status.state,
		ready: status.ready,
		credentialKind: status.credentialKind,
		voice: status.voice,
		scope: resolveDiscordScopeOptions(process.env),
		sessions: status.sessions,
		...(status.error === undefined ? {} : { error: status.error }),
	};
	writeFileSync(discordGatewayStatusPath(lock.path), JSON.stringify(snapshot, null, 2));
}

function readDiscordGatewayStatus(lock: DiscordGatewayLock | null): DiscordGatewayStatus | null {
	if (lock === null) return null;
	try {
		const parsed = JSON.parse(readFileSync(discordGatewayStatusPath(lock.path), "utf8")) as unknown;
		if (!isRecord(parsed)) return null;
		return parsed as DiscordGatewayStatus;
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Spawn a read-only herdr pane that tails a presence session's event stream. */
async function spawnPaneMirror(channelId: string, sessionId: string): Promise<void> {
	const slug = `discord-${channelId.slice(-6)}`;
	const agent = `clanky:${slug}`;
	const placement = await resolveClankyFacePanePlacement();
	const existing = await getHerdrAgent(agent);
	if (existing !== undefined) {
		if (paneMatchesPlacement(existing, placement)) return;
		const paneId = nonEmptyString(existing.pane_id);
		if (paneId === undefined) return;
		await herdrRequest("pane.close", { pane_id: paneId }).catch(() => undefined);
	}
	await startHerdrAgentNearPlacement({
		name: agent,
		focus: false,
		argv: [process.execPath, mirrorScriptPath(), eveHost(), sessionId, slug],
		placement,
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
	attachVoiceRuntime(
		buildGuildVoiceRuntime(guild, process.env, {
			userId: message.authorId,
			...(message.authorName === undefined ? {} : { userName: message.authorName }),
		}),
	);
	await joinVoice(guild.id, channel.id);

	// Go Live needs the user-token raw seam + a live ClankVox to decode/publish.
	if (resolveDiscordCredentialKind(process.env) === "user-token") {
		const sink: GoLiveSink = {
			watch: (creds) => {
				const vox = getActiveVoiceVox();
				if (vox === null) return;
				vox.streamWatchConnect({ ...creds, sessionId: guild.members.me?.voice.sessionId ?? "" });
				recordActiveVoiceStreamWatchConnect();
			},
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
	const sessions = new Map<string, string>();
	const writeStatus = (status: {
		state: DiscordGatewayStatus["state"];
		ready: boolean;
		error?: string;
	}): void =>
		writeDiscordGatewayStatus(discordGatewayState.lock, {
			...status,
			credentialKind,
			voice: voiceEnabled,
			sessions: [...sessions].map(([channelId, sessionId]) => ({ channelId, sessionId })),
		});
	writeStatus({ state: "starting", ready: false });
	const presence: DiscordPresenceHost = new DiscordPresenceHost({
		token,
		credentialKind,
		eveHost: eveHost(),
		voice: voiceEnabled,
		onPresenceSession: async ({ channelId, sessionId }) => {
			sessions.set(channelId, sessionId);
			writeStatus({ state: "ready", ready: presence.discordGateway.isReady() });
			await spawnPaneMirror(channelId, sessionId);
		},
		onBridgeToMain: (command) =>
			routeBridgeToMain(command).catch((error: unknown) => console.error("discord bridge-to-main failed:", error)),
		onVoiceIntent: voiceEnabled
			? (intent, message) =>
					handleVoiceIntent(presence, intent, message).catch((error: unknown) =>
						console.error("discord voice intent failed:", error),
					)
			: undefined,
	});
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
			const owner =
				discordGatewayState.host !== null
					? "this-context"
					: discordGatewayState.lock?.status === "held" && discordGatewayState.lock.ownerPid === process.pid
						? "other-context"
						: discordGatewayState.lock?.status === "held"
							? "other-process"
							: "none";
			return Response.json({
				ok: discordGatewayState.startError === null,
				running: owner !== "none",
				ready: discordGatewayState.host?.discordGateway.isReady() ?? status?.ready ?? (owner === "other-context" ? null : false),
				owner,
				lock: discordGatewayState.lock,
				scope: resolveDiscordScopeOptions(process.env),
				error: discordGatewayState.startError,
				status,
			});
		}),
	],
});
