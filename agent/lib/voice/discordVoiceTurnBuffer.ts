type TimerHandle = ReturnType<typeof setTimeout>;

export interface DiscordVoiceTurnBufferOptions {
	flushDelayMs?: number;
	mixAudio?: boolean;
	subscribeUser(userId: string): void;
	appendInputAudio(userId: string, pcm: Buffer): void;
	commitInputAudioBuffer(): void;
	createAudioResponse(): void;
	onError?(error: unknown): void;
	setTimer?(callback: () => void, delayMs: number): TimerHandle;
	clearTimer?(handle: TimerHandle): void;
}

export interface DiscordVoiceTurnBufferStatus {
	activeSpeakers: string[];
	hasPendingAudio: boolean;
	hasScheduledFlush: boolean;
}

const DEFAULT_FLUSH_DELAY_MS = 350;

export class DiscordVoiceTurnBuffer {
	private readonly flushDelayMs: number;
	private readonly subscribeUser: (userId: string) => void;
	private readonly appendInputAudio: (userId: string, pcm: Buffer) => void;
	private readonly commitInputAudioBuffer: () => void;
	private readonly createAudioResponse: () => void;
	private readonly mixAudio: boolean;
	private readonly onError: ((error: unknown) => void) | undefined;
	private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
	private readonly clearTimer: (handle: TimerHandle) => void;
	private readonly activeSpeakers = new Set<string>();
	private readonly queuedAudioByUser = new Map<string, Buffer[]>();
	private pendingFlush: TimerHandle | undefined;
	private audioDrainScheduled = false;
	private hasPendingAudio = false;
	private disposed = false;

	constructor(options: DiscordVoiceTurnBufferOptions) {
		this.flushDelayMs = Math.max(0, Math.floor(options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS));
		this.mixAudio = options.mixAudio === true;
		this.subscribeUser = options.subscribeUser;
		this.appendInputAudio = options.appendInputAudio;
		this.commitInputAudioBuffer = options.commitInputAudioBuffer;
		this.createAudioResponse = options.createAudioResponse;
		this.onError = options.onError;
		this.setTimer = options.setTimer ?? setTimeout;
		this.clearTimer = options.clearTimer ?? clearTimeout;
	}

	speakingStart(userId: string): void {
		const normalizedUserId = normalizeUserId(userId);
		if (this.disposed || normalizedUserId.length === 0) return;
		this.activeSpeakers.add(normalizedUserId);
		this.clearPendingFlush();
		this.safeCall(() => this.subscribeUser(normalizedUserId));
	}

	speakingEnd(userId: string): void {
		const normalizedUserId = normalizeUserId(userId);
		if (this.disposed || normalizedUserId.length === 0) return;
		this.activeSpeakers.delete(normalizedUserId);
		this.scheduleFlushIfIdle();
	}

	userAudio(userId: string, pcm: Buffer): void {
		const normalizedUserId = normalizeUserId(userId);
		if (this.disposed || normalizedUserId.length === 0 || pcm.length === 0) return;
		this.hasPendingAudio = true;
		if (!this.mixAudio) {
			this.safeCall(() => this.appendInputAudio(normalizedUserId, pcm));
			return;
		}
		const queued = this.queuedAudioByUser.get(normalizedUserId) ?? [];
		queued.push(pcm);
		this.queuedAudioByUser.set(normalizedUserId, queued);
		this.scheduleAudioDrain();
	}

	userAudioEnd(userId: string): void {
		const normalizedUserId = normalizeUserId(userId);
		if (this.disposed || normalizedUserId.length === 0) return;
		this.activeSpeakers.delete(normalizedUserId);
		this.scheduleFlushIfIdle();
	}

	flushNow(): void {
		if (this.disposed || !this.hasPendingAudio) return;
		this.clearPendingFlush();
		this.drainQueuedAudio();
		this.hasPendingAudio = false;
		this.safeCall(() => {
			this.commitInputAudioBuffer();
			this.createAudioResponse();
		});
	}

	dispose(): void {
		this.disposed = true;
		this.clearPendingFlush();
		this.activeSpeakers.clear();
		this.queuedAudioByUser.clear();
		this.audioDrainScheduled = false;
		this.hasPendingAudio = false;
	}

	status(): DiscordVoiceTurnBufferStatus {
		return {
			activeSpeakers: [...this.activeSpeakers].sort(),
			hasPendingAudio: this.hasPendingAudio,
			hasScheduledFlush: this.pendingFlush !== undefined,
		};
	}

	private scheduleFlushIfIdle(): void {
		if (this.activeSpeakers.size > 0 || !this.hasPendingAudio || this.pendingFlush !== undefined) return;
		this.pendingFlush = this.setTimer(() => {
			this.pendingFlush = undefined;
			if (this.activeSpeakers.size === 0) this.flushNow();
		}, this.flushDelayMs);
	}

	private clearPendingFlush(): void {
		const pending = this.pendingFlush;
		if (pending === undefined) return;
		this.pendingFlush = undefined;
		this.clearTimer(pending);
	}

	private scheduleAudioDrain(): void {
		if (this.audioDrainScheduled) return;
		this.audioDrainScheduled = true;
		queueMicrotask(() => {
			this.audioDrainScheduled = false;
			if (!this.disposed) this.drainQueuedAudio();
		});
	}

	private drainQueuedAudio(): void {
		if (this.queuedAudioByUser.size === 0) return;
		const queued = [...this.queuedAudioByUser.entries()]
			.map(([userId, frames]) => {
				const pcm = frames.length === 1 ? frames[0] : Buffer.concat(frames);
				return pcm === undefined || pcm.length === 0 ? undefined : { userId, pcm };
			})
			.filter((entry): entry is { userId: string; pcm: Buffer } => entry !== undefined);
		this.queuedAudioByUser.clear();
		if (queued.length === 0) return;
		if (queued.length === 1) {
			const entry = queued[0];
			if (entry === undefined) return;
			this.safeCall(() => this.appendInputAudio(entry.userId, entry.pcm));
			return;
		}
		const mixed = mixPcm16MonoFrames(queued.map((entry) => entry.pcm));
		if (mixed.length > 0) this.safeCall(() => this.appendInputAudio("mixed", mixed));
	}

	private safeCall(fn: () => void): void {
		try {
			fn();
		} catch (error) {
			this.onError?.(error);
		}
	}
}

function normalizeUserId(userId: string): string {
	return userId.trim();
}

export function mixPcm16MonoFrames(frames: Buffer[]): Buffer {
	const usableFrames = frames.filter((frame) => frame.length >= 2);
	if (usableFrames.length === 0) return Buffer.alloc(0);
	if (usableFrames.length === 1) return usableFrames[0] ?? Buffer.alloc(0);
	const maxSamples = Math.max(...usableFrames.map((frame) => Math.floor(frame.length / 2)));
	const mixed = Buffer.alloc(maxSamples * 2);
	for (let sampleIndex = 0; sampleIndex < maxSamples; sampleIndex += 1) {
		let sample = 0;
		for (const frame of usableFrames) {
			const offset = sampleIndex * 2;
			if (offset + 1 < frame.length) sample += frame.readInt16LE(offset);
		}
		mixed.writeInt16LE(clampPcm16(sample), sampleIndex * 2);
	}
	return mixed;
}

function clampPcm16(value: number): number {
	return Math.max(-32_768, Math.min(32_767, value));
}
