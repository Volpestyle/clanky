/**
 * runtime-smoke.ts
 *
 * Exercises the @clanky/agent factory wiring end-to-end *without* launching
 * InteractiveMode (which needs a real TTY). The test:
 *
 *  1. Picks a tmp homeDir so we never touch ~/.clanky.
 *  2. Calls createClankyRuntime() with an in-memory SessionManager surrogate
 *     by overriding the runtime cwd. (We use SessionManager.create against the
 *     tmp profile sessionsDir, which is equivalent for setup purposes.)
 *  3. Asserts the returned runtime has a live AgentSession, services, and
 *     that clanky's persona was injected into the resource loader.
 *
 * Run via: pnpm exec tsx agents/clanky/test/runtime-smoke.ts
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	DEFAULT_CLANKY_DISCORD_PROVIDER_ID,
	DEFAULT_OPENAI_PROVIDER_ID,
	DEFAULT_XAI_PROVIDER_ID,
	resolveClankyPaths,
	saveStoredDiscordCredential,
	saveStoredOpenAiApiKey,
	saveStoredXAiApiKey,
} from "@clanky/core";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import type { CreateAgentDiscordClientOptions } from "../src/agentDiscordClient.ts";
import {
	evaluateDiscordMessageAcceptance,
	formatDiscordUserMessage,
	isDiscordSkipReplyText,
	parseDiscordBridgeCommand,
	resolveAgentDiscordCredentialConfig,
	resolveAgentDiscordGatewayConfig,
} from "../src/agentDiscordGateway.ts";
import { DEFAULT_REALTIME_MODEL, resolveAgentDiscordVoiceConfig } from "../src/agentDiscordVoice.ts";
import { createDiscordAuthExtensionFactory } from "../src/discordAuth.ts";
import { ClankyDiscordGatewayController } from "../src/discordGatewayController.ts";
import { delegateToMainWorker } from "../src/mainWorkerDelegation.ts";
import { createOpenAiAuthExtensionFactory } from "../src/openAiAuth.ts";
import { createClankyRuntime } from "../src/runClanky.ts";
import { SerialRuntimeTurnQueue } from "../src/runtimeTurnQueue.ts";
import { createXAiAuthExtensionFactory } from "../src/xAiAuth.ts";

async function main(): Promise<void> {
	assertAgentDiscordGatewayConfig();
	assertAgentDiscordGatewayAcceptance();
	assertDiscordBridgeCommands();
	assertAgentDiscordVoiceConfig();
	assertStoredDiscordCredentialPath();
	await assertRuntimeTurnQueue();
	await assertMainWorkerDelegation();
	await assertDiscordAuthExtensionCommands();
	await assertOpenAiAuthExtensionCommands();
	await assertXAiAuthExtensionCommands();
	await assertDiscordGatewayControllerStartup();
	const tmpRoot = await mkdtemp(join(tmpdir(), "clanky-agent-smoke-"));
	const homeDir = join(tmpRoot, "home");
	const cwd = join(tmpRoot, "work");
	await mkdir(cwd, { recursive: true });

	try {
		const { runtime, paths, gatewayController } = await createClankyRuntime({ homeDir, cwd });

		if (runtime.session === undefined) {
			throw new Error("smoke: runtime.session was undefined");
		}
		if (runtime.services === undefined) {
			throw new Error("smoke: runtime.services was undefined");
		}
		if (paths.homeDir !== homeDir) {
			throw new Error(`smoke: paths.homeDir ${paths.homeDir} did not match ${homeDir}`);
		}

		const systemPrompt = runtime.services.resourceLoader.getSystemPrompt() ?? "";
		if (!systemPrompt.includes("Clanky Self")) {
			throw new Error(`smoke: persona not injected into system prompt. Got: ${systemPrompt.slice(0, 120)}...`);
		}
		runtime.session.sessionManager.appendMessage({
			role: "user",
			content: "main session context smoke",
			timestamp: Date.now(),
		});
		const mainContext = gatewayController.mainSessionContext({ limit: 4 });
		if (!mainSessionContextHasText(mainContext, "main session context smoke")) {
			throw new Error(
				`smoke: main_session_context did not expose current main session: ${JSON.stringify(mainContext)}`,
			);
		}

		const skills = runtime.services.resourceLoader.getSkills().skills;
		const skillNames = skills.map((s) => s.name);
		// Bundled clanky skills include browser skills plus operational skills.
		// We don't hard-fail if names changed, but we DO require at least one merged
		// skill so we know the skillsOverride hook fired.
		if (skillNames.length === 0) {
			console.warn("smoke: no skills loaded (expected at least the bundled set)");
		} else {
			console.log(`smoke: loaded ${skillNames.length} skills: ${skillNames.join(", ")}`);
		}
		for (const expectedSkill of [
			"clanky-chrome-cdp",
			"clanky-media-operator",
			"clanky-playwright-browser",
			"clanky-web-operator",
		]) {
			if (!skillNames.includes(expectedSkill)) {
				throw new Error(`smoke: bundled Clanky skill ${expectedSkill} was not loaded`);
			}
		}

		const extensionsResult = runtime.services.resourceLoader.getExtensions();
		console.log(`smoke: loaded ${extensionsResult.extensions.length} extension(s)`);

		await runtime.dispose();
		console.log("runtime-smoke: PASS");
	} finally {
		await rm(tmpRoot, { recursive: true, force: true });
	}
}

function mainSessionContextHasText(value: unknown, expected: string): boolean {
	if (typeof value !== "object" || value === null) return false;
	const entries = (value as Record<string, unknown>).entries;
	if (!Array.isArray(entries)) return false;
	return entries.some((entry) => {
		if (typeof entry !== "object" || entry === null) return false;
		const text = (entry as Record<string, unknown>).text;
		return typeof text === "string" && text.includes(expected);
	});
}

function assertAgentDiscordVoiceConfig(): void {
	if (resolveAgentDiscordVoiceConfig({}) !== undefined) {
		throw new Error("smoke: Discord voice should not start unless CLANKY_DISCORD_VOICE_ENABLED is set");
	}
	assertThrows(
		() => resolveAgentDiscordVoiceConfig({ CLANKY_DISCORD_VOICE_ENABLED: "1" }),
		"stored /discord-login credential",
	);
	const discordConfig = resolveAgentDiscordGatewayConfig({ CLANKY_DISCORD_TOKEN: "token" });
	const voiceConfig = resolveAgentDiscordVoiceConfig(
		{
			CLANKY_DISCORD_VOICE_ENABLED: "1",
			CLANKY_DISCORD_TOKEN: "token",
			CLANKY_DISCORD_VOICE_GUILD_ID: "guild-1",
			CLANKY_DISCORD_VOICE_CHANNEL_ID: "channel-1",
			OPENAI_API_KEY: "openai-key",
		},
		discordConfig,
	);
	if (voiceConfig?.openAiRealtimeModel !== DEFAULT_REALTIME_MODEL) {
		throw new Error(`smoke: default realtime model mismatch, got ${voiceConfig?.openAiRealtimeModel}`);
	}
	if (voiceConfig.guildId !== "guild-1" || voiceConfig.channelId !== "channel-1") {
		throw new Error("smoke: Discord voice guild/channel config did not round-trip");
	}
	const openAiAuthStorage = AuthStorage.inMemory();
	saveStoredOpenAiApiKey(openAiAuthStorage, "stored-openai-key");
	const storedOpenAiVoiceConfig = resolveAgentDiscordVoiceConfig(
		{
			CLANKY_DISCORD_VOICE_ENABLED: "1",
			CLANKY_DISCORD_TOKEN: "token",
			CLANKY_DISCORD_VOICE_GUILD_ID: "guild-1",
			CLANKY_DISCORD_VOICE_CHANNEL_ID: "channel-1",
		},
		discordConfig,
		openAiAuthStorage,
	);
	if (storedOpenAiVoiceConfig?.openAiApiKey !== "stored-openai-key") {
		throw new Error("smoke: stored /openai-login API key should configure Discord voice");
	}
	const voiceOnlyCredentials = resolveAgentDiscordCredentialConfig({
		CLANKY_CHAT_GATEWAY_OWNER: "room",
		CLANKY_DISCORD_TOKEN: "token",
	});
	if (voiceOnlyCredentials === undefined) {
		throw new Error("smoke: Discord credentials should still resolve when chat owner suppresses text gateway");
	}
	const voiceOnlyConfig = resolveAgentDiscordVoiceConfig(
		{
			CLANKY_CHAT_GATEWAY_OWNER: "room",
			CLANKY_DISCORD_VOICE_ENABLED: "1",
			CLANKY_DISCORD_TOKEN: "token",
			CLANKY_DISCORD_VOICE_GUILD_ID: "guild-1",
			CLANKY_DISCORD_VOICE_CHANNEL_ID: "channel-1",
			OPENAI_API_KEY: "openai-key",
		},
		voiceOnlyCredentials,
	);
	if (voiceOnlyConfig === undefined) {
		throw new Error("smoke: Discord voice should be configurable even when agent text gateway is suppressed");
	}
}

function assertAgentDiscordGatewayConfig(): void {
	if (resolveAgentDiscordGatewayConfig({}) !== undefined) {
		throw new Error("smoke: Discord gateway should not start without CLANKY_DISCORD_TOKEN");
	}
	const enrolledConfig = resolveAgentDiscordGatewayConfig({
		AGENTROOM: "1",
		CLANKY_DISCORD_TOKEN: "token",
		CLANKY_DISCORD_CONVERSATION_ID: "conversation-1",
	});
	if (enrolledConfig?.conversationId !== "conversation-1") {
		throw new Error("smoke: AGENTROOM=1 should still allow agent-owned Discord config");
	}
	if (enrolledConfig?.source !== "env") {
		throw new Error(`smoke: env-driven config source should be "env", got ${enrolledConfig?.source}`);
	}
	if (
		resolveAgentDiscordGatewayConfig({
			CLANKY_CHAT_GATEWAY_OWNER: "room",
			CLANKY_DISCORD_TOKEN: "token",
		}) !== undefined
	) {
		throw new Error("smoke: room-owned mode should suppress agent Discord config");
	}
	if (
		resolveAgentDiscordCredentialConfig({
			CLANKY_CHAT_GATEWAY_OWNER: "room",
			CLANKY_DISCORD_TOKEN: "token",
		}) === undefined
	) {
		throw new Error("smoke: room-owned mode should not hide raw Discord credentials from voice");
	}
}

function assertAgentDiscordGatewayAcceptance(): void {
	const config = {
		providerId: "discord",
		token: "token",
		credentialKind: "bot-token" as const,
		source: "env" as const,
	};
	const baseMessage = {
		externalMessageId: "msg-1",
		conversation: { id: "channel-1", kind: "channel" as const },
		sender: { id: "user-1", username: "james" },
		text: "",
		attachments: [],
		mentionsSelf: false,
	};
	const cold = evaluateDiscordMessageAcceptance(
		{
			...baseMessage,
			text: "anyone around?",
		},
		config,
		{
			isEngaged: () => false,
			isKnownSelfMessage: () => false,
			wakeNames: ["clanky", "clank"],
		},
	);
	if (cold.accepted) {
		throw new Error(`smoke: cold unmentioned Discord message should be ignored, got ${cold.reason}`);
	}

	const addressed = evaluateDiscordMessageAcceptance(
		{
			...baseMessage,
			text: "hey clanky can you check this?",
		},
		config,
		{
			isEngaged: () => false,
			isKnownSelfMessage: () => false,
			wakeNames: ["clanky", "clank"],
		},
	);
	if (!addressed.accepted || addressed.reason !== "name_address") {
		throw new Error(`smoke: natural Clanky address should be accepted as name_address, got ${addressed.reason}`);
	}

	const mentioned = evaluateDiscordMessageAcceptance(
		{
			...baseMessage,
			text: "does clanky know about this?",
		},
		config,
		{
			isEngaged: () => false,
			isKnownSelfMessage: () => false,
			wakeNames: ["clanky", "clank"],
		},
	);
	if (!mentioned.accepted || mentioned.reason !== "name_mention") {
		throw new Error(`smoke: natural Clanky mention should be accepted as name_mention, got ${mentioned.reason}`);
	}

	const soundalike = evaluateDiscordMessageAcceptance(
		{
			...baseMessage,
			text: "the cable made a clink sound",
		},
		config,
		{
			isEngaged: () => false,
			isKnownSelfMessage: () => false,
			wakeNames: ["clanky", "clank"],
		},
	);
	if (soundalike.accepted) {
		throw new Error(`smoke: soundalike text should not count as a Clanky mention, got ${soundalike.reason}`);
	}

	const replyToSelf = evaluateDiscordMessageAcceptance(
		{
			...baseMessage,
			text: "what did you mean?",
			replyToExternalMessageId: "sent-1",
		},
		config,
		{
			isEngaged: () => false,
			isKnownSelfMessage: (id) => id === "sent-1",
			wakeNames: ["clanky", "clank"],
		},
	);
	if (!replyToSelf.accepted || replyToSelf.reason !== "reply_to_self") {
		throw new Error(`smoke: direct reply to Clanky should be accepted, got ${replyToSelf.reason}`);
	}

	const followup = evaluateDiscordMessageAcceptance(
		{
			...baseMessage,
			text: "also do the other one",
		},
		config,
		{
			isEngaged: (channelId, userId) => channelId === "channel-1" && userId === "user-1",
			isKnownSelfMessage: () => false,
			wakeNames: ["clanky", "clank"],
		},
	);
	if (!followup.accepted || followup.reason !== "recent_engagement" || followup.recordInboundEngagement) {
		throw new Error("smoke: engaged same-user follow-up should be accepted without immediate engagement reset");
	}

	if (!isDiscordSkipReplyText("[SKIP]") || isDiscordSkipReplyText("[SKIP] actually answer")) {
		throw new Error("smoke: Discord [SKIP] sentinel parsing mismatch");
	}

	const prompt = formatDiscordUserMessage(
		{
			...baseMessage,
			externalMessageId: "msg-2",
			text: "can u send it here",
		},
		"recent_engagement",
		[
			{ author: "vuhlp", text: "suprise me", attachmentLabels: [], messageId: "msg-0" },
			{ author: "Clanky", text: "Generated it at /tmp/clanky-media/grok-surprise-1.jpg", attachmentLabels: [] },
		],
	);
	if (
		!prompt.includes("Recent chat before the newest message") ||
		!prompt.includes("Newest Discord message") ||
		!prompt.includes("If you use a Discord send/upload tool for the current channel") ||
		!prompt.includes("output exactly [SKIP] as your final response instead of posting a duplicate confirmation")
	) {
		throw new Error("smoke: Discord prompt should frame replies as conversation-level decisions");
	}
}

function assertDiscordBridgeCommands(): void {
	const direct = parseDiscordBridgeCommand("/clanky direct what is the current status?");
	if (direct?.type !== "direct" || direct.prompt !== "what is the current status?") {
		throw new Error(`smoke: direct Discord command parsed incorrectly: ${JSON.stringify(direct)}`);
	}
	const shorthandDirect = parseDiscordBridgeCommand("/clanky what is the current status?");
	if (shorthandDirect?.type !== "direct" || shorthandDirect.prompt !== "what is the current status?") {
		throw new Error(`smoke: shorthand Discord command parsed incorrectly: ${JSON.stringify(shorthandDirect)}`);
	}
	const newSession = parseDiscordBridgeCommand("/new");
	if (newSession?.type !== "new") {
		throw new Error(`smoke: /new Discord command parsed incorrectly: ${JSON.stringify(newSession)}`);
	}
	const compact = parseDiscordBridgeCommand("/clanky compact preserve Discord handoff details");
	if (compact?.type !== "compact" || compact.customInstructions !== "preserve Discord handoff details") {
		throw new Error(`smoke: compact Discord command parsed incorrectly: ${JSON.stringify(compact)}`);
	}
	if (parseDiscordBridgeCommand("ordinary Discord chat") !== undefined) {
		throw new Error("smoke: ordinary Discord chat should not parse as a bridge command");
	}
}

function assertStoredDiscordCredentialPath(): void {
	const stored = AuthStorage.inMemory();
	saveStoredDiscordCredential(stored, {
		token: "stored-token",
		credentialKind: "bot-token",
		conversationId: "stored-channel",
		identity: { id: "111", username: "stored-bot" },
	});

	const fromStored = resolveAgentDiscordGatewayConfig({}, stored);
	if (fromStored === undefined) {
		throw new Error("smoke: stored credential should drive gateway when env token is missing");
	}
	if (fromStored.source !== "stored") {
		throw new Error(`smoke: stored config source should be "stored", got ${fromStored.source}`);
	}
	if (fromStored.token !== "stored-token") {
		throw new Error(`smoke: stored token should be returned, got ${fromStored.token}`);
	}
	if (fromStored.conversationId !== "stored-channel") {
		throw new Error(`smoke: stored conversation id should round-trip, got ${fromStored.conversationId}`);
	}
	if (fromStored.providerId !== DEFAULT_CLANKY_DISCORD_PROVIDER_ID) {
		throw new Error(`smoke: stored providerId default mismatch, got ${fromStored.providerId}`);
	}

	const envOverridesStored = resolveAgentDiscordGatewayConfig({ CLANKY_DISCORD_TOKEN: "env-token" }, stored);
	if (envOverridesStored?.source !== "env") {
		throw new Error("smoke: env token should override stored credentials (precedence rule)");
	}
	if (envOverridesStored.token !== "env-token") {
		throw new Error(`smoke: env token should win, got ${envOverridesStored.token}`);
	}

	if (resolveAgentDiscordGatewayConfig({ CLANKY_CHAT_GATEWAY_OWNER: "room" }, stored) !== undefined) {
		throw new Error("smoke: room-owned mode should suppress stored-credential gateway too");
	}
	if (resolveAgentDiscordGatewayConfig({ CLANKY_CHAT_GATEWAY_OWNER: "off" }, stored) !== undefined) {
		throw new Error("smoke: off-owner should suppress stored-credential gateway");
	}

	const empty = AuthStorage.inMemory();
	if (resolveAgentDiscordGatewayConfig({}, empty) !== undefined) {
		throw new Error("smoke: empty AuthStorage with no env should yield undefined");
	}
}

async function assertRuntimeTurnQueue(): Promise<void> {
	const queue = new SerialRuntimeTurnQueue();
	const order: string[] = [];
	let releaseFirst: (() => void) | undefined;
	const first = queue.enqueue(async () => {
		order.push("first-start");
		await new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		order.push("first-end");
		return "first";
	});
	const second = queue.enqueue(async () => {
		order.push("second-start");
		return "second";
	});
	await Promise.resolve();
	if (order.join(",") !== "first-start") {
		throw new Error(`smoke: runtime turn queue did not block second task, order=${order.join(",")}`);
	}
	releaseFirst?.();
	if ((await first) !== "first" || (await second) !== "second") {
		throw new Error("smoke: runtime turn queue returned wrong task results");
	}
	if (order.join(",") !== "first-start,first-end,second-start") {
		throw new Error(`smoke: runtime turn queue serialized in wrong order: ${order.join(",")}`);
	}
	await assertRejects(() => queue.enqueue(async () => Promise.reject(new Error("queued failure"))), "queued failure");
	const afterFailure = await queue.enqueue(async () => "after-failure");
	if (afterFailure !== "after-failure") {
		throw new Error("smoke: runtime turn queue did not recover after a failed task");
	}

	const promptCalls: string[] = [];
	const promptRuntime = {
		session: {
			isStreaming: true,
			sessionId: "auto-prompt-smoke",
			async prompt(message: string, options?: { source?: string; streamingBehavior?: string }): Promise<void> {
				promptCalls.push(`${options?.source}:${options?.streamingBehavior}:${message}`);
			},
		},
	};
	const promptResult = await queue.enqueuePrompt(promptRuntime as never, "queued main work");
	if (promptResult.mode !== "followUp" || promptResult.sessionId !== "auto-prompt-smoke") {
		throw new Error(`smoke: runtime turn queue returned wrong prompt result ${JSON.stringify(promptResult)}`);
	}
	if (promptCalls.join("\n") !== "extension:followUp:queued main work") {
		throw new Error(`smoke: runtime turn queue did not auto-prompt safely ${JSON.stringify(promptCalls)}`);
	}
}

async function assertMainWorkerDelegation(): Promise<void> {
	const calls: string[] = [];
	const session = {
		isStreaming: true,
		sessionId: "main-delegate-smoke",
		async prompt(message: string, options?: { source?: string; streamingBehavior?: string }): Promise<void> {
			calls.push(`prompt:${options?.source}:${options?.streamingBehavior}:${message}`);
		},
	};
	const result = delegateToMainWorker(
		{
			title: "Long Discord work",
			prompt: "Handle this task from Discord when the main worker is free.",
			reason: "longer than a Discord quick reply",
		},
		{
			runtime: { session } as never,
			runtimeTurnQueue: new SerialRuntimeTurnQueue(),
			now: () => new Date("2026-01-01T00:00:00.000Z"),
		},
	);
	if (
		!result.delegated ||
		result.mode !== "followUp" ||
		!result.autoPrompt ||
		result.sessionId !== "main-delegate-smoke"
	) {
		throw new Error(`smoke: streaming main delegation returned wrong result ${JSON.stringify(result)}`);
	}
	await delay(0);
	if (
		!calls.some(
			(call) =>
				call.startsWith("prompt:extension:followUp:") &&
				call.includes("Long Discord work") &&
				call.includes("Handle this task from Discord"),
		)
	) {
		throw new Error(`smoke: streaming main delegation did not auto-prompt ${JSON.stringify(calls)}`);
	}

	session.isStreaming = false;
	const idleResult = delegateToMainWorker(
		{
			title: "Idle main work",
			prompt: "Start this now.",
		},
		{
			runtime: { session } as never,
			runtimeTurnQueue: new SerialRuntimeTurnQueue(),
			now: () => new Date("2026-01-01T00:01:00.000Z"),
		},
	);
	if (!idleResult.delegated || idleResult.mode !== "start" || !idleResult.autoPrompt) {
		throw new Error(`smoke: idle main delegation returned wrong result ${JSON.stringify(idleResult)}`);
	}
	await delay(0);
	if (!calls.some((call) => call.startsWith("prompt:extension:followUp:") && call.includes("Idle main work"))) {
		throw new Error(`smoke: idle main delegation did not auto-prompt main turn ${JSON.stringify(calls)}`);
	}
}

async function assertDiscordAuthExtensionCommands(): Promise<void> {
	const authStorage = AuthStorage.inMemory();
	saveStoredDiscordCredential(authStorage, {
		token: "stored-token",
		credentialKind: "user-token",
		conversationId: "stored-channel",
		identity: { id: "111", username: "stored-user" },
	});
	let restarts = 0;
	const notifications: string[] = [];
	const commands: Record<string, RegisteredCommand> = {};
	const factory = createDiscordAuthExtensionFactory({
		authStorage,
		providerId: DEFAULT_CLANKY_DISCORD_PROVIDER_ID,
		authFilePath: "/tmp/clanky-auth.json",
		gatewayController: {
			async restart() {
				restarts += 1;
			},
			status() {
				return {
					textBridgeActive: true,
					voiceBridgeActive: true,
					voiceOnlyClientActive: false,
					voice: {
						guildId: "guild-1",
						channelId: "voice-1",
						model: DEFAULT_REALTIME_MODEL,
						discordCredentialKind: "user-token",
						nativeScreenWatchSupported: true,
						discoveredStreams: 1,
						activeStreamWatchKey: "guild:guild-1:voice-1:user-1",
						stats: {
							discordInputAudioEventCount: 2,
							discordInputUniqueSpeakerCount: 2,
							discordInputMaxConcurrentSpeakers: 2,
							realtimeAudioDeltaCount: 3,
							realtimeFunctionCallCount: 4,
							decodedVideoFrameCount: 5,
							realtimeTranscriptCount: 6,
							realtimeErrorEventCount: 7,
							realtimeSocketErrorCount: 8,
							realtimeSocketCloseCount: 9,
						},
					},
				};
			},
		} as never,
	});
	factory({
		registerCommand(name: string, command: RegisteredCommand) {
			commands[name] = command;
		},
	} as never);
	const ctx = {
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
		},
	};
	const statusCommand = commands["discord-status"];
	if (statusCommand === undefined) throw new Error("smoke: /discord-status command was not registered");
	await statusCommand.handler([], ctx);
	if (
		!notifications.some(
			(message) =>
				message.includes("Voice bridge: active.") &&
				message.includes("Realtime model:") &&
				message.includes("Native screen watch: supported.") &&
				message.includes("Voice stats: input audio 2, output audio 3, realtime tool calls 4, decoded frames 5.") &&
				message.includes("Voice speakers: unique 2, max concurrent 2.") &&
				message.includes("Realtime status: transcripts 6, API errors 7, socket errors 8, socket closes 9."),
		)
	) {
		throw new Error(`smoke: /discord-status did not report voice bridge status: ${notifications.join("\n---\n")}`);
	}

	const logoutCommand = commands["discord-logout"];
	if (logoutCommand === undefined) throw new Error("smoke: /discord-logout command was not registered");
	await logoutCommand.handler([], ctx);
	if (restarts !== 1) throw new Error(`smoke: /discord-logout should hot-restart bridge once, got ${restarts}`);
	if (resolveAgentDiscordGatewayConfig({}, authStorage) !== undefined) {
		throw new Error("smoke: /discord-logout should remove stored Discord credentials");
	}
	if (!notifications.some((message) => message.includes("Discord bridge restarted after logout."))) {
		throw new Error("smoke: /discord-logout did not report bridge restart after logout");
	}
}

async function assertOpenAiAuthExtensionCommands(): Promise<void> {
	const authStorage = AuthStorage.inMemory();
	saveStoredOpenAiApiKey(authStorage, "stored-openai-key");
	let reloads = 0;
	const notifications: string[] = [];
	const commands: Record<string, RegisteredCommand> = {};
	const factory = createOpenAiAuthExtensionFactory({
		authStorage,
		authFilePath: "/tmp/clanky-auth.json",
	});
	factory({
		registerCommand(name: string, command: RegisteredCommand) {
			commands[name] = command;
		},
	} as never);
	const ctx = {
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
		},
		async reload() {
			reloads += 1;
		},
	};

	const whoamiCommand = commands["openai-whoami"];
	if (whoamiCommand === undefined) throw new Error("smoke: /openai-whoami command was not registered");
	await whoamiCommand.handler([], ctx);
	if (
		!notifications.some(
			(message) =>
				message.includes("Stored OpenAI credential type: api_key.") &&
				message.includes(`provider id "${DEFAULT_OPENAI_PROVIDER_ID}"`) &&
				message.includes("Active OpenAI credential source: stored:api_key."),
		)
	) {
		throw new Error(`smoke: /openai-whoami did not report stored OpenAI key: ${notifications.join("\n---\n")}`);
	}

	const logoutCommand = commands["openai-logout"];
	if (logoutCommand === undefined) throw new Error("smoke: /openai-logout command was not registered");
	await logoutCommand.handler([], ctx);
	if (authStorage.get(DEFAULT_OPENAI_PROVIDER_ID) !== undefined) {
		throw new Error("smoke: /openai-logout should remove stored OpenAI credentials");
	}
	if (reloads !== 1) throw new Error(`smoke: /openai-logout should reload once, got ${reloads}`);
	if (!notifications.some((message) => message.includes("Removed stored OpenAI api_key credential"))) {
		throw new Error("smoke: /openai-logout did not report credential removal");
	}
}

async function assertXAiAuthExtensionCommands(): Promise<void> {
	const authStorage = AuthStorage.inMemory();
	saveStoredXAiApiKey(authStorage, "stored-xai-key");
	let reloads = 0;
	const notifications: string[] = [];
	const commands: Record<string, RegisteredCommand> = {};
	const factory = createXAiAuthExtensionFactory({
		authStorage,
		authFilePath: "/tmp/clanky-auth.json",
	});
	factory({
		registerCommand(name: string, command: RegisteredCommand) {
			commands[name] = command;
		},
	} as never);
	const ctx = {
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
		},
		async reload() {
			reloads += 1;
		},
	};

	const whoamiCommand = commands["xai-whoami"];
	if (whoamiCommand === undefined) throw new Error("smoke: /xai-whoami command was not registered");
	await whoamiCommand.handler([], ctx);
	if (
		!notifications.some(
			(message) =>
				message.includes("Stored xAI credential type: api_key.") &&
				message.includes(`provider id "${DEFAULT_XAI_PROVIDER_ID}"`) &&
				message.includes("Active xAI credential source: stored:api_key."),
		)
	) {
		throw new Error(`smoke: /xai-whoami did not report stored xAI key: ${notifications.join("\n---\n")}`);
	}

	const logoutCommand = commands["xai-logout"];
	if (logoutCommand === undefined) throw new Error("smoke: /xai-logout command was not registered");
	await logoutCommand.handler([], ctx);
	if (authStorage.get(DEFAULT_XAI_PROVIDER_ID) !== undefined) {
		throw new Error("smoke: /xai-logout should remove stored xAI credentials");
	}
	if (reloads !== 1) throw new Error(`smoke: /xai-logout should reload once, got ${reloads}`);
	if (!notifications.some((message) => message.includes("Removed stored xAI api_key credential"))) {
		throw new Error("smoke: /xai-logout did not report credential removal");
	}
}

interface RegisteredCommand {
	handler(args: unknown, ctx: unknown): unknown | Promise<unknown>;
}

function testControllerPaths() {
	return resolveClankyPaths({ homeDir: join(tmpdir(), "clanky-controller-smoke") });
}

async function assertDiscordGatewayControllerStartup(): Promise<void> {
	await assertControllerSharedChatAndVoiceStartup();
	await assertControllerVoiceOnlyStartup();
	await assertControllerSharedVoiceFailureCleanup();
	await assertControllerVoiceOnlyFailureCleanup();
}

async function assertControllerSharedChatAndVoiceStartup(): Promise<void> {
	const authStorage = AuthStorage.inMemory();
	const calls = createControllerCallRecorder();
	const controller = new ClankyDiscordGatewayController({
		authStorage,
		paths: testControllerPaths(),
		env: {
			CLANKY_DISCORD_TOKEN: "discord-token",
			CLANKY_DISCORD_VOICE_ENABLED: "1",
			CLANKY_DISCORD_VOICE_GUILD_ID: "guild-1",
			CLANKY_DISCORD_VOICE_CHANNEL_ID: "voice-1",
			OPENAI_API_KEY: "openai-key",
		},
		dependencies: {
			createClient(options) {
				calls.createdClientOptions.push(options ?? {});
				return calls.sharedClient as never;
			},
			async loginClient() {
				calls.loginCalls += 1;
			},
			async startGateway(input) {
				calls.startGatewayCalls += 1;
				calls.gatewayRuntimeTurnQueue = input.runtimeTurnQueue;
				if ((input.client as unknown) !== calls.sharedClient)
					throw new Error("smoke: shared path did not pass created client to text gateway");
				return {
					client: calls.sharedClient as never,
					async stop() {
						calls.textStops += 1;
					},
				};
			},
			async startVoice(input) {
				calls.startVoiceCalls += 1;
				calls.voiceRuntimeTurnQueue = input.runtimeTurnQueue;
				if ((input.client as unknown) !== calls.sharedClient)
					throw new Error("smoke: shared path did not reuse text gateway client");
				return createFakeVoiceHandle(calls);
			},
		},
	});
	controller.bindRuntime({} as never);
	await controller.start();
	const status = controller.status();
	const created = calls.createdClientOptions[0];
	if (created === undefined || created.voice !== true || created.chat !== true) {
		throw new Error("smoke: shared path should create a chat+voice Discord client");
	}
	if (calls.startGatewayCalls !== 1 || calls.loginCalls !== 0 || calls.startVoiceCalls !== 1) {
		throw new Error("smoke: shared path should start text gateway once, skip voice-only login, and start voice once");
	}
	if (calls.gatewayRuntimeTurnQueue === undefined || calls.gatewayRuntimeTurnQueue !== calls.voiceRuntimeTurnQueue) {
		throw new Error("smoke: shared path should pass one runtime turn queue to text and voice");
	}
	if (status.textBridgeActive !== true || status.voiceBridgeActive !== true || status.voiceOnlyClientActive !== false) {
		throw new Error(`smoke: shared path status mismatch: ${JSON.stringify(status)}`);
	}
	controller.requestVoiceTextUtterance("scripted validation prompt");
	if (calls.voiceTextUtterances[0] !== "scripted validation prompt") {
		throw new Error("smoke: controller did not forward scripted voice prompt to active voice bridge");
	}
	await controller.stop();
	if (calls.voiceStops !== 1 || calls.textStops !== 1 || calls.sharedClient.destroyCalls !== 0) {
		throw new Error("smoke: shared path stop should stop voice and text gateway without direct client destroy");
	}
}

async function assertControllerVoiceOnlyStartup(): Promise<void> {
	const authStorage = AuthStorage.inMemory();
	const calls = createControllerCallRecorder();
	const controller = new ClankyDiscordGatewayController({
		authStorage,
		paths: testControllerPaths(),
		env: {
			CLANKY_CHAT_GATEWAY_OWNER: "room",
			CLANKY_DISCORD_TOKEN: "discord-token",
			CLANKY_DISCORD_VOICE_ENABLED: "1",
			CLANKY_DISCORD_VOICE_GUILD_ID: "guild-1",
			CLANKY_DISCORD_VOICE_CHANNEL_ID: "voice-1",
			OPENAI_API_KEY: "openai-key",
		},
		dependencies: {
			createClient(options) {
				calls.createdClientOptions.push(options ?? {});
				return calls.sharedClient as never;
			},
			async loginClient(client, config) {
				calls.loginCalls += 1;
				if ((client as unknown) !== calls.sharedClient)
					throw new Error("smoke: voice-only path logged in the wrong client");
				if (config.token !== "discord-token") throw new Error("smoke: voice-only path used wrong Discord token");
				(calls.sharedClient as FakeControllerDiscordClient).ready = true;
			},
			async startGateway() {
				calls.startGatewayCalls += 1;
				throw new Error("smoke: voice-only path should not start the text gateway");
			},
			async startVoice(input) {
				calls.startVoiceCalls += 1;
				calls.voiceRuntimeTurnQueue = input.runtimeTurnQueue;
				if ((input.client as unknown) !== calls.sharedClient)
					throw new Error("smoke: voice-only path did not pass logged-in client");
				return createFakeVoiceHandle(calls);
			},
		},
	});
	controller.bindRuntime({} as never);
	await controller.start();
	const status = controller.status();
	const created = calls.createdClientOptions[0];
	if (created === undefined || created.voice !== true || created.chat !== false) {
		throw new Error("smoke: voice-only path should create a voice-only Discord client");
	}
	if (calls.startGatewayCalls !== 0 || calls.loginCalls !== 1 || calls.startVoiceCalls !== 1) {
		throw new Error("smoke: voice-only path should skip text gateway, login once, and start voice once");
	}
	if (calls.voiceRuntimeTurnQueue === undefined) {
		throw new Error("smoke: voice-only path should pass a runtime turn queue to voice");
	}
	if (status.textBridgeActive !== false || status.voiceBridgeActive !== true || status.voiceOnlyClientActive !== true) {
		throw new Error(`smoke: voice-only path status mismatch: ${JSON.stringify(status)}`);
	}
	await controller.stop();
	if (calls.voiceStops !== 1 || calls.textStops !== 0 || calls.sharedClient.destroyCalls !== 1) {
		throw new Error("smoke: voice-only path stop should stop voice and destroy voice-only client");
	}
}

async function assertControllerSharedVoiceFailureCleanup(): Promise<void> {
	const authStorage = AuthStorage.inMemory();
	const calls = createControllerCallRecorder();
	const controller = new ClankyDiscordGatewayController({
		authStorage,
		paths: testControllerPaths(),
		env: {
			CLANKY_DISCORD_TOKEN: "discord-token",
			CLANKY_DISCORD_VOICE_ENABLED: "1",
			CLANKY_DISCORD_VOICE_GUILD_ID: "guild-1",
			CLANKY_DISCORD_VOICE_CHANNEL_ID: "voice-1",
			OPENAI_API_KEY: "openai-key",
		},
		dependencies: {
			createClient(options) {
				calls.createdClientOptions.push(options ?? {});
				return calls.sharedClient as never;
			},
			async startGateway() {
				calls.startGatewayCalls += 1;
				return {
					client: calls.sharedClient as never,
					async stop() {
						calls.textStops += 1;
					},
				};
			},
			async startVoice() {
				calls.startVoiceCalls += 1;
				throw new Error("voice failed");
			},
		},
	});
	controller.bindRuntime({} as never);
	await assertRejects(() => controller.start(), "voice failed");
	const status = controller.status();
	if (calls.startGatewayCalls !== 1 || calls.startVoiceCalls !== 1 || calls.textStops !== 1) {
		throw new Error("smoke: shared voice failure should stop the already-started text gateway");
	}
	if (calls.sharedClient.destroyCalls !== 0) {
		throw new Error("smoke: shared voice failure should let text gateway own client teardown");
	}
	if (status.textBridgeActive || status.voiceBridgeActive || status.voiceOnlyClientActive) {
		throw new Error(`smoke: shared voice failure left active controller state: ${JSON.stringify(status)}`);
	}
}

async function assertControllerVoiceOnlyFailureCleanup(): Promise<void> {
	const authStorage = AuthStorage.inMemory();
	const calls = createControllerCallRecorder();
	const controller = new ClankyDiscordGatewayController({
		authStorage,
		paths: testControllerPaths(),
		env: {
			CLANKY_CHAT_GATEWAY_OWNER: "room",
			CLANKY_DISCORD_TOKEN: "discord-token",
			CLANKY_DISCORD_VOICE_ENABLED: "1",
			CLANKY_DISCORD_VOICE_GUILD_ID: "guild-1",
			CLANKY_DISCORD_VOICE_CHANNEL_ID: "voice-1",
			OPENAI_API_KEY: "openai-key",
		},
		dependencies: {
			createClient(options) {
				calls.createdClientOptions.push(options ?? {});
				return calls.sharedClient as never;
			},
			async loginClient() {
				calls.loginCalls += 1;
			},
			async startGateway() {
				calls.startGatewayCalls += 1;
				throw new Error("smoke: voice-only failure path should not start text gateway");
			},
			async startVoice() {
				calls.startVoiceCalls += 1;
				throw new Error("voice failed");
			},
		},
	});
	controller.bindRuntime({} as never);
	await assertRejects(() => controller.start(), "voice failed");
	const status = controller.status();
	if (calls.startGatewayCalls !== 0 || calls.loginCalls !== 1 || calls.startVoiceCalls !== 1) {
		throw new Error("smoke: voice-only failure should skip text gateway, login once, and attempt voice once");
	}
	if (calls.sharedClient.destroyCalls !== 1) {
		throw new Error("smoke: voice-only failure should destroy the logged-in voice-only client");
	}
	if (status.textBridgeActive || status.voiceBridgeActive || status.voiceOnlyClientActive) {
		throw new Error(`smoke: voice-only failure left active controller state: ${JSON.stringify(status)}`);
	}
}

function createControllerCallRecorder(): {
	sharedClient: FakeControllerDiscordClient;
	createdClientOptions: CreateAgentDiscordClientOptions[];
	gatewayRuntimeTurnQueue: unknown;
	voiceRuntimeTurnQueue: unknown;
	loginCalls: number;
	startGatewayCalls: number;
	startVoiceCalls: number;
	textStops: number;
	voiceStops: number;
	voiceTextUtterances: string[];
} {
	return {
		sharedClient: new FakeControllerDiscordClient(),
		createdClientOptions: [],
		gatewayRuntimeTurnQueue: undefined,
		voiceRuntimeTurnQueue: undefined,
		loginCalls: 0,
		startGatewayCalls: 0,
		startVoiceCalls: 0,
		textStops: 0,
		voiceStops: 0,
		voiceTextUtterances: [],
	};
}

function createFakeVoiceHandle(calls: { voiceStops: number; voiceTextUtterances: string[] }) {
	return {
		async stop() {
			calls.voiceStops += 1;
		},
		requestTextUtterance(text: string) {
			calls.voiceTextUtterances.push(text);
		},
		status() {
			return { fake: true };
		},
	};
}

class FakeControllerDiscordClient {
	ready = true;
	destroyCalls = 0;

	isReady(): boolean {
		return this.ready;
	}

	async login(): Promise<string> {
		this.ready = true;
		return "logged-in";
	}

	destroy(): void {
		this.destroyCalls += 1;
		this.ready = false;
	}
}

function assertThrows(fn: () => unknown, expectedMessagePart: string): void {
	try {
		fn();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!message.includes(expectedMessagePart)) {
			throw new Error(`smoke: expected error containing "${expectedMessagePart}", got "${message}"`);
		}
		return;
	}
	throw new Error(`smoke: expected function to throw "${expectedMessagePart}"`);
}

async function assertRejects(fn: () => Promise<unknown>, expectedMessagePart: string): Promise<void> {
	try {
		await fn();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!message.includes(expectedMessagePart)) {
			throw new Error(`smoke: expected rejection containing "${expectedMessagePart}", got "${message}"`);
		}
		return;
	}
	throw new Error(`smoke: expected promise to reject "${expectedMessagePart}"`);
}

main().catch((error: unknown) => {
	console.error("runtime-smoke: FAIL");
	console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
	process.exit(1);
});
