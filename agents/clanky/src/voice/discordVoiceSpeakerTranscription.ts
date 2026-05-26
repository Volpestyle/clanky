import type {
	OpenAiRealtimeClientOptions,
	OpenAiRealtimeTranscript,
	OpenAiRealtimeTranscriptionConnectOptions,
} from "./openAiRealtimeClient.ts";

type JsonRecord = Record<string, unknown>;
type TimerHandle = ReturnType<typeof setTimeout>;

export interface DiscordVoiceSpeakerTranscript extends OpenAiRealtimeTranscript {
	userId: string;
}

export interface DiscordVoiceSpeakerTranscriptionStatus {
	activeSpeakers: string[];
	sessionCount: number;
	connectingSessionCount: number;
	bufferedAudioBytes: number;
	pendingCommitCount: number;
}

export interface DiscordVoiceSpeakerTranscriptionRealtime {
	connect(options: OpenAiRealtimeTranscriptionConnectOptions): Promise<void>;
	appendInputAudioPcm(audio: Buffer): void;
	commitInputAudioBuffer(): void;
	close(): Promise<void>;
	on(event: "transcript", listener: (transcript: OpenAiRealtimeTranscript) => void): unknown;
	on(event: "event" | "error_event", listener: (event: JsonRecord) => void): unknown;
	on(event: "socket_closed", listener: (event: JsonRecord) => void): unknown;
	on(event: "socket_error", listener: (error: Error) => void): unknown;
}

export interface DiscordVoiceSpeakerTranscriptionManagerOptions {
	realtimeOptions: OpenAiRealtimeClientOptions;
	connectOptions: OpenAiRealtimeTranscriptionConnectOptions;
	createRealtime(options: OpenAiRealtimeClientOptions): DiscordVoiceSpeakerTranscriptionRealtime;
	subscribeUser(userId: string, silenceDurationMs: number, sampleRate: number): void;
	onTranscript(transcript: DiscordVoiceSpeakerTranscript): void;
	onEvent?(userId: string, event: JsonRecord): void;
	onError?(userId: string, error: unknown): void;
	onSocketClosed?(userId: string, event: JsonRecord): void;
	silenceDurationMs?: number;
	sampleRate?: number;
	idleCloseMs?: number;
	setTimer?(callback: () => void, delayMs: number): TimerHandle;
	clearTimer?(handle: TimerHandle): void;
}

interface SpeakerSession {
	userId: string;
	realtime: DiscordVoiceSpeakerTranscriptionRealtime;
	connecting: Promise<void>;
	connected: boolean;
	pendingAudio: Buffer[];
	draining: Promise<void> | undefined;
	commitRequested: boolean;
	active: boolean;
	closed: boolean;
	idleTimer: TimerHandle | undefined;
}

const DEFAULT_SILENCE_DURATION_MS = 700;
const DEFAULT_SAMPLE_RATE = 24_000;
const DEFAULT_IDLE_CLOSE_MS = 120_000;

export class DiscordVoiceSpeakerTranscriptionManager {
	private readonly realtimeOptions: OpenAiRealtimeClientOptions;
	private readonly connectOptions: OpenAiRealtimeTranscriptionConnectOptions;
	private readonly createRealtime: (options: OpenAiRealtimeClientOptions) => DiscordVoiceSpeakerTranscriptionRealtime;
	private readonly subscribeUser: (userId: string, silenceDurationMs: number, sampleRate: number) => void;
	private readonly onTranscript: (transcript: DiscordVoiceSpeakerTranscript) => void;
	private readonly onEvent: ((userId: string, event: JsonRecord) => void) | undefined;
	private readonly onError: ((userId: string, error: unknown) => void) | undefined;
	private readonly onSocketClosed: ((userId: string, event: JsonRecord) => void) | undefined;
	private readonly silenceDurationMs: number;
	private readonly sampleRate: number;
	private readonly idleCloseMs: number;
	private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
	private readonly clearTimer: (handle: TimerHandle) => void;
	private readonly sessions = new Map<string, SpeakerSession>();
	private disposed = false;

	constructor(options: DiscordVoiceSpeakerTranscriptionManagerOptions) {
		this.realtimeOptions = options.realtimeOptions;
		this.connectOptions = {
			...options.connectOptions,
			sampleRate: normalizeSampleRate(options.connectOptions.sampleRate ?? options.sampleRate),
		};
		this.createRealtime = options.createRealtime;
		this.subscribeUser = options.subscribeUser;
		this.onTranscript = options.onTranscript;
		this.onEvent = options.onEvent;
		this.onError = options.onError;
		this.onSocketClosed = options.onSocketClosed;
		this.silenceDurationMs = normalizeDuration(options.silenceDurationMs, DEFAULT_SILENCE_DURATION_MS, 100, 5_000);
		this.sampleRate = normalizeSampleRate(options.sampleRate);
		this.idleCloseMs = normalizeDuration(options.idleCloseMs, DEFAULT_IDLE_CLOSE_MS, 1_000, 10 * 60_000);
		this.setTimer = options.setTimer ?? setTimeout;
		this.clearTimer = options.clearTimer ?? clearTimeout;
	}

	speakingStart(userId: string): void {
		const normalizedUserId = normalizeUserId(userId);
		if (this.disposed || normalizedUserId.length === 0) return;
		this.subscribeUser(normalizedUserId, this.silenceDurationMs, this.sampleRate);
		const session = this.ensureSession(normalizedUserId);
		session.active = true;
		this.clearIdleTimer(session);
	}

	speakingEnd(userId: string): void {
		const session = this.sessions.get(normalizeUserId(userId));
		if (session === undefined || this.disposed) return;
		session.active = false;
		if (!session.commitRequested && session.pendingAudio.length === 0) this.scheduleIdleClose(session);
	}

	userAudio(userId: string, pcm: Buffer): void {
		const normalizedUserId = normalizeUserId(userId);
		if (this.disposed || normalizedUserId.length === 0 || pcm.length === 0) return;
		const session = this.ensureSession(normalizedUserId);
		session.pendingAudio.push(pcm);
		session.active = true;
		this.clearIdleTimer(session);
		this.pump(session);
	}

	userAudioEnd(userId: string): void {
		const session = this.sessions.get(normalizeUserId(userId));
		if (session === undefined || this.disposed) return;
		session.active = false;
		session.commitRequested = true;
		this.pump(session);
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		const sessions = [...this.sessions.values()];
		this.sessions.clear();
		await Promise.all(
			sessions.map(async (session) => {
				this.clearIdleTimer(session);
				session.closed = true;
				await session.realtime.close().catch(() => undefined);
			}),
		);
	}

	status(): DiscordVoiceSpeakerTranscriptionStatus {
		let connectingSessionCount = 0;
		let bufferedAudioBytes = 0;
		let pendingCommitCount = 0;
		for (const session of this.sessions.values()) {
			if (!session.connected) connectingSessionCount += 1;
			bufferedAudioBytes += session.pendingAudio.reduce((total, audio) => total + audio.length, 0);
			if (session.commitRequested) pendingCommitCount += 1;
		}
		return {
			activeSpeakers: [...this.sessions.values()]
				.filter((session) => session.active)
				.map((session) => session.userId)
				.sort(),
			sessionCount: this.sessions.size,
			connectingSessionCount,
			bufferedAudioBytes,
			pendingCommitCount,
		};
	}

	private ensureSession(userId: string): SpeakerSession {
		const existing = this.sessions.get(userId);
		if (existing !== undefined) return existing;

		const realtime = this.createRealtime(this.realtimeOptions);
		const connecting = realtime.connect(this.connectOptions);
		const session: SpeakerSession = {
			userId,
			realtime,
			connecting,
			connected: false,
			pendingAudio: [],
			draining: undefined,
			commitRequested: false,
			active: false,
			closed: false,
			idleTimer: undefined,
		};
		this.bindSession(session);
		this.sessions.set(userId, session);
		return session;
	}

	private bindSession(session: SpeakerSession): void {
		session.realtime.on("transcript", (transcript) => {
			this.onTranscript({ ...transcript, userId: session.userId });
		});
		session.realtime.on("event", (event) => {
			this.onEvent?.(session.userId, event);
		});
		session.realtime.on("error_event", (event) => {
			this.onEvent?.(session.userId, event);
			this.onError?.(session.userId, event);
		});
		session.realtime.on("socket_error", (error) => {
			this.onError?.(session.userId, error);
		});
		session.realtime.on("socket_closed", (event) => {
			this.onSocketClosed?.(session.userId, event);
			if (!this.disposed && this.sessions.get(session.userId) === session) {
				this.sessions.delete(session.userId);
			}
		});
	}

	private pump(session: SpeakerSession): void {
		if (session.draining !== undefined) return;
		session.draining = this.drain(session).finally(() => {
			session.draining = undefined;
			if (session.pendingAudio.length > 0 || session.commitRequested) this.pump(session);
		});
	}

	private async drain(session: SpeakerSession): Promise<void> {
		try {
			await session.connecting;
			session.connected = true;
			while (!session.closed && session.pendingAudio.length > 0) {
				const audio = session.pendingAudio.shift();
				if (audio !== undefined) session.realtime.appendInputAudioPcm(audio);
			}
			if (!session.closed && session.commitRequested) {
				session.commitRequested = false;
				session.realtime.commitInputAudioBuffer();
				if (!session.active) this.scheduleIdleClose(session);
			}
		} catch (error) {
			this.onError?.(session.userId, error);
			this.sessions.delete(session.userId);
			session.closed = true;
			await session.realtime.close().catch(() => undefined);
		}
	}

	private scheduleIdleClose(session: SpeakerSession): void {
		this.clearIdleTimer(session);
		if (session.closed || session.active) return;
		session.idleTimer = this.setTimer(() => {
			session.idleTimer = undefined;
			this.closeIdleSession(session);
		}, this.idleCloseMs);
	}

	private closeIdleSession(session: SpeakerSession): void {
		if (this.sessions.get(session.userId) !== session || session.active || session.closed) return;
		this.sessions.delete(session.userId);
		session.closed = true;
		void session.realtime.close().catch((error: unknown) => this.onError?.(session.userId, error));
	}

	private clearIdleTimer(session: SpeakerSession): void {
		const timer = session.idleTimer;
		if (timer === undefined) return;
		session.idleTimer = undefined;
		this.clearTimer(timer);
	}
}

function normalizeUserId(userId: string): string {
	return userId.trim();
}

function normalizeSampleRate(value: number | undefined): number {
	return Math.max(8_000, Math.min(48_000, Math.floor(Number(value) || DEFAULT_SAMPLE_RATE)));
}

function normalizeDuration(value: number | undefined, fallback: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Math.floor(Number(value) || fallback)));
}
