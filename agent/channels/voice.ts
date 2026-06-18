/**
 * Clanky's voice channel (SPEC.md §5.3).
 *
 * A bearer-authenticated WS control surface for live voice. The media session
 * (ClankVox transport + OpenAI Realtime + turn-buffer bridge) is wired by the
 * ported control plane in agent/lib/voice; a Discord-connected host attaches the
 * live runtime via attachVoiceRuntime(). Watchable voice work is handed to a
 * herdr pane (clanky:voice-<slug>) through the spawn seam.
 *
 * Env: CLANKY_RELAY_TOKEN — the same tailnet front-door bearer token.
 */
import { defineChannel, WS } from "eve/channels";
import type { WebSocketMessage, WebSocketPeer } from "eve/channels";
import { isFrontdoorAuthorized } from "../lib/frontdoor-auth.ts";
import { herdrRequest } from "../lib/herdr-socket.ts";
import {
	type ClankvoxGuildLike,
	type OpenAiRealtimeConnectOptions,
	startVoiceSession,
	type VoiceSession,
} from "../lib/voice/index.ts";

/** Live voice runtime injected by a Discord-connected host process. */
export interface VoiceRuntime {
	guild: ClankvoxGuildLike;
	openAiApiKey: string;
	connect: OpenAiRealtimeConnectOptions;
}

let runtime: VoiceRuntime | null = null;
let session: VoiceSession | null = null;

/** A Discord-connected host attaches the live voice runtime (adapter + creds). */
export function attachVoiceRuntime(value: VoiceRuntime): void {
	runtime = value;
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
			return { runtimeAttached: runtime !== null, sessionActive: session !== null };
		case "join": {
			const guildId = str(args.guildId);
			const channelId = str(args.channelId);
			if (!guildId || !channelId) throw new Error("join requires guildId and channelId");
			if (!runtime) throw new Error("voice runtime not attached (no Discord adapter / creds)");
			if (session) await session.stop();
			session = await startVoiceSession({ guildId, channelId, ...runtime });
			return { joined: true, guildId, channelId };
		}
		case "leave": {
			if (session) {
				await session.stop();
				session = null;
			}
			return { left: true };
		}
		case "delegate": {
			// Hand watchable voice work to a visible herdr pane.
			const slug = str(args.slug);
			const task = str(args.task);
			if (!slug || !SLUG_RE.test(slug)) throw new Error("delegate requires a kebab-case slug");
			if (!task) throw new Error("delegate requires a task");
			const agent = `clanky:voice-${slug}`;
			const result = await herdrRequest("agent.start", {
				name: agent,
				focus: false,
				argv: ["claude", "--dangerously-skip-permissions", task],
			});
			return { agent, started: true, result };
		}
		default:
			throw new Error(`unknown voice op '${op}'`);
	}
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
