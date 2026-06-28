/**
 * Clanky's voice channel (SPEC.md §5.3).
 *
 * A bearer-authenticated WS control surface for live voice. The media session
 * (ClankVox transport + OpenAI Realtime + turn-buffer bridge) is wired by the
 * control plane in agent/lib/voice; a Discord-connected host attaches the
 * live runtime via attachVoiceRuntime(). Watchable voice work is handed to a
 * herdr pane (clanky:voice-<slug>) through the spawn seam.
 *
 * Env: CLANKY_RELAY_TOKEN — the same tailnet front-door bearer token.
 */
import { defineChannel, WS } from "eve/channels";
import type { WebSocketMessage, WebSocketPeer } from "eve/channels";
import { isFrontdoorAuthorized } from "../lib/frontdoor-auth.ts";
import { spawnSessionPaneMirror } from "../lib/discord/pane-mirror-spawn.ts";
import { resolveClankyFacePanePlacement, startHerdrAgentNearPlacement } from "../lib/herdr-placement.ts";
import type { ClankvoxIpcClient } from "../lib/voice/clankvoxIpcClient.ts";
import {
	type ClankvoxGuildLike,
	type OpenAiRealtimeConnectOptions,
	startVoiceSession,
	type VoiceExternalTtsConfig,
	type VoiceRealtimeConfig,
	type VoiceSession,
	type VoiceSessionFault,
	type VoiceSpeakerResolver,
	type VoiceControlInput,
	summarizeVoiceRuntimeConfig,
} from "../lib/voice/index.ts";

/** Live voice runtime injected by a Discord-connected host process. */
export interface VoiceRuntime {
	guild: ClankvoxGuildLike;
	realtime: VoiceRealtimeConfig;
	connect: OpenAiRealtimeConnectOptions;
	externalTts?: VoiceExternalTtsConfig;
	memorySpeaker?: { userId: string; userName?: string };
	resolveSpeaker?: VoiceSpeakerResolver;
	eveSessionHost?: string;
	memoryContextLimit?: number;
}

let runtime: VoiceRuntime | null = null;
let session: VoiceSession | null = null;

/** A Discord-connected host attaches the live voice runtime (adapter + creds). */
export function attachVoiceRuntime(value: VoiceRuntime): void {
	runtime = value;
}

/** Programmatic join, for the gateway host's "hop in vc" intent (SPEC.md §5.3). */
export async function joinVoice(guildId: string, channelId: string): Promise<void> {
	if (!runtime) throw new Error("voice runtime not attached (no Discord adapter / creds)");
	if (session) await session.stop();
	const started = await startVoiceSession({
		guildId,
		channelId,
		...runtime,
		// The voice durability session runs the same brain (tools, memory,
		// delegation); mirror it into a watch-only pane like text presence (§5.6).
		onEveSessionId: (sessionId) => {
			void spawnSessionPaneMirror(`voice-${channelId.slice(-6)}`, sessionId).catch((error: unknown) =>
				console.error("voice pane mirror spawn failed:", error),
			);
		},
		onFault: (fault) => {
			void handleVoiceFault(started, fault);
		},
	});
	session = started;
}

/**
 * An unexpected realtime drop leaves a zombie session (ClankVox + Discord adapter
 * alive, brain dead). Tear it down and clear state so voiceStatus reflects reality.
 * We do not auto-reconnect (SPEC.md §2); the user can re-issue join.
 */
async function handleVoiceFault(faultedSession: VoiceSession, fault: VoiceSessionFault): Promise<void> {
	if (session !== faultedSession) return;
	session = null;
	process.stderr.write(`voice: realtime ${fault.kind} (${fault.detail}); session torn down\n`);
	try {
		await faultedSession.stop();
	} catch {
		// best-effort teardown; the realtime socket is already gone
	}
}

/** Programmatic leave. */
export async function leaveVoice(): Promise<void> {
	if (!session) return;
	await session.stop();
	session = null;
}

export function voiceStatus(): { runtimeAttached: boolean; sessionActive: boolean; voice: Record<string, unknown> } {
	const sessionStatus = session?.status();
	const voice: Record<string, unknown> = {
		runtimeAttached: runtime !== null,
		sessionActive: session !== null,
	};
	if (runtime !== null) {
		const settings = summarizeVoiceRuntimeConfig(runtime);
		voice.realtimeProvider = settings.realtimeProvider;
		voice.ttsProvider = settings.ttsProvider;
		voice.settings = settings;
	}
	if (sessionStatus !== undefined) {
		voice.realtimeProvider = sessionStatus.realtimeProvider;
		voice.ttsProvider = sessionStatus.ttsProvider;
		voice.settings = sessionStatus.settings;
		voice.turnBuffer = sessionStatus.turnBuffer;
		voice.stats = sessionStatus.stats;
	}
	return { runtimeAttached: runtime !== null, sessionActive: session !== null, voice };
}

/** Active ClankVox client, for forwarding Go Live stream credentials (§5.3). */
export function getActiveVoiceVox(): ClankvoxIpcClient | null {
	return session?.vox ?? null;
}

export function recordActiveVoiceStreamWatchConnect(): void {
	session?.recordStreamWatchConnect();
}

export async function executeActiveVoiceControl(input: VoiceControlInput): Promise<unknown> {
	if (!session) throw new Error("no active voice session; join a voice channel first");
	return await session.control(input);
}

interface VoiceRequest {
	id?: string | number;
	op: string;
	args?: Record<string, unknown>;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function str(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

function authorized(peer: WebSocketPeer): boolean {
	return isFrontdoorAuthorized(peer.request);
}

async function dispatch(op: string, args: Record<string, unknown>): Promise<unknown> {
	switch (op) {
		case "status":
			return voiceStatus();
		case "join": {
			const guildId = str(args.guildId);
			const channelId = str(args.channelId);
			if (!guildId || !channelId) throw new Error("join requires guildId and channelId");
			await joinVoice(guildId, channelId);
			return { joined: true, guildId, channelId };
		}
		case "leave": {
			await leaveVoice();
			return { left: true };
		}
		case "control": {
			return await executeActiveVoiceControl(parseVoiceControlArgs(args));
		}
		case "delegate": {
			// Hand watchable voice work to a visible herdr pane.
			const slug = str(args.slug);
			const task = str(args.task);
			if (!slug || !SLUG_RE.test(slug)) throw new Error("delegate requires a kebab-case slug");
			if (!task) throw new Error("delegate requires a task");
			const agent = `clanky:voice-${slug}`;
			const placement = await resolveClankyFacePanePlacement();
			const result = await startHerdrAgentNearPlacement({
				name: agent,
				focus: false,
				argv: ["claude", "--dangerously-skip-permissions", task],
				placement,
			});
			return { agent, started: true, result };
		}
		default:
			throw new Error(`unknown voice op '${op}'`);
	}
}

function parseVoiceControlArgs(args: Record<string, unknown>): VoiceControlInput {
	const op = str(args.op);
	if (!isVoiceControlOp(op)) throw new Error("control requires a valid voice op");
	return {
		op,
		...optionalString(args.url, "url"),
		...optionalString(args.preferredRegion, "preferredRegion"),
		...optionalString(args.visualizerMode, "visualizerMode"),
		...optionalString(args.streamKey, "streamKey"),
		...optionalNumber(args.volume, "volume"),
		...optionalNumber(args.fadeMs, "fadeMs"),
		...(typeof args.resolvedDirectUrl === "boolean" ? { resolvedDirectUrl: args.resolvedDirectUrl } : {}),
	};
}

function optionalString<T extends string>(value: unknown, key: T): { [K in T]?: string } {
	return typeof value === "string" && value.trim().length > 0 ? ({ [key]: value.trim() } as { [K in T]?: string }) : {};
}

function optionalNumber<T extends string>(value: unknown, key: T): { [K in T]?: number } {
	return typeof value === "number" && Number.isFinite(value) ? ({ [key]: value } as { [K in T]?: number }) : {};
}

function isVoiceControlOp(value: string | undefined): value is VoiceControlInput["op"] {
	return (
		value === "status" ||
		value === "music_play" ||
		value === "music_stop" ||
		value === "music_pause" ||
		value === "music_resume" ||
		value === "music_volume" ||
		value === "video_play" ||
		value === "video_visualizer" ||
		value === "video_stop" ||
		value === "video_pause" ||
		value === "video_resume" ||
		value === "golive_start" ||
		value === "golive_stop" ||
		value === "golive_pause" ||
		value === "golive_resume"
	);
}

export default defineChannel({
	routes: [
		WS("/voice/ws", async () => ({
			open(peer: WebSocketPeer) {
				if (!authorized(peer)) {
					peer.close(4401, "unauthorized");
					return;
				}
				peer.send(JSON.stringify({ type: "ready" }));
			},
			async message(peer: WebSocketPeer, message: WebSocketMessage) {
				if (!authorized(peer)) {
					peer.close(4401, "unauthorized");
					return;
				}
				let req: VoiceRequest;
				try {
					req = JSON.parse(message.text()) as VoiceRequest;
				} catch {
					peer.send(JSON.stringify({ error: "invalid JSON" }));
					return;
				}
				try {
					const result = await dispatch(req.op, req.args ?? {});
					peer.send(JSON.stringify({ id: req.id, ok: true, result }));
				} catch (error) {
					peer.send(JSON.stringify({ id: req.id, ok: false, error: (error as Error).message }));
				}
			},
		})),
	],
});
