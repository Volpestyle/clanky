import type { AgentChatConversation } from "./agentChatGateway.ts";

export interface ChatTypingSender {
	sendTyping?(input: { conversation: AgentChatConversation }): Promise<void>;
}

export interface ChatTypingIndicatorOptions {
	refreshMs?: number;
	onError?: (error: unknown) => void;
}

const DEFAULT_CHAT_TYPING_REFRESH_MS = 8000;

export function startChatTypingIndicator(
	provider: ChatTypingSender,
	conversation: AgentChatConversation,
	options: ChatTypingIndicatorOptions = {},
): () => void {
	if (provider.sendTyping === undefined) return () => undefined;
	const refreshMs = options.refreshMs ?? DEFAULT_CHAT_TYPING_REFRESH_MS;
	let stopped = false;
	let reportedError = false;
	const sendTyping = (): void => {
		if (stopped) return;
		try {
			void provider.sendTyping?.({ conversation }).catch((error: unknown) => {
				if (reportedError) return;
				reportedError = true;
				options.onError?.(error);
			});
		} catch (error) {
			if (reportedError) return;
			reportedError = true;
			options.onError?.(error);
		}
	};
	sendTyping();
	const timer = setInterval(sendTyping, refreshMs);
	return () => {
		stopped = true;
		clearInterval(timer);
	};
}

export async function withChatTypingIndicator<T>(
	provider: ChatTypingSender,
	conversation: AgentChatConversation,
	task: () => Promise<T>,
	options: ChatTypingIndicatorOptions = {},
): Promise<T> {
	const stopTyping = startChatTypingIndicator(provider, conversation, options);
	try {
		return await task();
	} finally {
		stopTyping();
	}
}
