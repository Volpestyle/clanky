import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRegistry } from "@clanky/core";
import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import {
	BasePlatformAdapter,
	type ChatSessionMapping,
	type EditOptions,
	loadMessagingConfigFromEnv,
	type MessageEvent,
	MessagingManager,
	type MessagingPolicyGate,
	type PlatformCapabilities,
	type PolicyContext,
	type PolicyDecision,
	type SendOptions,
	type SendResult,
} from "../src/index.ts";

const provider = "clanky-messaging-faux";
const modelId = "clanky-messaging-faux-model";
const api = "clanky-messaging-faux-api";
const homeDir = await mkdtemp(join(tmpdir(), "clanky-messaging-foundation-"));

const responseText = "Hello from clanky messaging foundation smoke test response.";

const callState: { count: number } = { count: 0 };
const modelCalls = (): number => callState.count;
const receivedCount = (): number => receivedEvents.length;
const sentCount = (): number => sentEvents.length;

const registry = new SessionRegistry({
	homeDir,
	configureModelRegistry: (modelRegistry) => {
		modelRegistry.registerProvider(provider, {
			api,
			baseUrl: "http://localhost:0",
			apiKey: "test-key",
			streamSimple: (streamModel) => createImmediateStream(streamModel, responseText, callState),
			models: [
				{
					id: modelId,
					name: "Clanky Messaging Faux Model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 4_096,
				},
			],
		});
	},
});

await registry.start();

interface CapturedSend {
	kind: "send" | "edit";
	chatId: string;
	threadId?: string;
	messageId?: string;
	text: string;
}

class FauxAdapter extends BasePlatformAdapter {
	readonly platform = "telegram" as const;
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
	readonly sends: CapturedSend[] = [];
	private nextMessageId = 1;

	async connect(): Promise<boolean> {
		return true;
	}

	async disconnect(): Promise<void> {
		return;
	}

	async send(text: string, options: SendOptions): Promise<SendResult> {
		const messageId = String(this.nextMessageId++);
		const captured: CapturedSend = { kind: "send", chatId: options.chatId, text };
		if (options.threadId !== undefined) captured.threadId = options.threadId;
		this.sends.push(captured);
		return { messageId, chunked: false };
	}

	async editMessage(text: string, options: EditOptions): Promise<SendResult> {
		const captured: CapturedSend = { kind: "edit", chatId: options.chatId, messageId: options.messageId, text };
		if (options.threadId !== undefined) captured.threadId = options.threadId;
		this.sends.push(captured);
		return { messageId: options.messageId, chunked: false };
	}

	async deleteMessage(): Promise<boolean> {
		return true;
	}
}

class CapturingPolicyGate implements MessagingPolicyGate {
	readonly decisions: PolicyDecision[] = [];
	private rejectNextUser: string | undefined;

	rejectNextFromUser(userId: string): void {
		this.rejectNextUser = userId;
	}

	evaluate(context: PolicyContext): PolicyDecision {
		if (this.rejectNextUser !== undefined && context.event.userId === this.rejectNextUser) {
			this.rejectNextUser = undefined;
			const decision: PolicyDecision = { type: "reject", reason: "test_rejection", replyText: "Denied for test." };
			this.decisions.push(decision);
			return decision;
		}
		const decision: PolicyDecision = { type: "allow" };
		this.decisions.push(decision);
		return decision;
	}
}

const policy = new CapturingPolicyGate();
const receivedEvents: { sessionId: string; text: string }[] = [];
const sentEvents: { sessionId: string; chunks: number; messageIds: string[] }[] = [];

const config = loadMessagingConfigFromEnv({});
config.telegram.enabled = true;
config.telegram.botToken = "test:token";

const messaging = new MessagingManager({
	registry,
	clankyPaths: registry.paths,
	config,
	policy,
	provider,
	model: modelId,
	groupSessionsPerUser: true,
	streamConfig: { editIntervalMs: 50, bufferThreshold: 4, finalDrainTimeoutMs: 2_000 },
	events: {
		onReceived: (event) => receivedEvents.push({ sessionId: event.sessionId, text: event.text }),
		onSent: (event) =>
			sentEvents.push({ sessionId: event.sessionId, chunks: event.chunks, messageIds: event.messageIds }),
	},
});

const adapter = new FauxAdapter();
messaging.registerAdapter(adapter);

const baseEvent = (overrides: Partial<MessageEvent> = {}): MessageEvent => ({
	platform: "telegram",
	platformMessageId: "msg-1",
	chatId: "chat-1",
	chatType: "dm",
	userId: "user-1",
	timestamp: Date.now(),
	text: "Hello clanky.",
	type: "text",
	attachments: [],
	mentionsBot: true,
	...overrides,
});

await adapter.connect();
await messaging.broker.handleIncoming(baseEvent());

if (modelCalls() !== 1) throw new Error(`Expected 1 model invocation, got ${modelCalls()}`);
if (adapter.sends.length === 0) throw new Error("Adapter did not receive any sends");
const finalSend = adapter.sends.at(-1);
if (finalSend === undefined || !finalSend.text.includes(responseText)) {
	throw new Error(`Final send did not contain response text: ${JSON.stringify(adapter.sends)}`);
}
if (receivedCount() !== 1) throw new Error(`Expected 1 received event, got ${receivedCount()}`);
if (sentCount() !== 1) throw new Error(`Expected 1 sent event, got ${sentCount()}`);
const firstSessionId = receivedEvents[0]?.sessionId;
if (firstSessionId === undefined) throw new Error("Missing session id on received event");

const mappingsAfterFirst = await messaging.broker.listMappings("telegram");
if (mappingsAfterFirst.length !== 1) throw new Error(`Expected 1 mapping, got ${mappingsAfterFirst.length}`);
const mapping1: ChatSessionMapping | undefined = mappingsAfterFirst[0];
if (mapping1 === undefined || mapping1.sessionId !== firstSessionId) {
	throw new Error("Session mapping did not record the active session id");
}
if (mapping1.mode !== "dm_relationship") {
	throw new Error(`Expected dm_relationship mode for DM chat, got ${mapping1.mode}`);
}

await messaging.broker.handleIncoming(baseEvent({ platformMessageId: "msg-2", text: "Second message." }));
if (modelCalls() !== 2) throw new Error(`Expected 2 model invocations after second send, got ${modelCalls()}`);
if (receivedCount() !== 2) throw new Error(`Expected 2 received events, got ${receivedCount()}`);
if (receivedEvents[1]?.sessionId !== firstSessionId) {
	throw new Error("Second message did not reuse the same session");
}

const mappingsAfterSecond = await messaging.broker.listMappings("telegram");
if (mappingsAfterSecond.length !== 1) {
	throw new Error(`Expected 1 mapping after second message, got ${mappingsAfterSecond.length}`);
}

policy.rejectNextFromUser("user-blocked");
await messaging.broker.handleIncoming(
	baseEvent({ userId: "user-blocked", chatId: "chat-blocked", platformMessageId: "msg-3" }),
);
if (modelCalls() !== 2) {
	throw new Error("Rejected message should not have triggered a model call");
}
const rejectionReply = adapter.sends.at(-1);
if (rejectionReply === undefined || rejectionReply.text !== "Denied for test.") {
	throw new Error(`Rejection reply not delivered: ${JSON.stringify(adapter.sends.slice(-3))}`);
}

await messaging.broker.handleIncoming(
	baseEvent({
		chatId: "group-1",
		chatType: "group",
		userId: "user-2",
		platformMessageId: "msg-4",
		text: "Group hello.",
	}),
);
await messaging.broker.handleIncoming(
	baseEvent({
		chatId: "group-1",
		chatType: "group",
		userId: "user-3",
		platformMessageId: "msg-5",
		text: "Group hello from another user.",
	}),
);
const groupMappings = (await messaging.broker.listMappings("telegram")).filter(
	(mapping) => mapping.chatId === "group-1",
);
if (groupMappings.length !== 2) {
	throw new Error(`Group chat should split per user, got ${groupMappings.length} mappings`);
}
for (const mapping of groupMappings) {
	if (mapping.userId === undefined) throw new Error("Group mappings should record userId");
	if (mapping.mode !== "mention") throw new Error(`Group default mode should be mention, got ${mapping.mode}`);
}

const persisted = await readFile(messaging.paths.telegramSessionsFile, "utf8");
if (!persisted.includes(firstSessionId)) {
	throw new Error("Session mappings were not persisted to disk");
}

await messaging.close();
await registry.dispose();
await rm(homeDir, { recursive: true, force: true });

console.log(
	JSON.stringify({
		modelCalls: callState.count,
		adapterSends: adapter.sends.length,
		policyDecisions: policy.decisions.length,
		mappings: mappingsAfterSecond.length + groupMappings.length,
		firstSessionId,
	}),
);

function createImmediateStream(streamModel: Model<Api>, text: string, state: { count: number }) {
	state.count += 1;
	const message = createAssistantMessage(streamModel, text, "stop");
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		stream.push({ type: "text_start", contentIndex: 0, partial: message });
		const halfway = Math.floor(text.length / 2);
		const first = text.slice(0, halfway);
		const second = text.slice(halfway);
		stream.push({ type: "text_delta", contentIndex: 0, delta: first, partial: message });
		stream.push({ type: "text_delta", contentIndex: 0, delta: second, partial: message });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
	});
	return stream;
}

function createAssistantMessage(
	streamModel: Model<Api>,
	text: string,
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
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
		stopReason,
		timestamp: Date.now(),
	};
}
