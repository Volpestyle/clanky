import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";

export interface RuntimeTurnQueue {
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
}

export class SerialRuntimeTurnQueue implements RuntimeTurnQueue {
	private tail: Promise<void> = Promise.resolve();

	enqueue<T>(task: () => Promise<T>): Promise<T> {
		const run = this.tail.then(task);
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
			await session.prompt(prompt, { source: "extension", streamingBehavior: "followUp" });
			return { mode, sessionId: session.sessionId };
		});
	}
}
