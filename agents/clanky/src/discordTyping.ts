import type { DiscordInboundConversation } from "./agentDiscordGateway.ts";

export interface DiscordTypingSender {
	sendTyping?(input: { conversation: DiscordInboundConversation }): Promise<void>;
}

export interface DiscordTypingIndicatorOptions {
	refreshMs?: number;
	onError?: (error: unknown) => void;
}

const DEFAULT_DISCORD_TYPING_REFRESH_MS = 8000;

export function startDiscordTypingIndicator(
	provider: DiscordTypingSender,
	conversation: DiscordInboundConversation,
	options: DiscordTypingIndicatorOptions = {},
): () => void {
	if (provider.sendTyping === undefined) return () => undefined;
	const refreshMs = options.refreshMs ?? DEFAULT_DISCORD_TYPING_REFRESH_MS;
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

export async function withDiscordTypingIndicator<T>(
	provider: DiscordTypingSender,
	conversation: DiscordInboundConversation,
	task: () => Promise<T>,
	options: DiscordTypingIndicatorOptions = {},
): Promise<T> {
	const stopTyping = startDiscordTypingIndicator(provider, conversation, options);
	try {
		return await task();
	} finally {
		stopTyping();
	}
}
