import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRegistry } from "@clanky/core";
import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import {
	BasePlatformAdapter,
	type ChatSessionKey,
	type EditOptions,
	loadMessagingConfigFromEnv,
	type MessageEvent,
	MessagingManager,
	type Platform,
	type PlatformCapabilities,
	type SendOptions,
	type SendResult,
} from "../src/index.ts";

const provider = "clanky-keying-faux";
const modelId = "clanky-keying-faux-model";
const api = "clanky-keying-faux-api";
const homeDir = await mkdtemp(join(tmpdir(), "clanky-messaging-keying-"));

const modelInvocations: string[] = [];

const registry = new SessionRegistry({
	homeDir,
	configureModelRegistry: (modelRegistry) => {
		modelRegistry.registerProvider(provider, {
			api,
			baseUrl: "http://localhost:0",
			apiKey: "test-key",
			streamSimple: (streamModel) => makeStream(streamModel, "ok"),
			models: [
				{
					id: modelId,
					name: "Clanky Keying Faux Model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 64_000,
					maxTokens: 1_024,
				},
			],
		});
	},
});

await registry.start();

interface RecordedSend {
	chatId: string;
	threadId?: string;
	text: string;
	at: number;
}

class FauxAdapter extends BasePlatformAdapter {
	readonly platform: Platform;
	readonly capabilities: PlatformCapabilities = {
		maxMessageLength: 4_000,
		supportsEditing: true,
		supportsDeletion: true,
		supportsTyping: true,
		supportsImages: false,
		supportsVoice: false,
		supportsDocuments: false,
		supportsAnimations: false,
		supportsReactions: false,
		supportsThreads: false,
		supportsForums: false,
		supportsSlashCommandSync: false,
		editRateLimitMs: 0,
	};
	readonly sends: RecordedSend[] = [];
	private nextMessageId = 1;

	constructor(platform: Platform) {
		super();
		this.platform = platform;
	}

	async connect(): Promise<boolean> {
		return true;
	}

	async disconnect(): Promise<void> {
		return;
	}

	async send(text: string, options: SendOptions): Promise<SendResult> {
		const messageId = `${this.platform}-${this.nextMessageId++}`;
		const record: RecordedSend = { chatId: options.chatId, text, at: Date.now() };
		if (options.threadId !== undefined) record.threadId = options.threadId;
		this.sends.push(record);
		return { messageId, chunked: false };
	}

	async editMessage(text: string, options: EditOptions): Promise<SendResult> {
		const record: RecordedSend = { chatId: options.chatId, text, at: Date.now() };
		if (options.threadId !== undefined) record.threadId = options.threadId;
		this.sends.push(record);
		return { messageId: options.messageId, chunked: false };
	}

	async deleteMessage(): Promise<boolean> {
		return true;
	}
}

const config = loadMessagingConfigFromEnv({});
config.telegram.enabled = true;
config.telegram.botToken = "test:telegram";
config.discord.enabled = true;
config.discord.botToken = "test.discord";

const messaging = new MessagingManager({
	registry,
	clankyPaths: registry.paths,
	config,
	provider,
	model: modelId,
	groupSessionsPerUser: true,
	streamConfig: { editIntervalMs: 20, bufferThreshold: 1, finalDrainTimeoutMs: 1_500 },
});

const telegramAdapter = new FauxAdapter("telegram");
const discordAdapter = new FauxAdapter("discord");
messaging.registerAdapter(telegramAdapter);
messaging.registerAdapter(discordAdapter);
await telegramAdapter.connect();
await discordAdapter.connect();

const baseEvent = (overrides: Partial<MessageEvent> = {}): MessageEvent => ({
	platform: "telegram",
	platformMessageId: "msg",
	chatId: "chat-A",
	chatType: "dm",
	userId: "user-1",
	timestamp: Date.now(),
	text: "hi",
	type: "text",
	attachments: [],
	mentionsBot: true,
	...overrides,
});

// 1) Cross-platform isolation: same chatId on telegram and discord must yield distinct sessions.
await messaging.broker.handleIncoming(baseEvent({ platform: "telegram", platformMessageId: "tg-1" }));
await messaging.broker.handleIncoming(baseEvent({ platform: "discord", platformMessageId: "dc-1" }));
const allAfterCross = await messaging.broker.listMappings();
const telegramMappings = allAfterCross.filter((m) => m.platform === "telegram");
const discordMappings = allAfterCross.filter((m) => m.platform === "discord");
if (telegramMappings.length !== 1 || discordMappings.length !== 1) {
	throw new Error(`Cross-platform isolation failed: tg=${telegramMappings.length} dc=${discordMappings.length}`);
}
if (telegramMappings[0]?.sessionId === discordMappings[0]?.sessionId) {
	throw new Error("Cross-platform chats shared a session id");
}

// 2) Per-user split inside a group: same group, two users → two mappings.
await messaging.broker.handleIncoming(
	baseEvent({
		platform: "telegram",
		platformMessageId: "tg-g-a",
		chatId: "group-7",
		chatType: "group",
		userId: "user-a",
	}),
);
await messaging.broker.handleIncoming(
	baseEvent({
		platform: "telegram",
		platformMessageId: "tg-g-b",
		chatId: "group-7",
		chatType: "group",
		userId: "user-b",
	}),
);
const groupMappings = (await messaging.broker.listMappings("telegram")).filter((m) => m.chatId === "group-7");
if (groupMappings.length !== 2) throw new Error(`Group should split per user, got ${groupMappings.length}`);
const groupUserIds = new Set(groupMappings.map((m) => m.userId));
if (!groupUserIds.has("user-a") || !groupUserIds.has("user-b")) {
	throw new Error("Group split lost a userId");
}
if (groupMappings[0]?.mode !== "mention" || groupMappings[1]?.mode !== "mention") {
	throw new Error("Group default mode should be mention");
}

// 3) Thread disambiguation in a forum-style chat: two threads under one chat → two mappings.
await messaging.broker.handleIncoming(
	baseEvent({
		platform: "telegram",
		platformMessageId: "forum-1",
		chatId: "forum-A",
		chatType: "supergroup",
		threadId: "topic-1",
		userId: "user-z",
	}),
);
await messaging.broker.handleIncoming(
	baseEvent({
		platform: "telegram",
		platformMessageId: "forum-2",
		chatId: "forum-A",
		chatType: "supergroup",
		threadId: "topic-2",
		userId: "user-z",
	}),
);
const forumMappings = (await messaging.broker.listMappings("telegram")).filter((m) => m.chatId === "forum-A");
if (forumMappings.length !== 2) {
	throw new Error(`Forum thread split failed: ${forumMappings.length}`);
}
const forumThreadIds = new Set(forumMappings.map((m) => m.threadId));
if (!forumThreadIds.has("topic-1") || !forumThreadIds.has("topic-2")) {
	throw new Error("Forum split lost a threadId");
}

// 4) groupSessionsPerUser=false collapses group chats into a single per-chat session.
const sharedConfig = loadMessagingConfigFromEnv({});
sharedConfig.telegram.enabled = true;
sharedConfig.telegram.botToken = "test:telegram";
const sharedHome = await mkdtemp(join(tmpdir(), "clanky-messaging-keying-shared-"));
const sharedRegistry = new SessionRegistry({
	homeDir: sharedHome,
	configureModelRegistry: (modelRegistry) => {
		modelRegistry.registerProvider(provider, {
			api,
			baseUrl: "http://localhost:0",
			apiKey: "test-key",
			streamSimple: (streamModel) => makeStream(streamModel, "ok"),
			models: [
				{
					id: modelId,
					name: "Clanky Keying Faux Model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 64_000,
					maxTokens: 1_024,
				},
			],
		});
	},
});
await sharedRegistry.start();
const sharedMessaging = new MessagingManager({
	registry: sharedRegistry,
	clankyPaths: sharedRegistry.paths,
	config: sharedConfig,
	provider,
	model: modelId,
	groupSessionsPerUser: false,
	streamConfig: { editIntervalMs: 20, bufferThreshold: 1, finalDrainTimeoutMs: 1_500 },
});
const sharedAdapter = new FauxAdapter("telegram");
sharedMessaging.registerAdapter(sharedAdapter);
await sharedAdapter.connect();
await sharedMessaging.broker.handleIncoming(
	baseEvent({ platform: "telegram", chatId: "shared-group", chatType: "group", userId: "user-x" }),
);
await sharedMessaging.broker.handleIncoming(
	baseEvent({ platform: "telegram", chatId: "shared-group", chatType: "group", userId: "user-y" }),
);
const sharedGroupMappings = await sharedMessaging.broker.listMappings("telegram");
if (sharedGroupMappings.length !== 1) {
	throw new Error(
		`With groupSessionsPerUser=false, group should collapse to 1 mapping, got ${sharedGroupMappings.length}`,
	);
}
if (sharedGroupMappings[0]?.userId !== undefined) {
	throw new Error("Shared-group mapping should not record a userId");
}

// 5) In-flight serialization: concurrent handleIncoming for the same key must serialize,
//    not interleave. Track entry/exit count to assert exactly-one-at-a-time behavior.
let activeForKey = 0;
let maxConcurrentForKey = 0;
const sharedAdapter2 = sharedMessaging.broker.getAdapter("telegram");
if (sharedAdapter2 === undefined) throw new Error("Shared adapter missing");
const originalSend = sharedAdapter2.send.bind(sharedAdapter2);
sharedAdapter2.send = async (text, options): Promise<SendResult> => {
	if (options.chatId === "race-1") {
		activeForKey += 1;
		maxConcurrentForKey = Math.max(maxConcurrentForKey, activeForKey);
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		const result = await originalSend(text, options);
		activeForKey -= 1;
		return result;
	}
	return await originalSend(text, options);
};
const concurrentEvents: Promise<void>[] = [];
for (let index = 0; index < 5; index += 1) {
	concurrentEvents.push(
		sharedMessaging.broker.handleIncoming(
			baseEvent({
				platform: "telegram",
				chatId: "race-1",
				chatType: "dm",
				userId: "user-race",
				platformMessageId: `race-${index}`,
				text: `race ${index}`,
			}),
		),
	);
}
await Promise.all(concurrentEvents);
if (maxConcurrentForKey > 1) {
	throw new Error(`In-flight per-key serialization broken: max concurrent = ${maxConcurrentForKey}`);
}
const raceMappings = (await sharedMessaging.broker.listMappings("telegram")).filter((m) => m.chatId === "race-1");
if (raceMappings.length !== 1) {
	throw new Error(`Concurrent handleIncoming for one key should yield 1 mapping, got ${raceMappings.length}`);
}

// 6) resetMapping removes the mapping and disposes the underlying session.
const dmMapping = telegramMappings[0];
if (dmMapping === undefined) throw new Error("Missing telegram DM mapping");
const dmKey: ChatSessionKey = { platform: "telegram", chatId: dmMapping.chatId };
if (dmMapping.threadId !== undefined) dmKey.threadId = dmMapping.threadId;
if (dmMapping.userId !== undefined) dmKey.userId = dmMapping.userId;
const liveBefore = registry.get(dmMapping.sessionId);
if (liveBefore === undefined) throw new Error("DM session should be live before reset");
await messaging.broker.resetMapping(dmKey);
const liveAfter = registry.get(dmMapping.sessionId);
if (liveAfter !== undefined) throw new Error("resetMapping should dispose the live session");
const dmAfter = await messaging.broker.listMappings("telegram");
if (dmAfter.some((m) => m.chatId === dmMapping.chatId && m.userId === dmMapping.userId)) {
	throw new Error("resetMapping did not remove the mapping");
}

// 7) resetMapping on a non-existent key is a no-op (not a throw).
await messaging.broker.resetMapping({ platform: "telegram", chatId: "never-existed" });

// 8) Parallel resets of the same key are idempotent.
const repeatEvent = baseEvent({
	platform: "telegram",
	chatId: "repeat-reset",
	chatType: "dm",
	userId: "user-rr",
	platformMessageId: "rr-1",
});
await messaging.broker.handleIncoming(repeatEvent);
const resetKey: ChatSessionKey = { platform: "telegram", chatId: "repeat-reset" };
await Promise.all([
	messaging.broker.resetMapping(resetKey),
	messaging.broker.resetMapping(resetKey),
	messaging.broker.resetMapping(resetKey),
]);
const repeatAfter = (await messaging.broker.listMappings("telegram")).filter((m) => m.chatId === "repeat-reset");
if (repeatAfter.length !== 0) throw new Error("Parallel resets should be idempotent");

await messaging.close();
await sharedMessaging.close();
await registry.dispose();
await sharedRegistry.dispose();
await rm(homeDir, { recursive: true, force: true });
await rm(sharedHome, { recursive: true, force: true });

console.log(
	JSON.stringify({
		modelInvocations: modelInvocations.length,
		telegramSends: telegramAdapter.sends.length,
		discordSends: discordAdapter.sends.length,
		groupMappings: groupMappings.length,
		forumMappings: forumMappings.length,
		sharedGroupMappings: sharedGroupMappings.length,
		maxConcurrentForKey,
	}),
);

function makeStream(streamModel: Model<Api>, text: string) {
	modelInvocations.push(text);
	const message = createAssistantMessage(streamModel, text);
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		stream.push({ type: "text_start", contentIndex: 0, partial: message });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
	});
	return stream;
}

function createAssistantMessage(streamModel: Model<Api>, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		provider: streamModel.provider,
		api: streamModel.api,
		model: streamModel.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}
