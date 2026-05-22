import type { RegisteredSession, SessionRegistry } from "@clanky/core";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { BasePlatformAdapter } from "./adapter.ts";
import {
	type MemoryRetriever,
	type MemoryWriter,
	type MessagingPolicyGate,
	NoopMemoryRetriever,
	NoopMemoryWriter,
	PassThroughPolicyGate,
	type PolicyDecision,
} from "./hooks.ts";
import { type ChatSessionKey, type ChatSessionMapping, ChatSessionStore } from "./sessions-store.ts";
import { StreamConsumer, type StreamConsumerConfig } from "./stream-consumer.ts";
import type { MessageEvent, Platform, SendOptions } from "./types.ts";

export interface BrokerEventEmitter {
	emitReceived(event: BrokerReceivedEvent): void;
	emitSent(event: BrokerSentEvent): void;
	emitError(event: BrokerErrorEvent): void;
	emitPolicy(event: BrokerPolicyEvent): void;
}

export interface BrokerReceivedEvent {
	platform: Platform;
	chatId: string;
	threadId?: string;
	userId: string;
	sessionId: string;
	text: string;
	command?: string;
	at: string;
}

export interface BrokerSentEvent {
	platform: Platform;
	chatId: string;
	threadId?: string;
	sessionId: string;
	messageIds: string[];
	chunks: number;
	floodFallback: boolean;
	durationMs: number;
	at: string;
}

export interface BrokerErrorEvent {
	platform: Platform;
	chatId: string;
	sessionId?: string;
	error: string;
	at: string;
}

export interface BrokerPolicyEvent {
	platform: Platform;
	chatId: string;
	userId: string;
	decision: PolicyDecision;
	at: string;
}

export interface MessagingBrokerOptions {
	registry: SessionRegistry;
	sessionsStoreFile: string;
	policy?: MessagingPolicyGate;
	memory?: MemoryWriter;
	retriever?: MemoryRetriever;
	streamConfig?: Partial<StreamConsumerConfig>;
	groupSessionsPerUser?: boolean;
	events?: BrokerEventEmitter;
	provider?: string;
	model?: string;
}

export class MessagingBroker {
	private readonly registry: SessionRegistry;
	private readonly store: ChatSessionStore;
	private readonly policy: MessagingPolicyGate;
	private readonly memory: MemoryWriter;
	private readonly retriever: MemoryRetriever;
	private readonly streamConfig: Partial<StreamConsumerConfig>;
	private readonly groupSessionsPerUser: boolean;
	private readonly emitter: BrokerEventEmitter | undefined;
	private readonly inFlight = new Map<string, Promise<void>>();
	private readonly provider: string | undefined;
	private readonly model: string | undefined;
	private adapters = new Map<Platform, BasePlatformAdapter>();

	constructor(options: MessagingBrokerOptions) {
		this.registry = options.registry;
		this.store = new ChatSessionStore(options.sessionsStoreFile);
		this.policy = options.policy ?? new PassThroughPolicyGate();
		this.memory = options.memory ?? new NoopMemoryWriter();
		this.retriever = options.retriever ?? new NoopMemoryRetriever();
		this.streamConfig = options.streamConfig ?? {};
		this.groupSessionsPerUser = options.groupSessionsPerUser ?? true;
		this.emitter = options.events;
		this.provider = options.provider;
		this.model = options.model;
	}

	registerAdapter(adapter: BasePlatformAdapter): void {
		this.adapters.set(adapter.platform, adapter);
		adapter.setMessageHandler((event) => this.handleIncoming(event));
	}

	getAdapter(platform: Platform): BasePlatformAdapter | undefined {
		return this.adapters.get(platform);
	}

	async listMappings(platform?: Platform): Promise<ChatSessionMapping[]> {
		return await this.store.list(platform);
	}

	async resetMapping(key: ChatSessionKey): Promise<void> {
		const existing = await this.store.get(key);
		if (existing !== undefined) {
			await this.registry.disposeSession(existing.sessionId).catch(() => false);
		}
		await this.store.remove(key);
	}

	async handleIncoming(event: MessageEvent): Promise<void> {
		const key = this.deriveSessionKey(event);
		const keyString = stableKeyString(key);
		const queued = this.inFlight.get(keyString);
		const work = (queued ?? Promise.resolve()).then(async () => {
			await this.processOne(event, key);
		});
		const tracked = work.finally(() => {
			if (this.inFlight.get(keyString) === tracked) this.inFlight.delete(keyString);
		});
		this.inFlight.set(keyString, tracked);
		await tracked;
	}

	private async processOne(event: MessageEvent, key: ChatSessionKey): Promise<void> {
		await this.store.load();
		const existingMapping = await this.store.get(key);
		const decision = await this.policy.evaluate({ event, mapping: existingMapping });
		this.emitter?.emitPolicy({
			platform: event.platform,
			chatId: event.chatId,
			userId: event.userId,
			decision,
			at: new Date().toISOString(),
		});
		if (decision.type === "ignore") return;
		if (decision.type === "reject") {
			if (decision.replyText !== undefined) {
				await this.replyDirect(event, decision.replyText).catch(() => undefined);
			}
			return;
		}
		if (decision.type === "confirm") {
			await this.replyDirect(event, decision.replyText).catch(() => undefined);
			return;
		}

		const mapping = await this.ensureSession(event, key, existingMapping, decision.mode);
		await this.memory.recordInbound({ event, mapping });
		this.emitter?.emitReceived({
			platform: event.platform,
			chatId: event.chatId,
			...(event.threadId === undefined ? {} : { threadId: event.threadId }),
			userId: event.userId,
			sessionId: mapping.sessionId,
			text: event.text,
			...(event.command === undefined ? {} : { command: event.command }),
			at: new Date(event.timestamp).toISOString(),
		});

		const adapter = this.adapters.get(event.platform);
		if (adapter === undefined) return;
		const session = await this.openSession(mapping);
		const promptText = await this.buildPromptText(event, mapping);
		await this.streamAssistantReply(event, mapping, adapter, session, promptText);
	}

	private async ensureSession(
		event: MessageEvent,
		key: ChatSessionKey,
		existing: ChatSessionMapping | undefined,
		desiredMode: ChatMode | undefined,
	): Promise<ChatSessionMapping> {
		const targetMode = desiredMode ?? existing?.mode ?? defaultModeForEvent(event);
		if (existing !== undefined) {
			const touched = await this.store.touch(key);
			if (touched === undefined) return existing;
			if (touched.mode !== targetMode && desiredMode !== undefined) {
				const updated = await this.store.setMode(key, targetMode);
				return updated ?? touched;
			}
			return touched;
		}
		const created = await this.createSessionForChat();
		return await this.store.reset(key, created.id, { mode: targetMode });
	}

	private async createSessionForChat(): Promise<RegisteredSession> {
		const options: Parameters<SessionRegistry["createSession"]>[0] = {};
		if (this.provider !== undefined) options.provider = this.provider;
		if (this.model !== undefined) options.model = this.model;
		return await this.registry.createSession(options);
	}

	private async openSession(mapping: ChatSessionMapping): Promise<RegisteredSession> {
		try {
			return await this.registry.getOrOpen(mapping.sessionId);
		} catch {
			const fresh = await this.registry.createSession({});
			await this.store.reset(mappingToKey(mapping), fresh.id, { mode: mapping.mode });
			return fresh;
		}
	}

	private async buildPromptText(event: MessageEvent, mapping: ChatSessionMapping): Promise<string> {
		const memoryContext = await this.retriever.buildContext(event, mapping);
		const header = composeHeader(event, mapping);
		const segments: string[] = [];
		if (memoryContext !== undefined && memoryContext.trim().length > 0) segments.push(memoryContext.trim());
		if (header.length > 0) segments.push(header);
		segments.push(event.text);
		return segments.join("\n\n");
	}

	private async streamAssistantReply(
		event: MessageEvent,
		mapping: ChatSessionMapping,
		adapter: BasePlatformAdapter,
		session: RegisteredSession,
		promptText: string,
	): Promise<void> {
		if (!session.hasUsableModel) {
			this.emitter?.emitError({
				platform: event.platform,
				chatId: event.chatId,
				sessionId: mapping.sessionId,
				error: "No usable Pi model configured for this profile.",
				at: new Date().toISOString(),
			});
			await this.replyDirect(
				event,
				"I'm not configured with a model right now. Please set one up and try again.",
			).catch(() => undefined);
			return;
		}

		const sendOptions: SendOptions = { chatId: event.chatId };
		if (event.threadId !== undefined) sendOptions.threadId = event.threadId;
		if (event.platformMessageId !== "") sendOptions.replyToMessageId = event.platformMessageId;

		const consumer = new StreamConsumer(adapter, sendOptions, this.streamConfig);
		const startTime = Date.now();
		const unsubscribe = session.session.subscribe((agentEvent: AgentSessionEvent) => {
			handleAgentEvent(consumer, agentEvent);
		});
		if (adapter.capabilities.supportsTyping) {
			adapter.sendTyping(event.chatId, event.threadId).catch(() => undefined);
		}
		const consumerRun = consumer.run();
		try {
			await session.session.prompt(promptText);
		} catch (error) {
			consumer.error(error instanceof Error ? error.message : String(error));
		}
		const result = await consumerRun;
		unsubscribe();
		if (adapter.capabilities.supportsTyping) {
			adapter.stopTyping(event.chatId, event.threadId).catch(() => undefined);
		}

		this.emitter?.emitSent({
			platform: event.platform,
			chatId: event.chatId,
			...(event.threadId === undefined ? {} : { threadId: event.threadId }),
			sessionId: mapping.sessionId,
			messageIds: result.sentMessageIds,
			chunks: result.totalChunks,
			floodFallback: result.floodFallback,
			durationMs: result.durationMs,
			at: new Date().toISOString(),
		});

		await this.memory.recordOutbound({
			event,
			mapping,
			replyText: result.finalText,
			replyMessageIds: result.sentMessageIds,
			durationMs: Date.now() - startTime,
		});
	}

	private async replyDirect(event: MessageEvent, text: string): Promise<void> {
		const adapter = this.adapters.get(event.platform);
		if (adapter === undefined) return;
		const sendOptions: SendOptions = { chatId: event.chatId };
		if (event.threadId !== undefined) sendOptions.threadId = event.threadId;
		if (event.platformMessageId !== "") sendOptions.replyToMessageId = event.platformMessageId;
		await adapter.send(text, sendOptions);
	}

	private deriveSessionKey(event: MessageEvent): ChatSessionKey {
		const key: ChatSessionKey = { platform: event.platform, chatId: event.chatId };
		if (event.threadId !== undefined) key.threadId = event.threadId;
		if (this.groupSessionsPerUser && event.chatType !== "dm") key.userId = event.userId;
		return key;
	}
}

type ChatMode = ChatSessionMapping["mode"];

function handleAgentEvent(consumer: StreamConsumer, agentEvent: AgentSessionEvent): void {
	if (agentEvent.type === "message_update") {
		const inner = agentEvent.assistantMessageEvent;
		if (inner.type === "text_delta") {
			consumer.delta(inner.delta);
			return;
		}
		if (inner.type === "toolcall_start") {
			consumer.segmentBreak();
			return;
		}
		return;
	}
	if (agentEvent.type === "tool_execution_end") {
		consumer.segmentBreak();
		return;
	}
	if (agentEvent.type === "agent_end") {
		consumer.finish();
		return;
	}
}

function composeHeader(event: MessageEvent, mapping: ChatSessionMapping): string {
	const lines: string[] = [];
	const userPart = event.userDisplayName ?? event.userName ?? event.userId;
	lines.push(`Source: ${event.platform} ${event.chatType} chat ${event.chatId} from ${userPart}`);
	if (mapping.mode !== "mention") lines.push(`Chat mode: ${mapping.mode}`);
	if (event.attachments.length > 0) {
		const kinds = event.attachments.map((attachment) => attachment.kind).join(", ");
		lines.push(`Attachments: ${kinds}`);
	}
	return lines.length === 0 ? "" : `<messaging_source>\n${lines.join("\n")}\n</messaging_source>`;
}

function defaultModeForEvent(event: MessageEvent): ChatMode {
	if (event.chatType === "dm") return "dm_relationship";
	if (event.chatType === "channel") return "opt_in_channel";
	return "mention";
}

function mappingToKey(mapping: ChatSessionMapping): ChatSessionKey {
	const key: ChatSessionKey = { platform: mapping.platform, chatId: mapping.chatId };
	if (mapping.threadId !== undefined) key.threadId = mapping.threadId;
	if (mapping.userId !== undefined) key.userId = mapping.userId;
	return key;
}

function stableKeyString(key: ChatSessionKey): string {
	const thread = key.threadId === undefined ? "" : `:t=${key.threadId}`;
	const user = key.userId === undefined ? "" : `:u=${key.userId}`;
	return `${key.platform}:${key.chatId}${thread}${user}`;
}
