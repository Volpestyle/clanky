/**
 * Voice session supervisor — wires the ported control plane together:
 * ClankVox media transport + OpenAI Realtime + the turn-buffer bridge. This is
 * the eve-era replacement for the old voiceSupervisorExtension.
 *
 * The Discord voice adapter (`guild`) and provider credentials are injected at
 * runtime by whatever owns the Discord connection; this module owns the wiring,
 * not the transport.
 */
import { bindClankvoxRealtimeBridge } from "./clankvoxRealtimeBridge.ts";
import { ClankvoxIpcClient, type ClankvoxGuildLike, type ClankvoxSpawnOptions } from "./clankvoxIpcClient.ts";
import type { DiscordVoiceTurnBuffer } from "./discordVoiceTurnBuffer.ts";
import { OpenAiRealtimeClient, type OpenAiRealtimeConnectOptions } from "./openAiRealtimeClient.ts";

export interface VoiceSessionConfig {
	guildId: string;
	channelId: string;
	/** Injected Discord voice adapter (a discord.js Guild-like). */
	guild: ClankvoxGuildLike;
	openAiApiKey: string;
	connect: OpenAiRealtimeConnectOptions;
	clankvox?: ClankvoxSpawnOptions;
}

export interface VoiceSession {
	vox: ClankvoxIpcClient;
	realtime: OpenAiRealtimeClient;
	turnBuffer: DiscordVoiceTurnBuffer;
	stop(): Promise<void>;
}

/** Start a live voice session: spawn ClankVox, connect Realtime, bind the bridge. */
export async function startVoiceSession(config: VoiceSessionConfig): Promise<VoiceSession> {
	const vox = await ClankvoxIpcClient.spawn(config.guildId, config.channelId, config.guild, config.clankvox ?? {});
	const realtime = new OpenAiRealtimeClient({ apiKey: config.openAiApiKey });
	await realtime.connect(config.connect);
	const turnBuffer = bindClankvoxRealtimeBridge({ vox, realtime });

	return {
		vox,
		realtime,
		turnBuffer,
		async stop() {
			turnBuffer.dispose();
			await realtime.close();
			await vox.destroy();
		},
	};
}
