import type { AgentSessionRuntime, PromptOptions } from "@earendil-works/pi-coding-agent";

export interface RuntimeTurnQueue {
	isBusy(): boolean;
	enqueue<T>(task: () => Promise<T>): Promise<T>;
	cancelPending(reason?: string): RuntimeTurnQueueCancelResult;
	enqueuePrompt(
		runtime: AgentSessionRuntime,
		prompt: string,
		options?: RuntimeTurnQueuePromptOptions,
	): Promise<RuntimeTurnQueuePromptResult>;
}

export interface RuntimeTurnQueueCancelResult {
	active: number;
	queued: number;
	cancelled: number;
	reason: string;
}

export interface RuntimeTurnQueuePromptResult {
	mode: "followUp" | "start";
	sessionId: string;
}

export interface RuntimeTurnQueuePromptOptions {
	beforePrompt?: () => void;
	images?: PromptOptions["images"];
}

export class RuntimeTurnQueueCancelledError extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "RuntimeTurnQueueCancelledError";
	}
}

export class SerialRuntimeTurnQueue implements RuntimeTurnQueue {
	private tail: Promise<void> = Promise.resolve();
	private pending = 0;
	private active = 0;
	private cancelGeneration = 0;
	private cancelReason = "runtime turn queue cancelled";

	isBusy(): boolean {
		return this.pending > 0;
	}

	cancelPending(reason = "runtime turn queue cancelled"): RuntimeTurnQueueCancelResult {
		const queued = Math.max(0, this.pending - this.active);
		if (queued > 0) {
			this.cancelGeneration += 1;
			this.cancelReason = reason;
		}
		return {
			active: this.active,
			queued,
			cancelled: queued,
			reason,
		};
	}

	enqueue<T>(task: () => Promise<T>): Promise<T> {
		this.pending += 1;
		const generation = this.cancelGeneration;
		const run = this.tail.then(async () => {
			try {
				if (generation !== this.cancelGeneration) throw new RuntimeTurnQueueCancelledError(this.cancelReason);
				this.active += 1;
				try {
					return await task();
				} finally {
					this.active -= 1;
				}
			} finally {
				this.pending -= 1;
			}
		});
		this.tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	enqueuePrompt(
		runtime: AgentSessionRuntime,
		prompt: string,
		options?: RuntimeTurnQueuePromptOptions,
	): Promise<RuntimeTurnQueuePromptResult> {
		return this.enqueue(async () => {
			options?.beforePrompt?.();
			const session = runtime.session;
			const mode = session.isStreaming ? "followUp" : "start";
			await session.prompt(prompt, {
				source: "extension",
				streamingBehavior: "followUp",
				...(options?.images === undefined ? {} : { images: options.images }),
			});
			return { mode, sessionId: session.sessionId };
		});
	}
}
