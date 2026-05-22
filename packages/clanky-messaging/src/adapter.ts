import type {
	EditOptions,
	FatalErrorState,
	MediaAttachment,
	MessageEvent,
	Platform,
	PlatformCapabilities,
	SendMediaOptions,
	SendOptions,
	SendResult,
} from "./types.ts";

export type MessageHandler = (event: MessageEvent) => Promise<void> | void;
export type FatalErrorHandler = (adapter: BasePlatformAdapter) => Promise<void> | void;
export type ConnectionStateListener = (connected: boolean) => void;

export interface AdapterContext {
	transcribeAudio?: (mime: string, audio: Buffer) => Promise<string>;
	synthesizeSpeech?: (text: string) => Promise<{ data: Buffer; mime: string }>;
}

export abstract class BasePlatformAdapter {
	abstract readonly platform: Platform;
	abstract readonly capabilities: PlatformCapabilities;

	private messageHandler: MessageHandler | undefined;
	private fatalErrorHandler: FatalErrorHandler | undefined;
	private connectionListeners: ConnectionStateListener[] = [];
	private connected = false;
	private fatalError: FatalErrorState | undefined;
	private adapterContext: AdapterContext = {};

	setMessageHandler(handler: MessageHandler): void {
		this.messageHandler = handler;
	}

	setFatalErrorHandler(handler: FatalErrorHandler): void {
		this.fatalErrorHandler = handler;
	}

	setAdapterContext(context: AdapterContext): void {
		this.adapterContext = context;
	}

	addConnectionStateListener(listener: ConnectionStateListener): () => void {
		this.connectionListeners.push(listener);
		return () => {
			this.connectionListeners = this.connectionListeners.filter((other) => other !== listener);
		};
	}

	isConnected(): boolean {
		return this.connected;
	}

	hasFatalError(): boolean {
		return this.fatalError !== undefined;
	}

	getFatalError(): FatalErrorState | undefined {
		return this.fatalError;
	}

	protected getAdapterContext(): AdapterContext {
		return this.adapterContext;
	}

	protected markConnected(): void {
		if (this.connected) return;
		this.connected = true;
		for (const listener of this.connectionListeners) {
			try {
				listener(true);
			} catch {
				// listener errors are not fatal
			}
		}
	}

	protected markDisconnected(): void {
		if (!this.connected) return;
		this.connected = false;
		for (const listener of this.connectionListeners) {
			try {
				listener(false);
			} catch {
				// listener errors are not fatal
			}
		}
	}

	protected setFatalError(code: string, message: string, options: { retryable?: boolean } = {}): void {
		this.fatalError = {
			code,
			message,
			retryable: options.retryable ?? false,
			at: Date.now(),
		};
		void this.notifyFatalError();
	}

	protected clearFatalError(): void {
		this.fatalError = undefined;
	}

	protected async dispatchMessage(event: MessageEvent): Promise<void> {
		const handler = this.messageHandler;
		if (handler === undefined) return;
		await handler(event);
	}

	private async notifyFatalError(): Promise<void> {
		const handler = this.fatalErrorHandler;
		if (handler === undefined) return;
		try {
			await handler(this);
		} catch {
			// fatal error handler errors are swallowed
		}
	}

	abstract connect(): Promise<boolean>;
	abstract disconnect(): Promise<void>;

	abstract send(text: string, options: SendOptions): Promise<SendResult>;
	abstract editMessage(text: string, options: EditOptions): Promise<SendResult>;
	abstract deleteMessage(chatId: string, messageId: string): Promise<boolean>;

	async sendTyping(_chatId: string, _threadId?: string): Promise<void> {
		// default no-op
	}

	async stopTyping(_chatId: string, _threadId?: string): Promise<void> {
		// default no-op
	}

	async sendImage(_options: SendMediaOptions): Promise<SendResult | undefined> {
		return undefined;
	}

	async sendVideo(_options: SendMediaOptions): Promise<SendResult | undefined> {
		return undefined;
	}

	async sendDocument(_options: SendMediaOptions): Promise<SendResult | undefined> {
		return undefined;
	}

	async sendVoice(_options: SendMediaOptions): Promise<SendResult | undefined> {
		return undefined;
	}

	async sendAnimation(_options: SendMediaOptions): Promise<SendResult | undefined> {
		return undefined;
	}

	async addReaction(_chatId: string, _messageId: string, _emoji: string): Promise<boolean> {
		return false;
	}

	async removeReaction(_chatId: string, _messageId: string, _emoji: string): Promise<boolean> {
		return false;
	}

	formatMessage(text: string): string {
		return text;
	}

	splitForOverflow(text: string): string[] {
		const max = this.capabilities.maxMessageLength;
		if (text.length <= max) return [text];
		const chunks: string[] = [];
		let remaining = text;
		while (remaining.length > max) {
			const slice = splitChunk(remaining, max);
			chunks.push(slice);
			remaining = remaining.slice(slice.length);
		}
		if (remaining.length > 0) chunks.push(remaining);
		return chunks;
	}

	extractIncomingMedia(_raw: unknown): MediaAttachment[] {
		return [];
	}
}

function splitChunk(text: string, max: number): string {
	if (text.length <= max) return text;
	const codeFence = findOpenCodeFence(text, max);
	if (codeFence !== undefined && codeFence > 0) return text.slice(0, codeFence);
	const lastNewline = text.lastIndexOf("\n", max);
	if (lastNewline > max * 0.5) return text.slice(0, lastNewline + 1);
	const lastSpace = text.lastIndexOf(" ", max);
	if (lastSpace > max * 0.5) return text.slice(0, lastSpace + 1);
	return text.slice(0, max);
}

function findOpenCodeFence(text: string, before: number): number | undefined {
	const segment = text.slice(0, before);
	const matches = segment.match(/```/g);
	if (matches === null) return undefined;
	if (matches.length % 2 === 0) return undefined;
	const lastFence = segment.lastIndexOf("```");
	return lastFence === -1 ? undefined : lastFence;
}
