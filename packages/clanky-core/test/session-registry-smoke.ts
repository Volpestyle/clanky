import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_LIVE_SESSIONS, DEFAULT_SESSION_IDLE_TTL_MS, SessionRegistry } from "@clanky/core";
import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";

if (DEFAULT_SESSION_IDLE_TTL_MS !== 60 * 60 * 1000) {
	throw new Error(`Default session idle TTL drifted from 1h: ${DEFAULT_SESSION_IDLE_TTL_MS}`);
}
if (DEFAULT_MAX_LIVE_SESSIONS !== 128) {
	throw new Error(`Default max live sessions drifted from 128: ${DEFAULT_MAX_LIVE_SESSIONS}`);
}

const homeDir = await mkdtemp(join(tmpdir(), "clanky-session-registry-"));
const registry = new SessionRegistry({
	homeDir,
	maxLiveSessions: 2,
	watchSkills: false,
});
const ttlHomeDir = await mkdtemp(join(tmpdir(), "clanky-session-registry-ttl-"));
const ttlRegistry = new SessionRegistry({
	homeDir: ttlHomeDir,
	idleTtlMs: 1,
	watchSkills: false,
});
const drainHomeDir = await mkdtemp(join(tmpdir(), "clanky-session-registry-drain-"));
const drainProvider = "clanky-session-drain-faux";
const drainModel = "clanky-session-drain-faux-model";
const drainText = "Drained prompt completed.";
const drainRegistry = new SessionRegistry({
	homeDir: drainHomeDir,
	watchSkills: false,
	configureModelRegistry: (modelRegistry) => {
		modelRegistry.registerProvider(drainProvider, {
			api: "clanky-session-drain-faux-api",
			baseUrl: "http://localhost:0",
			apiKey: "test-key",
			streamSimple: (streamModel) => createDelayedStream(streamModel, drainText, 50),
			models: [
				{
					id: drainModel,
					name: "Clanky Session Drain Faux Model",
					reasoning: false,
					input: ["text"],
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
					},
					contextWindow: 128_000,
					maxTokens: 4_096,
				},
			],
		});
	},
});

try {
	await registry.start();
	const first = await registry.createSession({ noTools: "all" });
	await delay(10);
	const second = await registry.createSession({ noTools: "all" });
	await delay(10);
	registry.get(first.id);
	await delay(10);
	const third = await registry.createSession({ noTools: "all" });

	const liveIds = registry.list().map((session) => session.id);
	if (
		liveIds.length !== 2 ||
		!liveIds.includes(first.id) ||
		liveIds.includes(second.id) ||
		!liveIds.includes(third.id)
	) {
		throw new Error(`SessionRegistry did not evict the least recently used session: ${JSON.stringify(liveIds)}`);
	}

	console.log(JSON.stringify({ first: first.id, evicted: second.id, third: third.id, live: liveIds.length }));

	await ttlRegistry.start();
	const ttlFirst = await ttlRegistry.createSession({ noTools: "all" });
	await delay(10);
	const ttlSecond = await ttlRegistry.createSession({ noTools: "all" });
	const ttlLiveIds = ttlRegistry.list().map((session) => session.id);
	if (ttlLiveIds.includes(ttlFirst.id) || !ttlLiveIds.includes(ttlSecond.id) || ttlLiveIds.length !== 1) {
		throw new Error(`SessionRegistry did not evict the idle session: ${JSON.stringify(ttlLiveIds)}`);
	}

	console.log(JSON.stringify({ evictedIdle: ttlFirst.id, live: ttlSecond.id, ttlLive: ttlLiveIds.length }));

	await drainRegistry.start();
	const drainSession = await drainRegistry.createSession({ provider: drainProvider, model: drainModel });
	const prompt = drainSession.session.prompt("finish before shutdown");
	await waitFor(() => drainSession.session.isStreaming);
	const drained = await drainRegistry.drainSessions({ timeoutMs: 1000, pollIntervalMs: 5 });
	await prompt;
	if (!drained.drained.includes(drainSession.id) || drained.stillRunning.length !== 0) {
		throw new Error(`SessionRegistry did not drain the in-flight session: ${JSON.stringify(drained)}`);
	}
	if (drainSession.session.getLastAssistantText() !== drainText) {
		throw new Error("Drained session did not complete the prompt before shutdown");
	}

	console.log(JSON.stringify({ drained: drained.drained.length, stillRunning: drained.stillRunning.length }));

	const memoryStatus = await registry.memoryStatus();
	if (!memoryStatus.selfFile.endsWith("SELF.md") || memoryStatus.atoms !== 0) {
		throw new Error(`Unexpected initial memory status: ${JSON.stringify(memoryStatus)}`);
	}
	const unconfirmedPersonal = await registry.rememberMemory({
		scope: "user",
		subjectId: "local",
		type: "preference",
		claim: "User prefers source-grounded examples.",
		source: {
			scope: "user",
			subjectId: "local",
			source: "manual",
			text: "Remember that I prefer source-grounded examples.",
		},
	});
	if (unconfirmedPersonal.saved || unconfirmedPersonal.needsConfirmation !== true) {
		throw new Error(`Personal memory did not require confirmation: ${JSON.stringify(unconfirmedPersonal)}`);
	}
	const remembered = await registry.rememberMemory({
		scope: "project",
		subjectId: process.cwd(),
		type: "decision",
		claim: "Memory smoke stores source-grounded project decisions.",
		source: {
			scope: "project",
			subjectId: process.cwd(),
			source: "manual",
			text: "Memory smoke stores source-grounded project decisions.",
		},
		confirmed: true,
		confidence: 0.91,
	});
	if (!remembered.saved || remembered.atom.sourceEventIds.length !== 1 || remembered.atom.confidence !== 0.91) {
		throw new Error(`Confirmed memory was not stored with provenance: ${JSON.stringify(remembered)}`);
	}
	const rejectedSecret = await registry.rememberMemory({
		scope: "project",
		subjectId: process.cwd(),
		claim: "The API key is sk-secret",
		source: {
			scope: "project",
			subjectId: process.cwd(),
			source: "manual",
			text: "The API key is sk-secret",
		},
		confirmed: true,
	});
	if (rejectedSecret.saved || rejectedSecret.rejectedReason?.includes("credentials") !== true) {
		throw new Error(`Credential-like memory was not rejected: ${JSON.stringify(rejectedSecret)}`);
	}
	const memorySearch = await registry.searchMemory({ query: "source-grounded project", subjectId: process.cwd() });
	if (!memorySearch.atoms.some((atom) => atom.id === remembered.atom.id)) {
		throw new Error(`Memory search did not find stored project memory: ${JSON.stringify(memorySearch)}`);
	}
	const packet = await registry.memoryPacket({
		sessionId: "memory-smoke",
		prompt: "source-grounded project",
		cwd: process.cwd(),
	});
	if (
		!packet.self.includes("Clanky") ||
		!packet.text.includes("Stored memories are source-grounded claims") ||
		!packet.atoms.some((atom) => atom.id === remembered.atom.id)
	) {
		throw new Error(`Memory packet did not include self memory and relevant atom: ${JSON.stringify(packet)}`);
	}
	const consent = await registry.setMemoryConsent({
		scope: "channel",
		subjectId: "channel-smoke",
		enabled: true,
		mode: "channel",
		retentionDays: 30,
	});
	if (!consent.enabled || consent.mode !== "channel" || consent.retentionDays !== 30) {
		throw new Error(`Memory consent was not persisted: ${JSON.stringify(consent)}`);
	}
	const exportedMemory = await registry.exportMemory();
	if (
		!exportedMemory.atoms.some((atom) => atom.id === remembered.atom.id) ||
		!exportedMemory.events.some((event) => remembered.atom.sourceEventIds.includes(event.id)) ||
		exportedMemory.consent.length === 0
	) {
		throw new Error(`Memory export missed atoms, events, or consent: ${JSON.stringify(exportedMemory)}`);
	}
	const forgotten = await registry.forgetMemory({ id: remembered.atom.id });
	if (forgotten.forgotten !== 1) {
		throw new Error(`Memory forget did not delete one atom: ${JSON.stringify(forgotten)}`);
	}
	const memoryAfterForget = await registry.searchMemory({ query: "source-grounded project", subjectId: process.cwd() });
	if (memoryAfterForget.atoms.some((atom) => atom.id === remembered.atom.id)) {
		throw new Error(`Forgotten memory still appears in search: ${JSON.stringify(memoryAfterForget)}`);
	}
} finally {
	await registry.dispose();
	await ttlRegistry.dispose();
	await drainRegistry.dispose();
	await Promise.all([homeDir, ttlHomeDir, drainHomeDir].map((dir) => rm(dir, { force: true, recursive: true })));
}

async function delay(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await delay(5);
	}
	throw new Error("Timed out waiting for streaming session");
}

function createDelayedStream(streamModel: Model<Api>, text: string, delayMs: number) {
	const stream = createAssistantMessageEventStream();
	const message = createAssistantMessage(streamModel, text);
	setTimeout(() => {
		stream.push({ type: "start", partial: message });
		stream.push({ type: "text_start", contentIndex: 0, partial: message });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
		stream.push({ type: "done", reason: "stop", message });
	}, delayMs);
	return stream;
}

function createAssistantMessage(streamModel: Model<Api>, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: streamModel.api,
		provider: streamModel.provider,
		model: streamModel.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}
