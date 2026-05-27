import { type ChildProcessByStdio, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;

export interface ClankvoxLaunchOptions {
	bin?: string;
	cwd?: string;
	args?: string[];
	timeoutMs?: number;
	log?: (line: string) => void;
}

export interface ClankvoxSpawnOptions extends ClankvoxLaunchOptions {
	selfDeaf?: boolean;
	selfMute?: boolean;
}

export interface ClankvoxGuildLike {
	shard?: {
		send(payload: JsonRecord): void;
	};
	voiceAdapterCreator?: (callbacks: {
		onVoiceServerUpdate(data: JsonRecord): void;
		onVoiceStateUpdate(data: JsonRecord): void;
	}) => { sendPayload?: (payload: JsonRecord) => boolean; destroy?: () => void } | null | undefined;
}

export interface ClankvoxVoiceAdapterProxy {
	send(payload: JsonRecord): boolean;
	destroy(): void;
}

export interface ClankvoxDecodedVideoFrame {
	userId: string;
	ssrc: number;
	width: number;
	height: number;
	jpegBase64: string;
	rtpTimestamp: number;
	streamType: string | null;
	rid: string | null;
}

export interface ClankvoxTransportState {
	role: string;
	status: string;
	reason: string | null;
}

type ClankvoxCommand =
	| { type: "join"; guildId: string; channelId: string; selfDeaf: boolean; selfMute: boolean }
	| { type: "voice_server"; data: JsonRecord }
	| { type: "voice_state"; data: JsonRecord }
	| { type: "audio"; pcmBase64: string; sampleRate: number }
	| { type: "stop_playback" }
	| { type: "stop_tts_playback" }
	| { type: "subscribe_user"; userId: string; silenceDurationMs: number; sampleRate: number }
	| { type: "unsubscribe_user"; userId: string }
	| {
			type: "subscribe_user_video";
			userId: string;
			maxFramesPerSecond: number;
			preferredQuality: number;
			preferredPixelCount: number | null;
			preferredStreamType: string | null;
			jpegQuality: number | null;
	  }
	| { type: "unsubscribe_user_video"; userId: string }
	| {
			type: "stream_watch_connect";
			endpoint: string;
			token: string;
			serverId: string;
			sessionId: string;
			userId: string;
			daveChannelId: string;
	  }
	| { type: "stream_watch_disconnect"; reason: string | null }
	| {
			type: "stream_publish_connect";
			endpoint: string;
			token: string;
			serverId: string;
			sessionId: string;
			userId: string;
			daveChannelId: string;
	  }
	| { type: "stream_publish_disconnect"; reason: string | null }
	| { type: "music_play"; url: string; resolvedDirectUrl: boolean }
	| { type: "music_stop" }
	| { type: "music_pause" }
	| { type: "music_resume" }
	| { type: "music_set_gain"; target: number; fadeMs: number }
	| { type: "stream_publish_play"; url: string; resolvedDirectUrl: boolean }
	| { type: "stream_publish_play_visualizer"; url: string; resolvedDirectUrl: boolean; visualizerMode: string }
	| { type: "stream_publish_stop" }
	| { type: "stream_publish_pause" }
	| { type: "stream_publish_resume" }
	| { type: "destroy" };

export class ClankvoxIpcClient extends EventEmitter {
	private readonly guildId: string;
	private readonly channelId: string;
	private readonly guild: ClankvoxGuildLike;
	private child: ChildProcessByStdio<Writable, Readable, Readable> | undefined;
	private stdoutBuffer = Buffer.alloc(0);
	private stderrBuffer = "";
	private adapterProxy: ClankvoxVoiceAdapterProxy | undefined;
	private destroyed = false;
	private lastVoiceSessionId: string | undefined;
	private lastVoiceStateUserId: string | undefined;

	private constructor(guildId: string, channelId: string, guild: ClankvoxGuildLike) {
		super();
		this.guildId = guildId;
		this.channelId = channelId;
		this.guild = guild;
	}

	static async spawn(
		guildId: string,
		channelId: string,
		guild: ClankvoxGuildLike,
		options: ClankvoxSpawnOptions = {},
	): Promise<ClankvoxIpcClient> {
		const client = new ClankvoxIpcClient(guildId, channelId, guild);
		await client.spawnProcess(options);
		return client;
	}

	get isAlive(): boolean {
		return (
			this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null && !this.destroyed
		);
	}

	getLastVoiceSessionId(): string | undefined {
		return this.lastVoiceSessionId;
	}

	getLastVoiceStateUserId(): string | undefined {
		return this.lastVoiceStateUserId;
	}

	sendAudio(pcmBase64: string, sampleRate = 24_000): void {
		const normalizedPcm = pcmBase64.trim();
		if (normalizedPcm.length === 0) return;
		this.send({ type: "audio", pcmBase64: normalizedPcm, sampleRate: normalizeSampleRate(sampleRate) });
	}

	stopPlayback(): void {
		this.send({ type: "stop_playback" });
	}

	stopTtsPlayback(): void {
		this.send({ type: "stop_tts_playback" });
	}

	subscribeUser(userId: string, silenceDurationMs = 700, sampleRate = 24_000): void {
		const normalizedUserId = userId.trim();
		if (normalizedUserId.length === 0) return;
		this.send({
			type: "subscribe_user",
			userId: normalizedUserId,
			silenceDurationMs: Math.max(100, Math.floor(silenceDurationMs)),
			sampleRate: normalizeSampleRate(sampleRate),
		});
	}

	unsubscribeUser(userId: string): void {
		const normalizedUserId = userId.trim();
		if (normalizedUserId.length === 0) return;
		this.send({ type: "unsubscribe_user", userId: normalizedUserId });
	}

	subscribeUserVideo(input: {
		userId: string;
		maxFramesPerSecond?: number;
		preferredQuality?: number;
		preferredPixelCount?: number | null;
		preferredStreamType?: string | null;
		jpegQuality?: number | null;
	}): void {
		const normalizedUserId = input.userId.trim();
		if (normalizedUserId.length === 0) return;
		this.send({
			type: "subscribe_user_video",
			userId: normalizedUserId,
			maxFramesPerSecond: Math.max(1, Math.floor(input.maxFramesPerSecond ?? 2)),
			preferredQuality: Math.max(0, Math.min(100, Math.floor(input.preferredQuality ?? 100))),
			preferredPixelCount:
				input.preferredPixelCount === undefined || input.preferredPixelCount === null
					? null
					: Math.max(1, Math.floor(input.preferredPixelCount)),
			preferredStreamType: nullableCommandString(input.preferredStreamType),
			jpegQuality:
				input.jpegQuality === undefined || input.jpegQuality === null
					? null
					: Math.max(10, Math.min(100, Math.floor(input.jpegQuality))),
		});
	}

	unsubscribeUserVideo(userId: string): void {
		const normalizedUserId = userId.trim();
		if (normalizedUserId.length === 0) return;
		this.send({ type: "unsubscribe_user_video", userId: normalizedUserId });
	}

	streamWatchConnect(input: {
		endpoint: string;
		token: string;
		serverId: string;
		sessionId: string;
		userId: string;
		daveChannelId: string;
	}): void {
		this.send({
			type: "stream_watch_connect",
			endpoint: input.endpoint.trim(),
			token: input.token.trim(),
			serverId: input.serverId.trim(),
			sessionId: input.sessionId.trim(),
			userId: input.userId.trim(),
			daveChannelId: input.daveChannelId.trim(),
		});
	}

	streamWatchDisconnect(reason: string | null = null): void {
		this.send({ type: "stream_watch_disconnect", reason });
	}

	streamPublishConnect(input: {
		endpoint: string;
		token: string;
		serverId: string;
		sessionId: string;
		userId: string;
		daveChannelId: string;
	}): void {
		this.send({
			type: "stream_publish_connect",
			endpoint: input.endpoint.trim(),
			token: input.token.trim(),
			serverId: input.serverId.trim(),
			sessionId: input.sessionId.trim(),
			userId: input.userId.trim(),
			daveChannelId: input.daveChannelId.trim(),
		});
	}

	streamPublishDisconnect(reason: string | null = null): void {
		this.send({ type: "stream_publish_disconnect", reason });
	}

	musicPlay(url: string, resolvedDirectUrl = false): void {
		const normalizedUrl = url.trim();
		if (normalizedUrl.length === 0) return;
		this.send({ type: "music_play", url: normalizedUrl, resolvedDirectUrl });
	}

	musicStop(): void {
		this.send({ type: "music_stop" });
	}

	musicPause(): void {
		this.send({ type: "music_pause" });
	}

	musicResume(): void {
		this.send({ type: "music_resume" });
	}

	musicSetGain(target: number, fadeMs: number): void {
		this.send({
			type: "music_set_gain",
			target: Math.max(0, Math.min(1, Number(target) || 0)),
			fadeMs: Math.max(0, Math.floor(Number(fadeMs) || 0)),
		});
	}

	streamPublishPlay(url: string, resolvedDirectUrl = false): void {
		const normalizedUrl = url.trim();
		if (normalizedUrl.length === 0) return;
		this.send({ type: "stream_publish_play", url: normalizedUrl, resolvedDirectUrl });
	}

	streamPublishPlayVisualizer(url: string, resolvedDirectUrl = false, visualizerMode = "cqt"): void {
		const normalizedUrl = url.trim();
		if (normalizedUrl.length === 0) return;
		this.send({
			type: "stream_publish_play_visualizer",
			url: normalizedUrl,
			resolvedDirectUrl,
			visualizerMode: normalizeVisualizerMode(visualizerMode),
		});
	}

	streamPublishStop(): void {
		this.send({ type: "stream_publish_stop" });
	}

	streamPublishPause(): void {
		this.send({ type: "stream_publish_pause" });
	}

	streamPublishResume(): void {
		this.send({ type: "stream_publish_resume" });
	}

	async destroy(): Promise<void> {
		this.destroyed = true;
		this.forwardVoiceStateUpdate(null);
		this.adapterProxy?.destroy();
		this.adapterProxy = undefined;
		this.send({ type: "destroy" });
		const child = this.child;
		if (child === undefined) return;
		await new Promise<void>((resolveDone) => {
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				clearTimeout(termTimer);
				clearTimeout(killTimer);
				resolveDone();
			};
			child.once("exit", finish);
			child.stdin.end();
			const termTimer = setTimeout(() => child.kill("SIGTERM"), 250);
			const killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
		});
		this.child = undefined;
	}

	private async spawnProcess(options: ClankvoxSpawnOptions): Promise<void> {
		const launch = resolveLaunch(options);
		const child = spawn(launch.command, launch.args, {
			cwd: launch.cwd,
			env: {
				...process.env,
				OPUS_STATIC: "1",
				LIBOPUS_STATIC: "1",
				OPUS_NO_PKG: "1",
				LIBOPUS_NO_PKG: "1",
				OPUS_NO_PKG_CONFIG: "1",
				CMAKE_POLICY_VERSION_MINIMUM: "3.5",
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;
		child.stdout.on("data", (data: Buffer) => this.processStdoutChunk(data));
		child.stderr.on("data", (data: Buffer) => this.processStderrChunk(data, options.log));
		child.stderr.once("end", () => this.flushStderrBuffer(options.log));
		child.once("exit", (code, signal) => {
			this.flushStderrBuffer(options.log);
			if (!this.destroyed) this.emit("crashed", { code, signal });
		});
		this.setupAdapterProxy();

		await new Promise<void>((resolveReady, reject) => {
			const timer = setTimeout(() => {
				void this.destroy();
				reject(new Error(`clankvox ready timeout after ${options.timeoutMs ?? 15_000}ms`));
			}, options.timeoutMs ?? 15_000);
			this.once("ready", () => {
				clearTimeout(timer);
				resolveReady();
			});
			this.once("crashed", (event) => {
				clearTimeout(timer);
				reject(new Error(`clankvox crashed before ready: ${JSON.stringify(event)}`));
			});
			this.send({
				type: "join",
				guildId: this.guildId,
				channelId: this.channelId,
				selfDeaf: options.selfDeaf ?? false,
				selfMute: options.selfMute ?? false,
			});
		});
	}

	private setupAdapterProxy(): void {
		this.adapterProxy = createClankvoxVoiceAdapterProxy(this.guild, {
			onVoiceServerUpdate: (data) => this.send({ type: "voice_server", data }),
			onVoiceStateUpdate: (data) => {
				this.lastVoiceSessionId = stringValue(data.session_id) || undefined;
				this.lastVoiceStateUserId = stringValue(data.user_id) || undefined;
				this.send({ type: "voice_state", data });
			},
		});
	}

	private processStdoutChunk(data: Buffer): void {
		this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, data]);
		while (this.stdoutBuffer.length >= 5) {
			const format = this.stdoutBuffer.readUInt8(0);
			const length = this.stdoutBuffer.readUInt32LE(1);
			if (this.stdoutBuffer.length < 5 + length) return;
			const payload = this.stdoutBuffer.subarray(5, 5 + length);
			this.stdoutBuffer = this.stdoutBuffer.subarray(5 + length);
			if (format === 0) {
				this.handleJsonMessage(payload);
			} else if (format === 1) {
				this.handleBinaryAudio(payload);
			}
		}
	}

	private processStderrChunk(data: Buffer, log: ((line: string) => void) | undefined): void {
		if (log === undefined) return;
		this.stderrBuffer += data.toString("utf8");
		const lines = this.stderrBuffer.split(/\r?\n/);
		this.stderrBuffer = lines.pop() ?? "";
		for (const line of lines) {
			const trimmed = line.trimEnd();
			if (trimmed.length > 0) log(trimmed);
		}
	}

	private flushStderrBuffer(log: ((line: string) => void) | undefined): void {
		if (log === undefined || this.stderrBuffer.length === 0) {
			this.stderrBuffer = "";
			return;
		}
		const line = this.stderrBuffer.trimEnd();
		this.stderrBuffer = "";
		if (line.length > 0) log(line);
	}

	private handleJsonMessage(payload: Buffer): void {
		const msg = parseJsonRecord(payload);
		if (msg === undefined) return;
		const type = stringValue(msg.type);
		if (type === "ready") {
			this.emit("ready");
			return;
		}
		if (type === "adapter_send" && isRecord(msg.payload)) {
			this.forwardToGateway(msg.payload);
			return;
		}
		if (type === "speaking_start") {
			const userId = stringValue(msg.userId);
			if (userId.length > 0) this.emit("speakingStart", userId);
			return;
		}
		if (type === "speaking_end") {
			const userId = stringValue(msg.userId);
			if (userId.length > 0) this.emit("speakingEnd", userId);
			return;
		}
		if (type === "user_audio_end") {
			const userId = stringValue(msg.userId);
			if (userId.length > 0) this.emit("userAudioEnd", userId);
			return;
		}
		if (type === "user_audio") {
			const userId = stringValue(msg.userId);
			const pcmBase64 = stringValue(msg.pcmBase64);
			if (userId.length > 0 && pcmBase64.length > 0) {
				this.emit("userAudio", userId, Buffer.from(pcmBase64, "base64"));
			}
			return;
		}
		if (type === "decoded_video_frame") {
			const frame = parseDecodedVideoFrame(msg);
			if (frame !== undefined) this.emit("decodedVideoFrame", frame);
			return;
		}
		if (type === "transport_state") {
			const state = parseTransportState(msg);
			if (state !== undefined) this.emit("transportState", state);
			return;
		}
		if (type === "player_state") {
			const status = stringValue(msg.status).trim();
			if (status.length > 0) this.emit("playerState", status);
			return;
		}
		if (type === "music_idle") {
			this.emit("musicIdle");
			return;
		}
		if (type === "music_error") {
			this.emit("musicError", stringValue(msg.message).trim());
			return;
		}
		if (type === "music_gain_reached") {
			const gain = numberValue(msg.gain);
			if (gain !== undefined) this.emit("musicGainReached", gain);
			return;
		}
		if (type === "buffer_depth") {
			this.emit("bufferDepth", numberValue(msg.ttsSamples) ?? 0, numberValue(msg.musicSamples) ?? 0);
			return;
		}
		if (type === "error") {
			this.emit("ipcError", msg);
		}
	}

	private handleBinaryAudio(payload: Buffer): void {
		if (payload.length < 18) return;
		const userId = payload.readBigUInt64LE(0).toString();
		this.emit("userAudio", userId, payload.subarray(18));
	}

	private forwardToGateway(payload: JsonRecord): void {
		this.adapterProxy?.send(payload);
	}

	private forwardVoiceStateUpdate(channelId: string | null): void {
		this.forwardToGateway({
			op: 4,
			d: {
				guild_id: this.guildId,
				channel_id: channelId,
				self_mute: false,
				self_deaf: false,
			},
		});
	}

	private send(command: ClankvoxCommand): void {
		const child = this.child;
		if (child === undefined || child.stdin.destroyed || child.exitCode !== null) return;
		child.stdin.write(`${JSON.stringify(command)}\n`);
	}
}

export function createClankvoxVoiceAdapterProxy(
	guild: ClankvoxGuildLike,
	callbacks: {
		onVoiceServerUpdate(data: JsonRecord): void;
		onVoiceStateUpdate(data: JsonRecord): void;
	},
): ClankvoxVoiceAdapterProxy {
	const adapter = guild.voiceAdapterCreator?.(callbacks) ?? undefined;
	return {
		send(payload) {
			if (adapter?.sendPayload !== undefined) return adapter.sendPayload(payload);
			if (guild.shard === undefined) return false;
			guild.shard.send(payload);
			return true;
		},
		destroy() {
			adapter?.destroy?.();
		},
	};
}

function resolveLaunch(options: ClankvoxLaunchOptions): { command: string; args: string[]; cwd: string } {
	if (options.bin !== undefined && options.bin.trim().length > 0) {
		return { command: options.bin.trim(), args: options.args ?? [], cwd: resolve(options.cwd ?? process.cwd()) };
	}

	const cwd = resolve(options.cwd ?? defaultClankvoxDir());
	const binName = process.platform === "win32" ? "clankvox.exe" : "clankvox";
	const releaseBin = join(cwd, "target", "release", binName);
	if (existsSync(releaseBin)) return { command: releaseBin, args: [], cwd };
	if (!existsSync(cwd)) {
		throw new Error(`clankvox directory not found: ${cwd}. Set CLANKY_CLANKVOX_DIR or CLANKY_CLANKVOX_BIN.`);
	}
	return { command: "cargo", args: ["run", "--release", "--locked"], cwd };
}

function defaultClankvoxDir(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	return join(here, "clankvox");
}

function normalizeSampleRate(value: number): number {
	return Math.max(8_000, Math.floor(Number(value) || 24_000));
}

function nullableCommandString(value: string | null | undefined): string | null {
	const normalized = value?.trim();
	return normalized !== undefined && normalized.length > 0 ? normalized : null;
}

function normalizeVisualizerMode(value: string): string {
	const normalized = value.trim().toLowerCase();
	if (normalized === "spectrum" || normalized === "waves" || normalized === "vectorscope") return normalized;
	return "cqt";
}

function parseJsonRecord(payload: Buffer): JsonRecord | undefined {
	try {
		const value = JSON.parse(payload.toString("utf8"));
		if (isRecord(value)) return value;
		return undefined;
	} catch {
		return undefined;
	}
}

function parseDecodedVideoFrame(value: JsonRecord): ClankvoxDecodedVideoFrame | undefined {
	const userId = stringValue(value.userId);
	const ssrc = numberValue(value.ssrc);
	const width = numberValue(value.width);
	const height = numberValue(value.height);
	const jpegBase64 = stringValue(value.jpegBase64);
	const rtpTimestamp = numberValue(value.rtpTimestamp);
	if (userId.length === 0 || ssrc === undefined || width === undefined || height === undefined) return undefined;
	if (jpegBase64.length === 0 || rtpTimestamp === undefined) return undefined;
	return {
		userId,
		ssrc,
		width,
		height,
		jpegBase64,
		rtpTimestamp,
		streamType: nullableString(value.streamType),
		rid: nullableString(value.rid),
	};
}

function parseTransportState(value: JsonRecord): ClankvoxTransportState | undefined {
	const role = stringValue(value.role).trim();
	const status = stringValue(value.status).trim();
	if (role.length === 0 || status.length === 0) return undefined;
	return {
		role,
		status,
		reason: nullableString(value.reason),
	};
}

function isRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
	const text = stringValue(value).trim();
	return text.length > 0 ? text : null;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
