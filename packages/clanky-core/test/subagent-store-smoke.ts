import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscordSubagentStore, resolveClankyPaths } from "@clanky/core";

const tmpRoot = await mkdtemp(join(tmpdir(), "clanky-subagent-store-"));

try {
	const paths = resolveClankyPaths({ homeDir: join(tmpRoot, "home") });
	const store = new DiscordSubagentStore(paths);
	const workerId = "discord-guild:guild-smoke";

	await store.enqueueDiscordMessage({
		workerId,
		kind: "discord-guild",
		scopeId: "guild-smoke",
		scopeName: "Smoke Guild",
		guildId: "guild-smoke",
		conversationId: "channel-low",
		conversationName: "low",
		conversationKind: "channel",
		senderId: "user-low",
		senderName: "Low User",
		externalMessageId: "message-low",
		acceptanceReason: "recent_engagement",
		text: "low priority",
		priority: 0,
		receivedAt: "2026-01-01T00:00:00.000Z",
	});
	await store.enqueueDiscordMessage({
		workerId,
		kind: "discord-guild",
		scopeId: "guild-smoke",
		scopeName: "Smoke Guild",
		guildId: "guild-smoke",
		conversationId: "channel-high-parent",
		conversationName: "high",
		conversationKind: "thread",
		conversationThreadId: "thread-high",
		conversationParentId: "channel-high-parent",
		senderId: "user-high",
		senderName: "High User",
		externalMessageId: "message-high",
		acceptanceReason: "platform_mention",
		text: "high priority",
		attachments: [{ url: "https://example.test/file.png" }],
		priority: 10,
		receivedAt: "2026-01-01T00:01:00.000Z",
	});

	const initial = await store.listSubagents();
	const subagent = initial.find((entry) => entry.id === workerId);
	if (subagent === undefined || subagent.queueDepth !== 2 || subagent.state !== "queued") {
		throw new Error(`subagent smoke: unexpected initial summary ${JSON.stringify(initial)}`);
	}

	const first = await store.claimNextDiscordMessage(workerId, new Date("2026-01-01T00:02:00.000Z"));
	if (
		first === undefined ||
		first.externalMessageId !== "message-high" ||
		first.attachments.length !== 1 ||
		first.conversationThreadId !== "thread-high" ||
		first.conversationParentId !== "channel-high-parent"
	) {
		throw new Error(`subagent smoke: priority claim failed ${JSON.stringify(first)}`);
	}
	await store.setSubagentState(workerId, "running", { activeSummary: "processing high priority" });
	const duplicate = await store.enqueueDiscordMessage({
		workerId,
		kind: "discord-guild",
		scopeId: "guild-smoke",
		scopeName: "Smoke Guild",
		guildId: "guild-smoke",
		conversationId: "channel-high-parent",
		conversationName: "high",
		conversationKind: "thread",
		conversationThreadId: "thread-high",
		conversationParentId: "channel-high-parent",
		senderId: "user-high",
		senderName: "High User",
		externalMessageId: "message-high",
		acceptanceReason: "platform_mention",
		text: "duplicate high priority",
		priority: 10,
		receivedAt: "2026-01-01T00:02:30.000Z",
	});
	if (duplicate.id !== first.id || duplicate.text !== "high priority") {
		throw new Error(`subagent smoke: duplicate enqueue did not return existing message ${JSON.stringify(duplicate)}`);
	}
	const duplicateSummary = await store.listSubagents();
	const duplicateSubagent = duplicateSummary.find((entry) => entry.id === workerId);
	if (duplicateSubagent?.queueDepth !== 2 || duplicateSubagent.state !== "running") {
		throw new Error(`subagent smoke: duplicate enqueue rewrote worker state ${JSON.stringify(duplicateSummary)}`);
	}
	await store.enqueueDiscordMessage({
		workerId,
		kind: "discord-guild",
		scopeId: "guild-smoke",
		scopeName: "Smoke Guild",
		guildId: "guild-smoke",
		conversationId: "channel-mid",
		conversationName: "mid",
		conversationKind: "channel",
		senderId: "user-mid",
		senderName: "Mid User",
		externalMessageId: "message-mid",
		acceptanceReason: "reply_to_self",
		text: "mid priority while running",
		priority: 5,
		receivedAt: "2026-01-01T00:02:45.000Z",
	});
	const runningSummary = await store.listSubagents();
	const runningSubagent = runningSummary.find((entry) => entry.id === workerId);
	if (
		runningSubagent?.queueDepth !== 3 ||
		runningSubagent.state !== "running" ||
		runningSubagent.activeSummary !== "processing high priority"
	) {
		throw new Error(
			`subagent smoke: enqueue behind running worker rewrote active state ${JSON.stringify(runningSummary)}`,
		);
	}
	await store.completeDiscordMessage(first.id, "reply-high", new Date("2026-01-01T00:03:00.000Z"));

	const second = await store.claimNextDiscordMessage(workerId, new Date("2026-01-01T00:04:00.000Z"));
	if (second === undefined || second.externalMessageId !== "message-mid") {
		throw new Error(`subagent smoke: second claim failed ${JSON.stringify(second)}`);
	}
	await store.failDiscordMessage(second.id, "simulated failure", new Date("2026-01-01T00:05:00.000Z"));
	const third = await store.claimNextDiscordMessage(workerId, new Date("2026-01-01T00:06:00.000Z"));
	if (third === undefined || third.externalMessageId !== "message-low") {
		throw new Error(`subagent smoke: third claim failed ${JSON.stringify(third)}`);
	}
	await store.failDiscordMessage(third.id, "simulated failure", new Date("2026-01-01T00:07:00.000Z"));
	await store.setSubagentState(workerId, "failed", { lastError: "simulated failure" });

	const final = await store.listSubagents();
	const finalSubagent = final.find((entry) => entry.id === workerId);
	if (
		finalSubagent === undefined ||
		finalSubagent.queueDepth !== 0 ||
		finalSubagent.lastError !== "simulated failure"
	) {
		throw new Error(`subagent smoke: unexpected final summary ${JSON.stringify(final)}`);
	}
	await store.upsertSubagent({
		id: "discord-voice:guild-smoke:voice-smoke",
		kind: "discord-voice",
		scopeId: "guild-smoke:voice-smoke",
		scopeName: "Smoke Voice",
		state: "running",
		activeSummary: "listening in Discord voice",
	});
	const generic = await store.listSubagents();
	const voiceSubagent = generic.find((entry) => entry.id === "discord-voice:guild-smoke:voice-smoke");
	if (voiceSubagent?.kind !== "discord-voice" || voiceSubagent.queueDepth !== 0) {
		throw new Error(`subagent smoke: generic voice subagent was not listed ${JSON.stringify(generic)}`);
	}

	store.close();
	console.log(JSON.stringify({ subagents: generic.length, workerId }));
} finally {
	await rm(tmpRoot, { recursive: true, force: true });
}
