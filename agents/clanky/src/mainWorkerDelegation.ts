import type { DelegateToMainWorkerToolInput } from "@clanky/core";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { RuntimeTurnQueue } from "./runtimeTurnQueue.ts";

export interface DelegateToMainWorkerOptions {
	runtime: AgentSessionRuntime | undefined;
	runtimeTurnQueue: RuntimeTurnQueue;
	log?: (line: string) => void;
	now?: () => Date;
}

export interface DelegateToMainWorkerResult {
	delegated: boolean;
	sessionId?: string;
	mode?: "followUp" | "start";
	autoPrompt?: boolean;
	title: string;
	queuedAt: string;
	reason?: string;
	error?: string;
}

export function delegateToMainWorker(
	input: DelegateToMainWorkerToolInput,
	options: DelegateToMainWorkerOptions,
): DelegateToMainWorkerResult {
	const title = input.title.trim();
	const prompt = input.prompt.trim();
	if (title.length === 0) throw new Error("delegate_to_main_worker requires a non-empty title.");
	if (prompt.length === 0) throw new Error("delegate_to_main_worker requires a non-empty prompt.");
	const queuedAt = (options.now ?? (() => new Date()))().toISOString();
	const runtime = options.runtime;
	if (runtime === undefined) {
		return {
			delegated: false,
			title,
			queuedAt,
			error: "main Clanky runtime is not bound",
		};
	}
	const wasStreaming = runtime.session.isStreaming;
	const mode = wasStreaming ? "followUp" : "start";
	const handoffPrompt = formatMainWorkerDelegationPrompt({ ...input, title, prompt }, queuedAt);
	void options.runtimeTurnQueue.enqueuePrompt(runtime, handoffPrompt).catch((error: unknown) => {
		const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
		options.log?.(`delegate-to-main-worker failed title=${JSON.stringify(title)} error=${message}`);
	});
	return {
		delegated: true,
		sessionId: runtime.session.sessionId,
		mode,
		autoPrompt: true,
		title,
		queuedAt,
		...(input.reason === undefined ? {} : { reason: input.reason }),
	};
}

function formatMainWorkerDelegationPrompt(input: DelegateToMainWorkerToolInput, queuedAt: string): string {
	return [
		"Discord subagent delegated work to main Clanky.",
		"",
		`Title: ${input.title.trim()}`,
		`Queued at: ${queuedAt}`,
		...(input.source === undefined ? [] : [`Source: ${input.source.trim()}`]),
		...(input.reason === undefined ? [] : [`Reason: ${input.reason.trim()}`]),
		"",
		"The Discord subagent should stay free for short replies. Take over this work if it is appropriate.",
		"",
		"Task:",
		input.prompt.trim(),
	].join("\n");
}
