import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRegistry } from "@clanky/core";
import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import {
	AllowList,
	BasePlatformAdapter,
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
	StreamConsumer,
} from "../src/index.ts";

const provider = "clanky-allow-faux";
const modelId = "clanky-allow-faux-model";
const api = "clanky-allow-faux-api";

// ===== AllowList unit tests =====

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
	mentionsBot: false,
	...overrides,
});

// Empty allowlist = default-allow.
const empty = new AllowList({});
const emptyDecision = empty.check(baseEvent({ chatType: "group", mentionsBot: true }));
if (!emptyDecision.allowed) throw new Error("Empty allowlist must default-allow");

// user_denied takes precedence over allowedUsers.
const deniedFirst = new AllowList({ allowedUsers: ["user-1"], deniedUsers: ["user-1"] });
const deniedDecision = deniedFirst.check(baseEvent());
if (deniedDecision.allowed) throw new Error("deniedUsers should take precedence over allowedUsers");
if (deniedDecision.allowed === false && deniedDecision.reason !== "user_denied") {
	throw new Error(`Expected user_denied, got ${deniedDecision.reason}`);
}

// allowedUsers non-empty + user not on list → user_not_allowed.
const restrictedUsers = new AllowList({ allowedUsers: ["someone-else"] });
const notAllowed = restrictedUsers.check(baseEvent());
if (notAllowed.allowed) throw new Error("User not on allowedUsers should be rejected");
if (notAllowed.allowed === false && notAllowed.reason !== "user_not_allowed") {
	throw new Error(`Expected user_not_allowed, got ${notAllowed.reason}`);
}

// allowedChats applies to non-DM only — DM should pass through regardless.
const restrictedChats = new AllowList({ allowedChats: ["chat-B"] });
const dmPasses = restrictedChats.check(baseEvent({ chatType: "dm", chatId: "chat-A" }));
if (!dmPasses.allowed) throw new Error("allowedChats must not block DMs");
const groupBlocked = restrictedChats.check(baseEvent({ chatType: "group", chatId: "chat-A" }));
if (groupBlocked.allowed) throw new Error("Group chat not on allowedChats should be rejected");
if (groupBlocked.allowed === false && groupBlocked.reason !== "chat_not_allowed") {
	throw new Error(`Expected chat_not_allowed, got ${groupBlocked.reason}`);
}

// requireMentionInGroups: DM never requires mention; group without mention rejected; group with mention allowed.
const mentionRequired = new AllowList({ requireMentionInGroups: true });
const dmNoMention = mentionRequired.check(baseEvent({ chatType: "dm", mentionsBot: false }));
if (!dmNoMention.allowed) throw new Error("DM without mention should still allow when requireMentionInGroups");
const groupNoMention = mentionRequired.check(baseEvent({ chatType: "group", mentionsBot: false }));
if (groupNoMention.allowed) throw new Error("Group without mention should be rejected when required");
if (groupNoMention.allowed === false && groupNoMention.reason !== "mention_required") {
	throw new Error(`Expected mention_required, got ${groupNoMention.reason}`);
}
const groupWithMention = mentionRequired.check(baseEvent({ chatType: "group", mentionsBot: true }));
if (!groupWithMention.allowed) throw new Error("Group with mention should be allowed");

// freeResponseChats override: even without mention, a free-response chat is allowed.
const freeResponse = new AllowList({ requireMentionInGroups: true, freeResponseChats: ["chat-A"] });
const freeAllowed = freeResponse.check(baseEvent({ chatType: "group", chatId: "chat-A", mentionsBot: false }));
if (!freeAllowed.allowed) throw new Error("freeResponseChats must bypass mention requirement");

// deniedChats blocks even DM.
const deniedChats = new AllowList({ deniedChats: ["chat-A"] });
const dmDenied = deniedChats.check(baseEvent({ chatType: "dm", chatId: "chat-A" }));
if (dmDenied.allowed) throw new Error("deniedChats should block even DMs");

// guildId gate (Discord): when allowedGuilds is set, mismatch is rejected.
const guildOnly = new AllowList({ allowedGuilds: ["guild-1"] });
const wrongGuild = guildOnly.check(baseEvent({ chatType: "group" }), { guildId: "guild-2" });
if (wrongGuild.allowed) throw new Error("Wrong guild should be rejected");
if (wrongGuild.allowed === false && wrongGuild.reason !== "guild_not_allowed") {
	throw new Error(`Expected guild_not_allowed, got ${wrongGuild.reason}`);
}
const rightGuild = guildOnly.check(baseEvent({ chatType: "group" }), { guildId: "guild-1" });
if (!rightGuild.allowed) throw new Error("Right guild should be allowed");
// guildId option absent → guild check skipped entirely even with allowedGuilds set.
const guildAbsent = guildOnly.check(baseEvent({ chatType: "group" }));
if (!guildAbsent.allowed) throw new Error("Absent guildId should not trip the guild gate");

// ===== Broker policy gate edges (ignore / confirm / reject reply path) =====

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
	readonly sends: { text: string; messageId: string }[] = [];
	private nextMessageId = 1;

	async connect(): Promise<boolean> {
		return true;
	}

	async disconnect(): Promise<void> {
		return;
	}

	async send(text: string, _options: SendOptions): Promise<SendResult> {
		const messageId = `m-${this.nextMessageId++}`;
		this.sends.push({ text, messageId });
		return { messageId, chunked: false };
	}

	async editMessage(text: string, options: EditOptions): Promise<SendResult> {
		this.sends.push({ text, messageId: options.messageId });
		return { messageId: options.messageId, chunked: false };
	}

	async deleteMessage(): Promise<boolean> {
		return true;
	}
}

class ScriptedPolicy implements MessagingPolicyGate {
	private script: PolicyDecision[];
	readonly contexts: PolicyContext[] = [];

	constructor(script: PolicyDecision[]) {
		this.script = script;
	}

	evaluate(context: PolicyContext): PolicyDecision {
		this.contexts.push(context);
		const next = this.script.shift();
		if (next === undefined) return { type: "allow" };
		return next;
	}
}

const homeDir = await mkdtemp(join(tmpdir(), "clanky-messaging-allow-"));
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
					name: "Clanky Allow Faux Model",
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

const policy = new ScriptedPolicy([
	{ type: "ignore", reason: "mention-required" },
	{ type: "reject", reason: "blocked", replyText: "Not for you." },
	{ type: "confirm", replyText: "Confirm please.", pendingId: "pending-1" },
]);

const policyEvents: { decision: PolicyDecision["type"] }[] = [];
const sentEvents: { chunks: number }[] = [];
const messagingConfig = loadMessagingConfigFromEnv({});
messagingConfig.telegram.enabled = true;
messagingConfig.telegram.botToken = "test:t";

const messaging = new MessagingManager({
	registry,
	clankyPaths: registry.paths,
	config: messagingConfig,
	policy,
	provider,
	model: modelId,
	streamConfig: { editIntervalMs: 20, bufferThreshold: 1, finalDrainTimeoutMs: 1_500 },
	events: {
		onPolicy: (event) => policyEvents.push({ decision: event.decision.type }),
		onSent: (event) => sentEvents.push({ chunks: event.chunks }),
	},
});
const adapter = new FauxAdapter();
messaging.registerAdapter(adapter);
await adapter.connect();

const sendCount = (): number => adapter.sends.length;
const mappingCount = async (): Promise<number> => (await messaging.broker.listMappings("telegram")).length;

// 1) ignore decision: no reply, no model call, no mapping created.
await messaging.broker.handleIncoming(baseEvent({ chatType: "group", platformMessageId: "ig-1" }));
if (sendCount() !== 0) throw new Error("ignore decision should produce no send");
if ((await mappingCount()) !== 0) throw new Error("ignore decision should not create a session mapping");

// 2) reject decision with replyText sends the reply but skips the model.
await messaging.broker.handleIncoming(baseEvent({ chatType: "group", platformMessageId: "re-1" }));
if (sendCount() !== 1) throw new Error("reject should produce exactly one send");
if (adapter.sends[0]?.text !== "Not for you.") throw new Error("Reject reply text mismatch");
if ((await mappingCount()) !== 0) throw new Error("reject decision should not create a session mapping");

// 3) confirm decision sends the confirm prompt and waits — no mapping created.
await messaging.broker.handleIncoming(baseEvent({ chatType: "group", platformMessageId: "co-1" }));
if (sendCount() !== 2) throw new Error("confirm should produce a second send");
if (adapter.sends[1]?.text !== "Confirm please.") throw new Error("Confirm reply text mismatch");
if ((await mappingCount()) !== 0) throw new Error("confirm decision should not create a session mapping");

// 4) After the scripted policy is exhausted, default allow runs through and creates a mapping.
await messaging.broker.handleIncoming(
	baseEvent({ chatType: "dm", platformMessageId: "ok-1", chatId: "post-script-dm" }),
);
const postScriptMappings = (await messaging.broker.listMappings("telegram")).filter(
	(m) => m.chatId === "post-script-dm",
);
if (postScriptMappings.length !== 1) throw new Error("Default-allow should create a mapping for a fresh DM");

if (policyEvents.length !== 4) throw new Error(`Expected 4 policy events, got ${policyEvents.length}`);
if (policyEvents[0]?.decision !== "ignore") throw new Error("First policy event should be ignore");
if (policyEvents[1]?.decision !== "reject") throw new Error("Second policy event should be reject");
if (policyEvents[2]?.decision !== "confirm") throw new Error("Third policy event should be confirm");
if (policyEvents[3]?.decision !== "allow") throw new Error("Fourth policy event should be allow");
if (sentEvents.length !== 1) throw new Error(`Expected 1 sent event (allow path only), got ${sentEvents.length}`);

await messaging.close();
await registry.dispose();
await rm(homeDir, { recursive: true, force: true });

// ===== StreamConsumer behavior tests (no broker, no registry needed) =====

class CapturingAdapter extends BasePlatformAdapter {
	readonly platform = "telegram" as const;
	readonly capabilities: PlatformCapabilities = {
		maxMessageLength: 60,
		supportsEditing: true,
		supportsDeletion: true,
		supportsTyping: false,
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
	sends: { text: string; messageId: string }[] = [];
	edits: { text: string; messageId: string }[] = [];
	floodOnNextSend = 0;
	private nextId = 1;

	async connect(): Promise<boolean> {
		return true;
	}

	async disconnect(): Promise<void> {
		return;
	}

	async send(text: string, _options: SendOptions): Promise<SendResult> {
		if (this.floodOnNextSend > 0) {
			this.floodOnNextSend -= 1;
			throw new Error("Telegram says: Too Many Requests: flood control");
		}
		const messageId = `s-${this.nextId++}`;
		this.sends.push({ text, messageId });
		return { messageId, chunked: false };
	}

	async editMessage(text: string, options: EditOptions): Promise<SendResult> {
		this.edits.push({ text, messageId: options.messageId });
		return { messageId: options.messageId, chunked: false };
	}

	async deleteMessage(): Promise<boolean> {
		return true;
	}
}

// 5) Segment break followed by more deltas: finalize current segment, then start a fresh chunk.
{
	const adapter1 = new CapturingAdapter();
	const consumer = new StreamConsumer(
		adapter1,
		{ chatId: "stream-1" },
		{ editIntervalMs: 5, bufferThreshold: 1, finalDrainTimeoutMs: 500, cursor: "" },
	);
	const run = consumer.run();
	consumer.delta("Hello segment one. ");
	await new Promise<void>((resolve) => setTimeout(resolve, 20));
	consumer.segmentBreak();
	await new Promise<void>((resolve) => setTimeout(resolve, 20));
	consumer.delta("And then segment two arrives.");
	consumer.finish();
	const result = await run;
	if (adapter1.sends.length < 2) {
		throw new Error(`Segment break should yield at least 2 sends, got ${adapter1.sends.length}`);
	}
	const lastSend = adapter1.sends.at(-1);
	if (lastSend === undefined || !lastSend.text.includes("segment two")) {
		throw new Error(`Fresh chunk after segment break missing: ${JSON.stringify(adapter1.sends)}`);
	}
	if (!result.finalText.includes("segment two")) {
		throw new Error("Final text should contain segment two content");
	}
	if (result.sentMessageIds.length === 0) throw new Error("Result should include sent message ids");
}

// 6) Multi-chunk overflow: text exceeding maxMessageLength splits across multiple sends.
{
	const adapter2 = new CapturingAdapter();
	const consumer = new StreamConsumer(
		adapter2,
		{ chatId: "stream-2" },
		{ editIntervalMs: 5, bufferThreshold: 200, finalDrainTimeoutMs: 500, cursor: "" },
	);
	const run = consumer.run();
	const big = `${"abcdefghij ".repeat(40)}END`;
	consumer.delta(big);
	consumer.finish();
	const result = await run;
	if (adapter2.sends.length < 2) {
		throw new Error(`Overflow should yield multiple sends, got ${adapter2.sends.length}`);
	}
	const reconstructed = adapter2.sends.map((s) => s.text).join("");
	if (!reconstructed.includes("END")) throw new Error("Overflow lost trailing content");
	for (const send of adapter2.sends) {
		if (send.text.length > adapter2.capabilities.maxMessageLength) {
			throw new Error(`Send exceeded max length: ${send.text.length}`);
		}
	}
	if (result.totalChunks !== adapter2.sends.length + adapter2.edits.length) {
		throw new Error(
			`totalChunks=${result.totalChunks} != sends+edits=${adapter2.sends.length + adapter2.edits.length}`,
		);
	}
}

// 7) Flood control trips fallback after floodMaxStrikes and drains via send().
{
	const adapter3 = new CapturingAdapter();
	adapter3.floodOnNextSend = 5; // exceed floodMaxStrikes
	const consumer = new StreamConsumer(
		adapter3,
		{ chatId: "stream-3" },
		{
			editIntervalMs: 5,
			bufferThreshold: 1,
			finalDrainTimeoutMs: 500,
			cursor: "",
			floodMaxStrikes: 2,
			floodBackoffMaxMs: 50,
		},
	);
	const run = consumer.run();
	consumer.delta("first part. ");
	await new Promise<void>((resolve) => setTimeout(resolve, 30));
	consumer.delta("second part appended.");
	consumer.finish();
	const result = await run;
	if (!result.floodFallback) throw new Error("floodFallback should be true after exceeding strikes");
	// Even with flood, finalText must contain accumulated content.
	if (!result.finalText.includes("second part appended.")) {
		throw new Error("Flood fallback lost accumulated content");
	}
}

// 8) abort() short-circuits an in-flight stream cleanly (no throw, finalText reflects what was buffered).
{
	const adapter4 = new CapturingAdapter();
	const consumer = new StreamConsumer(
		adapter4,
		{ chatId: "stream-4" },
		{ editIntervalMs: 50, bufferThreshold: 1000, finalDrainTimeoutMs: 500, cursor: "" },
	);
	const run = consumer.run();
	consumer.delta("partial buffered text");
	await new Promise<void>((resolve) => setTimeout(resolve, 10));
	consumer.abort();
	const result = await run;
	if (result.finalText !== "partial buffered text") {
		throw new Error(`Abort should finalize buffered text; got: ${JSON.stringify(result.finalText)}`);
	}
}

// 9) abort() before any deltas is a no-op (returns empty result, does not throw).
{
	const adapter5 = new CapturingAdapter();
	const consumer = new StreamConsumer(
		adapter5,
		{ chatId: "stream-5" },
		{ editIntervalMs: 50, bufferThreshold: 1, finalDrainTimeoutMs: 500, cursor: "" },
	);
	const run = consumer.run();
	consumer.abort();
	const result = await run;
	if (result.finalText !== "") throw new Error("Abort with no deltas should yield empty finalText");
	if (result.sentMessageIds.length !== 0) throw new Error("Abort with no deltas should not send anything");
	if (adapter5.sends.length !== 0) throw new Error("Abort with no deltas should not have called send");
}

// 10) error() propagates the same way as abort — stream finishes without throwing.
{
	const adapter6 = new CapturingAdapter();
	const consumer = new StreamConsumer(
		adapter6,
		{ chatId: "stream-6" },
		{ editIntervalMs: 50, bufferThreshold: 1, finalDrainTimeoutMs: 500, cursor: "" },
	);
	const run = consumer.run();
	consumer.delta("some text before error");
	await new Promise<void>((resolve) => setTimeout(resolve, 10));
	consumer.error("simulated upstream failure");
	const result = await run;
	if (!result.finalText.includes("some text before error")) {
		throw new Error("error() should preserve accumulated text in finalText");
	}
}

console.log(
	JSON.stringify({
		policyEvents: policyEvents.length,
		sentEvents: sentEvents.length,
		postScriptMappings: postScriptMappings.length,
		allowlistChecks: 11,
	}),
);

function makeStream(streamModel: Model<Api>, text: string) {
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
