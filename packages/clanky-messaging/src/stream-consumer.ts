import type { BasePlatformAdapter } from "./adapter.ts";
import type { SendOptions, SendResult } from "./types.ts";

export interface StreamConsumerConfig {
	editIntervalMs: number;
	bufferThreshold: number;
	freshFinalAfterSeconds: number;
	cursor: string;
	floodBackoffMaxMs: number;
	floodMaxStrikes: number;
	finalDrainTimeoutMs: number;
}

export const DEFAULT_STREAM_CONSUMER_CONFIG: StreamConsumerConfig = {
	editIntervalMs: 1_000,
	bufferThreshold: 40,
	freshFinalAfterSeconds: 60,
	cursor: " ▍",
	floodBackoffMaxMs: 10_000,
	floodMaxStrikes: 3,
	finalDrainTimeoutMs: 5_000,
};

export type StreamConsumerCommand =
	| { type: "delta"; text: string }
	| { type: "segment_break" }
	| { type: "done" }
	| { type: "error"; message: string }
	| { type: "abort" };

export interface StreamConsumerResult {
	sentMessageIds: string[];
	finalText: string;
	totalChunks: number;
	floodFallback: boolean;
	durationMs: number;
}

interface FloodControlError extends Error {
	retryAfterMs?: number;
}

export function isFloodControlError(error: unknown): error is FloodControlError {
	if (!(error instanceof Error)) return false;
	const message = error.message.toLowerCase();
	return message.includes("flood") || message.includes("too many requests") || message.includes("429");
}

interface PendingMessageState {
	messageId: string | undefined;
	createdAt: number;
	lastSentText: string;
	cursorText: string;
}

export class StreamConsumer {
	private readonly adapter: BasePlatformAdapter;
	private readonly options: SendOptions;
	private readonly config: StreamConsumerConfig;
	private queue: StreamConsumerCommand[] = [];
	private waker: (() => void) | undefined;
	private finished = false;
	private aborted = false;
	private accumulated = "";
	private finalisedText = "";
	private sentMessageIds: string[] = [];
	private pending: PendingMessageState | undefined;
	private floodStrikes = 0;
	private currentEditIntervalMs: number;
	private floodFallback = false;
	private totalChunks = 0;
	private lastEditAt = 0;
	private startedAt = Date.now();

	constructor(adapter: BasePlatformAdapter, options: SendOptions, config: Partial<StreamConsumerConfig> = {}) {
		this.adapter = adapter;
		this.options = options;
		this.config = { ...DEFAULT_STREAM_CONSUMER_CONFIG, ...config };
		this.currentEditIntervalMs = this.config.editIntervalMs;
	}

	push(command: StreamConsumerCommand): void {
		if (this.finished) return;
		this.queue.push(command);
		this.wake();
	}

	delta(text: string): void {
		if (text.length === 0) return;
		this.push({ type: "delta", text });
	}

	segmentBreak(): void {
		this.push({ type: "segment_break" });
	}

	finish(): void {
		this.push({ type: "done" });
	}

	error(message: string): void {
		this.push({ type: "error", message });
	}

	abort(): void {
		this.aborted = true;
		this.push({ type: "abort" });
	}

	async run(): Promise<StreamConsumerResult> {
		while (!this.finished) {
			if (this.queue.length === 0) {
				await this.waitForWake();
				continue;
			}
			const command = this.queue.shift();
			if (command === undefined) continue;
			await this.handleCommand(command);
		}
		return {
			sentMessageIds: this.sentMessageIds,
			finalText: this.finalisedText.length > 0 ? this.finalisedText : this.accumulated,
			totalChunks: this.totalChunks,
			floodFallback: this.floodFallback,
			durationMs: Date.now() - this.startedAt,
		};
	}

	private wake(): void {
		const wake = this.waker;
		this.waker = undefined;
		if (wake !== undefined) wake();
	}

	private async waitForWake(): Promise<void> {
		await new Promise<void>((resolve) => {
			this.waker = resolve;
			setTimeout(
				() => {
					if (this.waker === resolve) {
						this.waker = undefined;
						resolve();
					}
				},
				Math.max(this.currentEditIntervalMs, 50),
			);
		});
	}

	private async handleCommand(command: StreamConsumerCommand): Promise<void> {
		if (command.type === "abort") {
			this.finalisedText = this.accumulated;
			this.finished = true;
			return;
		}
		if (command.type === "error") {
			this.finalisedText = this.accumulated;
			this.finished = true;
			return;
		}
		if (command.type === "done") {
			await this.flushFinal();
			this.finalisedText = this.accumulated;
			this.finished = true;
			return;
		}
		if (command.type === "segment_break") {
			await this.finalizeCurrentSegment();
			return;
		}
		this.accumulated += command.text;
		await this.maybeEdit();
	}

	private async maybeEdit(): Promise<void> {
		if (this.aborted || this.floodFallback) return;
		const now = Date.now();
		const elapsed = now - this.lastEditAt;
		const size = this.accumulated.length - (this.pending?.lastSentText.length ?? 0);
		const sizeReached = size >= this.config.bufferThreshold;
		const timeReached = elapsed >= this.currentEditIntervalMs;
		if (!sizeReached && !timeReached) return;
		await this.flushIncremental();
	}

	private async flushIncremental(): Promise<void> {
		const text = this.accumulated;
		if (text.length === 0) return;
		const cursorText = appendCursor(text, this.config.cursor);
		try {
			await this.writePendingChunk(cursorText, false);
			this.lastEditAt = Date.now();
			this.floodStrikes = 0;
			this.currentEditIntervalMs = this.config.editIntervalMs;
		} catch (error) {
			await this.handleSendError(error);
		}
	}

	private async finalizeCurrentSegment(): Promise<void> {
		if (this.accumulated.length === 0 && this.pending === undefined) return;
		const text = this.accumulated;
		if (text.length > 0) {
			try {
				await this.writePendingChunk(text, true);
			} catch (error) {
				await this.handleSendError(error);
				try {
					await this.writePendingChunk(text, true);
				} catch {
					// already in flood fallback or fatal; nothing more to do
				}
			}
		}
		this.pending = undefined;
		this.accumulated = "";
		this.lastEditAt = 0;
	}

	private async flushFinal(): Promise<void> {
		if (this.accumulated.length === 0 && this.pending === undefined) return;
		const elapsedSinceStart = (Date.now() - (this.pending?.createdAt ?? this.startedAt)) / 1000;
		const useFresh =
			this.pending !== undefined &&
			elapsedSinceStart > this.config.freshFinalAfterSeconds &&
			this.pending.messageId !== undefined;
		if (useFresh && this.pending?.messageId !== undefined && this.adapter.capabilities.supportsDeletion) {
			try {
				await this.adapter.deleteMessage(this.options.chatId, this.pending.messageId);
			} catch {
				// best effort
			}
			this.pending = undefined;
		}
		try {
			await this.writePendingChunk(this.accumulated, true);
		} catch (error) {
			await this.handleSendError(error);
			if (this.floodFallback) await this.flushFallback();
		}
	}

	private async writePendingChunk(text: string, finalize: boolean): Promise<void> {
		const chunks = this.adapter.splitForOverflow(text);
		if (chunks.length === 0) return;
		if (chunks.length === 1) {
			await this.writeSingleChunk(chunks[0] ?? "", finalize);
			return;
		}
		for (let index = 0; index < chunks.length; index += 1) {
			const chunk = chunks[index] ?? "";
			const isLast = index === chunks.length - 1;
			if (index === 0) await this.writeSingleChunk(chunk, isLast ? finalize : true);
			else await this.writeFreshChunk(chunk, isLast ? finalize : true);
		}
	}

	private async writeSingleChunk(text: string, finalize: boolean): Promise<void> {
		const formatted = this.adapter.formatMessage(text);
		if (this.pending?.messageId !== undefined && this.adapter.capabilities.supportsEditing) {
			if (this.pending.lastSentText === formatted) return;
			const result = await this.adapter.editMessage(formatted, {
				...this.options,
				messageId: this.pending.messageId,
			});
			this.pending.lastSentText = formatted;
			this.pending.cursorText = formatted;
			if (finalize) this.pending = undefined;
			this.totalChunks += 1;
			this.recordSent(result);
			return;
		}
		const result = await this.adapter.send(formatted, this.options);
		this.totalChunks += 1;
		this.recordSent(result);
		if (!finalize) {
			this.pending = {
				messageId: result.messageId === "" ? undefined : result.messageId,
				createdAt: Date.now(),
				lastSentText: formatted,
				cursorText: formatted,
			};
		} else {
			this.pending = undefined;
		}
	}

	private async writeFreshChunk(text: string, finalize: boolean): Promise<void> {
		const formatted = this.adapter.formatMessage(text);
		const result = await this.adapter.send(formatted, this.options);
		this.totalChunks += 1;
		this.recordSent(result);
		if (!finalize) {
			this.pending = {
				messageId: result.messageId === "" ? undefined : result.messageId,
				createdAt: Date.now(),
				lastSentText: formatted,
				cursorText: formatted,
			};
		} else {
			this.pending = undefined;
		}
	}

	private recordSent(result: SendResult): void {
		if (result.messageId !== "" && !this.sentMessageIds.includes(result.messageId)) {
			this.sentMessageIds.push(result.messageId);
		}
	}

	private async handleSendError(error: unknown): Promise<void> {
		if (!isFloodControlError(error)) {
			throw error;
		}
		this.floodStrikes += 1;
		const retryAfterMs = (error as FloodControlError).retryAfterMs;
		const nextInterval = Math.min(retryAfterMs ?? this.currentEditIntervalMs * 2, this.config.floodBackoffMaxMs);
		this.currentEditIntervalMs = Math.max(nextInterval, this.config.editIntervalMs);
		if (this.floodStrikes >= this.config.floodMaxStrikes) {
			this.floodFallback = true;
		}
	}

	private async flushFallback(): Promise<void> {
		const visiblePrefix = this.pending?.lastSentText ?? "";
		const continuation = this.accumulated.slice(visiblePrefix.length);
		if (continuation.length === 0) return;
		const chunkSize = Math.max(this.adapter.capabilities.maxMessageLength - 100, 200);
		let offset = 0;
		while (offset < continuation.length) {
			const chunk = continuation.slice(offset, offset + chunkSize);
			offset += chunkSize;
			try {
				const result = await this.adapter.send(this.adapter.formatMessage(chunk), this.options);
				this.totalChunks += 1;
				this.recordSent(result);
			} catch {
				await delay(3_000);
				try {
					const result = await this.adapter.send(this.adapter.formatMessage(chunk), this.options);
					this.totalChunks += 1;
					this.recordSent(result);
				} catch {
					// give up on this fragment but keep going
				}
			}
		}
	}
}

function appendCursor(text: string, cursor: string): string {
	if (text.length === 0) return cursor.trimStart();
	return `${text}${cursor}`;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
