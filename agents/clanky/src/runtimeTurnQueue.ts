import type { AgentSessionRuntime, PromptOptions } from "@earendil-works/pi-coding-agent";

export interface RuntimeTurnQueue {
	isBusy(): boolean;
	enqueue<T>(task: () => Promise<T>): Promise<T>;
	enqueuePrompt(
		runtime: AgentSessionRuntime,
		prompt: string,
		options?: RuntimeTurnQueuePromptOptions,
	): Promise<RuntimeTurnQueuePromptResult>;
}

export interface RuntimeTurnQueuePromptResult {
	mode: "followUp" | "start";
	sessionId: string;
}

export interface RuntimeTurnQueuePromptOptions {
	beforePrompt?: () => void;
	images?: PromptOptions["images"];
}

export class SerialRuntimeTurnQueue implements RuntimeTurnQueue {
	private tail: Promise<void> = Promise.resolve();
	private pending = 0;

	isBusy(): boolean {
		return this.pending > 0;
	}

	enqueue<T>(task: () => Promise<T>): Promise<T> {
		this.pending += 1;
		const run = this.tail.then(async () => {
			try {
				return await task();
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
