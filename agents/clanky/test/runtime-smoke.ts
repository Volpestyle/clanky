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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	DEFAULT_CLANKY_DISCORD_PROVIDER_ID,
	DEFAULT_ELEVENLABS_PROVIDER_ID,
	DEFAULT_OPENAI_PROVIDER_ID,
	DEFAULT_XAI_PROVIDER_ID,
	resolveClankyPaths,
	resolveMcpServerConfigs,
	resolvePortableClankyDefaults,
	saveStoredDiscordCredential,
	saveStoredElevenLabsApiKey,
	saveStoredOpenAiApiKey,
	saveStoredXAiApiKey,
} from "@clanky/core";
import {
	AuthStorage,
	type ExtensionCommandContext,
	type ExtensionFactory,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { CreateAgentDiscordClientOptions } from "../src/agentDiscordClient.ts";
import {
	evaluateDiscordMessageAcceptance,
	formatDiscordUserMessage,
	isDiscordSkipReplyText,
	parseDiscordBridgeCommand,
	resolveAgentDiscordCredentialConfig,
	resolveAgentDiscordGatewayConfig,
	resolveDiscordPromptImages,
	shouldRouteDiscordMessageToSubagent,
} from "../src/agentDiscordGateway.ts";
import { DEFAULT_REALTIME_MODEL, resolveAgentDiscordVoiceConfig } from "../src/agentDiscordVoice.ts";
import { createClankyAuthExtensionFactory } from "../src/authCommands.ts";
import { createDiscordAuthExtensionFactory } from "../src/discordAuth.ts";
import { ClankyDiscordGatewayController } from "../src/discordGatewayController.ts";
import type { StoredDiscordVoiceSettings } from "../src/discordVoiceSettings.ts";
import { DEFAULT_DISCORD_WAKE_NAMES } from "../src/discordWakeNames.ts";
import { delegateToMainWorker } from "../src/mainWorkerDelegation.ts";
import { createOpenAiAuthExtensionFactory } from "../src/openAiAuth.ts";
import {
	createClankyEffortExtensionFactory,
	createClankyRuntime,
	DEFAULT_CLANKY_MAIN_THINKING_LEVEL,
	DEFAULT_CLANKY_MODEL_ID,
	DEFAULT_CLANKY_MODEL_PROVIDER,
	DEFAULT_CLANKY_SUBAGENT_THINKING_LEVEL,
} from "../src/runClanky.ts";
import { SerialRuntimeTurnQueue } from "../src/runtimeTurnQueue.ts";
import { createClankySetupExtensionFactory } from "../src/setupWizard.ts";
import { createClankyVoiceLogsExtensionFactory, readVoiceLogTail } from "../src/voiceLogs.ts";
import { createXAiAuthExtensionFactory } from "../src/xAiAuth.ts";

async function main(): Promise<void> {
	assertAgentDiscordGatewayConfig();
	assertAgentDiscordGatewayAcceptance();
	assertDiscordSubagentRouting();
	await assertAgentDiscordPromptImages();
	assertDiscordBridgeCommands();
	assertAgentDiscordVoiceConfig();
	await assertStoredDiscordCredentialPath();
	await assertRuntimeTurnQueue();
	await assertMainWorkerDelegation();
	await assertDiscordAuthExtensionCommands();
	await assertClankyAuthExtensionCommand();
	await assertOpenAiAuthExtensionCommands();
	await assertXAiAuthExtensionCommands();
	await assertClankyEffortExtensionCommand();
	await assertClankySetupExtensionCommand();
	await assertClankyVoiceLogsExtensionCommand();
	await assertDiscordGatewayControllerStartup();
	await assertAgentRoomPortableConfigDefaults();
	const tmpRoot = await mkdtemp(join(tmpdir(), "clanky-agent-smoke-"));
	const homeDir = join(tmpRoot, "home");
	const cwd = join(tmpRoot, "work");
	await mkdir(cwd, { recursive: true });

	try {
		const { runtime, paths, gatewayController, createSubagentRuntime } = await createClankyRuntime({ homeDir, cwd });

		if (runtime.session === undefined) {
			throw new Error("smoke: runtime.session was undefined");
		}
		if (runtime.services === undefined) {
			throw new Error("smoke: runtime.services was undefined");
		}
		if (runtime.session.getToolDefinition("delegate_to_main_worker") !== undefined) {
			throw new Error("smoke: main runtime should not expose delegate_to_main_worker");
		}
		if (paths.homeDir !== homeDir) {
			throw new Error(`smoke: paths.homeDir ${paths.homeDir} did not match ${homeDir}`);
		}
		assertClankyRuntimeDefaults(runtime, DEFAULT_CLANKY_MAIN_THINKING_LEVEL, "main runtime");

		const subagentResult = await createSubagentRuntime({
			cwd,
			agentDir: paths.profileDir,
			sessionManager: SessionManager.create(cwd, paths.subagentSessionsDir),
		});
		try {
			assertClankyRuntimeDefaults(subagentResult, DEFAULT_CLANKY_SUBAGENT_THINKING_LEVEL, "subagent runtime");
			if (subagentResult.session.getToolDefinition("delegate_to_main_worker") === undefined) {
				throw new Error("smoke: subagent runtime should expose delegate_to_main_worker");
			}
		} finally {
			subagentResult.session.dispose();
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

interface RuntimeDefaultsTarget {
	session: {
		model:
			| {
					provider: string;
					id: string;
			  }
			| undefined;
		thinkingLevel: string;
	};
	services: {
		settingsManager: {
			getCompactionEnabled(): boolean;
		};
	};
}

function assertClankyRuntimeDefaults(
	target: RuntimeDefaultsTarget,
	expectedThinkingLevel: string,
	label: string,
): void {
	const model = target.session.model;
	if (model?.provider !== DEFAULT_CLANKY_MODEL_PROVIDER || model.id !== DEFAULT_CLANKY_MODEL_ID) {
		throw new Error(`smoke: ${label} default model mismatch, got ${model?.provider ?? "none"}/${model?.id ?? "none"}`);
	}
	if (target.session.thinkingLevel !== expectedThinkingLevel) {
		throw new Error(
			`smoke: ${label} default thinking mismatch, got ${target.session.thinkingLevel}, expected ${expectedThinkingLevel}`,
		);
	}
	if (!target.services.settingsManager.getCompactionEnabled()) {
		throw new Error(`smoke: ${label} should leave Pi auto-compaction enabled`);
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

async function assertAgentRoomPortableConfigDefaults(): Promise<void> {
	const tmpRoot = await mkdtemp(join(tmpdir(), "clanky-agentroom-portable-"));
	const cwd = join(tmpRoot, "work");
	await mkdir(join(cwd, ".agentroom"), { recursive: true });
	await writeFile(
		join(cwd, ".agentroom", "config.yaml"),
		`room:
  id: portable-smoke

runtime:
  default: fake

workTracker:
  default: linear
  providers:
    linear:
      type: linear
      teamId: team_123

clanky:
  home: .clanky-room
  profile: lead
  chatGatewayOwner: room

runtimes:
  fake:
    type: fake

storage:
  driver: jsonl
  path: .agentroom/events.jsonl
`,
	);
	try {
		const defaults = resolvePortableClankyDefaults({ cwd, env: {} });
		if (defaults.homeDir !== join(cwd, ".clanky-room")) {
			throw new Error(`smoke: portable Clanky home mismatch: ${defaults.homeDir}`);
		}
		if (defaults.profile !== "lead") {
			throw new Error(`smoke: portable Clanky profile mismatch: ${defaults.profile}`);
		}
		if (defaults.env.CLANKY_CHAT_GATEWAY_OWNER !== "room") {
			throw new Error("smoke: portable Clanky chat owner was not applied");
		}
		if (defaults.env.CLANKY_WORK_TRACKER !== "linear" || defaults.env.CLANKY_WORK_TRACKER_TEAM_ID !== "team_123") {
			throw new Error(`smoke: portable work tracker env mismatch: ${JSON.stringify(defaults.env)}`);
		}
		const { runtime, paths } = await createClankyRuntime({ cwd });
		try {
			if (paths.homeDir !== join(cwd, ".clanky-room") || paths.profile !== "lead") {
				throw new Error(`smoke: runtime did not adopt portable Clanky config: ${JSON.stringify(paths)}`);
			}
		} finally {
			await runtime.dispose();
		}
	} finally {
		await rm(tmpRoot, { recursive: true, force: true });
	}
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
	if (voiceConfig.realtimeAgentProvider !== "openai") {
		throw new Error("smoke: default realtime agent provider should be OpenAI");
	}
	if (voiceConfig.guildId !== "guild-1" || voiceConfig.channelId !== "channel-1") {
		throw new Error("smoke: Discord voice guild/channel config did not round-trip");
	}
	const xAiVoiceConfig = resolveAgentDiscordVoiceConfig(
		{
			CLANKY_DISCORD_VOICE_ENABLED: "1",
			CLANKY_DISCORD_TOKEN: "token",
			CLANKY_DISCORD_VOICE_GUILD_ID: "guild-1",
			CLANKY_DISCORD_VOICE_CHANNEL_ID: "channel-1",
			OPENAI_API_KEY: "openai-key",
			XAI_API_KEY: "xai-key",
			CLANKY_DISCORD_VOICE_REALTIME_AGENT_PROVIDER: "xai",
		},
		discordConfig,
	);
	if (
		xAiVoiceConfig?.realtimeAgentProvider !== "xai" ||
		xAiVoiceConfig.xAiApiKey !== "xai-key" ||
		xAiVoiceConfig.xAiRealtimeModel !== "grok-voice-latest" ||
		xAiVoiceConfig.xAiRealtimeVoice !== "eve"
	) {
		throw new Error(`smoke: xAI realtime voice config did not resolve ${JSON.stringify(xAiVoiceConfig)}`);
	}
	const dynamicVoiceConfig = resolveAgentDiscordVoiceConfig(
		{
			CLANKY_DISCORD_VOICE_ENABLED: "1",
			CLANKY_DISCORD_TOKEN: "token",
			OPENAI_API_KEY: "openai-key",
		},
		discordConfig,
	);
	if (
		dynamicVoiceConfig === undefined ||
		dynamicVoiceConfig.guildId !== undefined ||
		dynamicVoiceConfig.channelId !== undefined
	) {
		throw new Error(
			`smoke: Discord voice should support enabled access without pinned target ${JSON.stringify(dynamicVoiceConfig)}`,
		);
	}
	const allowedVoiceConfig = resolveAgentDiscordVoiceConfig(
		{
			CLANKY_DISCORD_VOICE_ENABLED: "1",
			CLANKY_DISCORD_TOKEN: "token",
			OPENAI_API_KEY: "openai-key",
			CLANKY_DISCORD_VOICE_ALLOWED_GUILD_IDS: "guild-a, guild-b guild-a",
			CLANKY_DISCORD_VOICE_ALLOWED_CHANNEL_IDS: "voice-a, voice-b voice-a",
		},
		discordConfig,
	);
	if (
		allowedVoiceConfig?.allowedGuildIds?.join(",") !== "guild-a,guild-b" ||
		allowedVoiceConfig.allowedChannelIds?.join(",") !== "voice-a,voice-b"
	) {
		throw new Error(`smoke: Discord voice allowlist env did not parse ${JSON.stringify(allowedVoiceConfig)}`);
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
	saveStoredElevenLabsApiKey(openAiAuthStorage, "stored-elevenlabs-key");
	const storedElevenLabsVoiceConfig = resolveAgentDiscordVoiceConfig(
		{
			CLANKY_DISCORD_VOICE_ENABLED: "1",
			CLANKY_DISCORD_TOKEN: "token",
			CLANKY_DISCORD_VOICE_GUILD_ID: "guild-1",
			CLANKY_DISCORD_VOICE_CHANNEL_ID: "channel-1",
		},
		discordConfig,
		openAiAuthStorage,
		{
			enabled: true,
			ttsProvider: "elevenlabs",
			elevenLabsVoiceId: "stored-eleven-voice",
			elevenLabsOutputFormat: "pcm_16000",
			elevenLabsBaseUrl: "https://api.example.test",
		},
	);
	if (
		storedElevenLabsVoiceConfig?.elevenLabsApiKey !== "stored-elevenlabs-key" ||
		storedElevenLabsVoiceConfig.elevenLabsOutputFormat !== "pcm_16000" ||
		storedElevenLabsVoiceConfig.elevenLabsBaseUrl !== "https://api.example.test"
	) {
		throw new Error("smoke: stored /elevenlabs-login API key should configure Discord voice");
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

	const voiceAliasAddressed = evaluateDiscordMessageAcceptance(
		{
			...baseMessage,
			text: "hey cranky can you check this?",
		},
		config,
		{
			isEngaged: () => false,
			isKnownSelfMessage: () => false,
			wakeNames: DEFAULT_DISCORD_WAKE_NAMES,
		},
	);
	if (!voiceAliasAddressed.accepted || voiceAliasAddressed.reason !== "name_address") {
		throw new Error(
			`smoke: typed voice-style Clanky alias should be accepted as name_address, got ${voiceAliasAddressed.reason}`,
		);
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

	const channelFollowup = evaluateDiscordMessageAcceptance(
		{
			...baseMessage,
			sender: { id: "user-2", username: "ava" },
			text: "yeah, what about this case?",
		},
		config,
		{
			isEngaged: (channelId) => channelId === "channel-1",
			isKnownSelfMessage: () => false,
			wakeNames: ["clanky", "clank"],
		},
	);
	if (!channelFollowup.accepted || channelFollowup.reason !== "recent_engagement") {
		throw new Error(`smoke: engaged channel follow-up should be accepted, got ${channelFollowup.reason}`);
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
		!prompt.includes("output exactly [SKIP] as your final response instead of posting a duplicate confirmation") ||
		!prompt.includes("channelOrThreadId: channel-1") ||
		!prompt.includes("use discord_read_messages with channelOrThreadId")
	) {
		throw new Error("smoke: Discord prompt should frame replies as conversation-level decisions");
	}
}

function assertDiscordSubagentRouting(): void {
	const idleMain = shouldRouteDiscordMessageToSubagent({
		subagentsAvailable: true,
		mainSessionStreaming: false,
		mainQueueBusy: false,
	});
	if (!idleMain) {
		throw new Error("smoke: accepted Discord messages should route to the dedicated Discord subagent");
	}
	const streamingMain = shouldRouteDiscordMessageToSubagent({
		subagentsAvailable: true,
		mainSessionStreaming: true,
		mainQueueBusy: false,
	});
	if (!streamingMain) {
		throw new Error("smoke: streaming main Clanky should route Discord to a subagent");
	}
	const queuedMain = shouldRouteDiscordMessageToSubagent({
		subagentsAvailable: true,
		mainSessionStreaming: false,
		mainQueueBusy: true,
	});
	if (!queuedMain) {
		throw new Error("smoke: queued main work should route Discord to a subagent");
	}
	const unavailableSubagent = shouldRouteDiscordMessageToSubagent({
		subagentsAvailable: false,
		mainSessionStreaming: true,
		mainQueueBusy: true,
	});
	if (unavailableSubagent) {
		throw new Error("smoke: missing subagent coordinator should never route to a subagent");
	}
}

async function assertAgentDiscordPromptImages(): Promise<void> {
	const message = {
		externalMessageId: "msg-new",
		conversation: { id: "channel-1", kind: "channel" as const },
		sender: { id: "user-1", username: "james" },
		text: "what is in the image?",
		attachments: [
			{
				url: "https://cdn.example/new.png",
				filename: "new.png",
				mime: "image/png",
			},
		],
		mentionsSelf: false,
	};
	const promptImages = await resolveDiscordPromptImages(
		message,
		[
			{
				author: "vuhlp",
				text: "earlier image",
				attachmentLabels: ["https://cdn.example/old.jpg"],
				attachments: [{ url: "https://cdn.example/old.jpg", filename: "old.jpg", contentType: "image/jpeg" }],
				messageId: "msg-old",
			},
		],
		{
			fetchImage: async (candidate) => ({
				type: "image",
				mimeType: candidate.mimeType ?? "image/png",
				data: candidate.label.includes("msg-old") ? "b2xk" : "bmV3",
			}),
		},
	);
	if (promptImages.images.length !== 2 || promptImages.references.length !== 2 || promptImages.failures.length !== 0) {
		throw new Error(`smoke: Discord prompt image resolution mismatch ${JSON.stringify(promptImages)}`);
	}
	const prompt = formatDiscordUserMessage(message, "recent_engagement", [], undefined, promptImages.references);
	if (
		!prompt.includes("actual image pixels are attached") ||
		!prompt.includes("image 1: message msg-old attachment old.jpg (image/jpeg)") ||
		!prompt.includes("image 2: newest message attachment new.png (image/png)")
	) {
		throw new Error(`smoke: Discord image references missing from prompt: ${prompt}`);
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

async function assertStoredDiscordCredentialPath(): Promise<void> {
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

	const discordMcpConfig = resolveMcpServerConfigs({
		authStorage: stored,
		cwd: "/tmp/clanky-mcp-smoke",
		env: {},
	}).discord;
	if (discordMcpConfig === undefined) {
		throw new Error("smoke: auto Discord MCP config should exist");
	}
	if (discordMcpConfig.env.DISCORD_MCP_TOKEN !== "stored-token") {
		throw new Error("smoke: stored Discord credential should be injected into auto Discord MCP env");
	}
	if (discordMcpConfig.env.DISCORD_MCP_CREDENTIAL_KIND !== "bot-token") {
		throw new Error("smoke: stored Discord credential kind should be injected into auto Discord MCP env");
	}

	const envDiscordMcpConfig = resolveMcpServerConfigs({
		authStorage: stored,
		cwd: "/tmp/clanky-mcp-smoke",
		env: { CLANKY_DISCORD_TOKEN: "env-token" },
	}).discord;
	if (envDiscordMcpConfig?.env.DISCORD_MCP_TOKEN !== undefined) {
		throw new Error("smoke: stored Discord MCP token should not override an env Discord token");
	}
	if (envDiscordMcpConfig?.env.CLANKY_DISCORD_TOKEN !== "env-token") {
		throw new Error("smoke: Discord MCP env should preserve the explicit env token");
	}

	const mcpHome = await mkdtemp(join(tmpdir(), "clanky-mcp-profile-smoke-"));
	try {
		const mcpPaths = resolveClankyPaths({ homeDir: mcpHome });
		await mkdir(mcpPaths.profileDir, { recursive: true });
		await writeFile(
			mcpPaths.mcpServersFile,
			`${JSON.stringify(
				{
					mcpServers: {
						linear: { type: "http", url: "https://mcp.linear.app/mcp" },
					},
				},
				null,
				2,
			)}\n`,
		);
		const profileMcpConfig = resolveMcpServerConfigs({
			cwd: "/tmp/clanky-mcp-smoke",
			env: { CLANKY_DISCORD_MCP: "0" },
			paths: mcpPaths,
		}).linear;
		if (profileMcpConfig?.type !== "streamable-http" || profileMcpConfig.url !== "https://mcp.linear.app/mcp") {
			throw new Error("smoke: profile-local HTTP MCP config should load");
		}
	} finally {
		await rm(mcpHome, { recursive: true, force: true });
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
	if (queue.isBusy()) {
		throw new Error("smoke: new runtime turn queue should start idle");
	}
	const order: string[] = [];
	let releaseFirst: (() => void) | undefined;
	let releaseSecond: (() => void) | undefined;
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
		await new Promise<void>((resolve) => {
			releaseSecond = resolve;
		});
		order.push("second-end");
		return "second";
	});
	if (!queue.isBusy()) {
		throw new Error("smoke: runtime turn queue should be busy while work is queued");
	}
	await Promise.resolve();
	if (order.join(",") !== "first-start") {
		throw new Error(`smoke: runtime turn queue did not block second task, order=${order.join(",")}`);
	}
	releaseFirst?.();
	await delay(0);
	if (!order.includes("second-start")) {
		throw new Error(`smoke: runtime turn queue did not start second task after release: ${order.join(",")}`);
	}
	if (!queue.isBusy()) {
		throw new Error("smoke: runtime turn queue should stay busy while later queued work is running");
	}
	releaseSecond?.();
	if ((await first) !== "first" || (await second) !== "second") {
		throw new Error("smoke: runtime turn queue returned wrong task results");
	}
	if (order.join(",") !== "first-start,first-end,second-start,second-end") {
		throw new Error(`smoke: runtime turn queue serialized in wrong order: ${order.join(",")}`);
	}
	if (queue.isBusy()) {
		throw new Error("smoke: runtime turn queue should be idle after all work completes");
	}
	await assertRejects(() => queue.enqueue(async () => Promise.reject(new Error("queued failure"))), "queued failure");
	const afterFailure = await queue.enqueue(async () => "after-failure");
	if (afterFailure !== "after-failure") {
		throw new Error("smoke: runtime turn queue did not recover after a failed task");
	}

	const cancelOrder: string[] = [];
	let releaseCancelFirst: (() => void) | undefined;
	const cancelFirst = queue.enqueue(async () => {
		cancelOrder.push("cancel-first-start");
		await new Promise<void>((resolve) => {
			releaseCancelFirst = resolve;
		});
		cancelOrder.push("cancel-first-end");
		return "cancel-first";
	});
	const cancelSecond = queue.enqueue(async () => {
		cancelOrder.push("cancel-second-start");
		return "cancel-second";
	});
	const cancelSecondResult = cancelSecond.then(
		() => undefined,
		(error: unknown) => error,
	);
	await delay(0);
	const cancelResult = queue.cancelPending("voice cancel");
	if (cancelResult.active !== 1 || cancelResult.queued !== 1 || cancelResult.cancelled !== 1) {
		throw new Error(`smoke: runtime turn queue cancel result mismatch ${JSON.stringify(cancelResult)}`);
	}
	releaseCancelFirst?.();
	if ((await cancelFirst) !== "cancel-first") {
		throw new Error("smoke: runtime turn queue cancelled active work");
	}
	const cancelSecondError = await cancelSecondResult;
	const cancelSecondMessage =
		cancelSecondError instanceof Error ? cancelSecondError.message : String(cancelSecondError);
	if (!cancelSecondMessage.includes("voice cancel")) {
		throw new Error(`smoke: runtime turn queue cancel error mismatch ${cancelSecondMessage}`);
	}
	if (cancelOrder.join(",") !== "cancel-first-start,cancel-first-end") {
		throw new Error(`smoke: runtime turn queue started cancelled queued work ${cancelOrder.join(",")}`);
	}
	if (queue.isBusy()) {
		throw new Error("smoke: runtime turn queue should be idle after cancellation drains");
	}

	const promptCalls: string[] = [];
	let promptImageCount = 0;
	const promptRuntime = {
		session: {
			isStreaming: true,
			sessionId: "auto-prompt-smoke",
			async prompt(
				message: string,
				options?: { source?: string; streamingBehavior?: string; images?: unknown[] },
			): Promise<void> {
				promptCalls.push(`${options?.source}:${options?.streamingBehavior}:${message}`);
				promptImageCount = options?.images?.length ?? 0;
			},
		},
	};
	const promptResult = await queue.enqueuePrompt(promptRuntime as never, "queued main work", {
		images: [{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" }],
	});
	if (promptResult.mode !== "followUp" || promptResult.sessionId !== "auto-prompt-smoke") {
		throw new Error(`smoke: runtime turn queue returned wrong prompt result ${JSON.stringify(promptResult)}`);
	}
	if (promptCalls.join("\n") !== "extension:followUp:queued main work") {
		throw new Error(`smoke: runtime turn queue did not auto-prompt safely ${JSON.stringify(promptCalls)}`);
	}
	if (promptImageCount !== 1) {
		throw new Error(`smoke: runtime turn queue did not preserve prompt images, got ${promptImageCount}`);
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
	const voiceLoadingWidgets: Array<string[] | undefined> = [];
	const voiceLoadingStatuses: Array<string | undefined> = [];
	const voiceProgressPhases: string[] = [];
	const commands: Record<string, RegisteredCommand> = {};
	let voiceSettingsState: StoredDiscordVoiceSettings | undefined;
	const getRestarts = () => restarts;
	const getVoiceSettings = () => voiceSettingsState;
	const factory = createDiscordAuthExtensionFactory({
		authStorage,
		providerId: DEFAULT_CLANKY_DISCORD_PROVIDER_ID,
		authFilePath: "/tmp/clanky-auth.json",
		voiceSettings: {
			path: "/tmp/clanky-discord-voice.json",
			read() {
				return voiceSettingsState;
			},
			write(settings: StoredDiscordVoiceSettings) {
				voiceSettingsState = settings;
			},
			clear() {
				const hadSettings = voiceSettingsState !== undefined;
				voiceSettingsState = undefined;
				return hadSettings;
			},
		},
		gatewayController: {
			async restart() {
				restarts += 1;
			},
			async restartVoice(options?: {
				joinRequested?: boolean;
				onProgress?: (progress: { phase: string; message: string }) => void;
			}) {
				restarts += 1;
				for (const progress of [
					{ phase: "waiting_for_client_ready", message: "Waiting for Discord voice client to become ready." },
					{ phase: "starting_voice_bridge", message: "Starting Discord voice bridge." },
					{ phase: "ready", message: "Discord voice client is ready." },
				]) {
					voiceProgressPhases.push(progress.phase);
					options?.onProgress?.(progress);
				}
			},
			status() {
				return {
					textBridgeActive: true,
					voiceBridgeActive: true,
					voiceOnlyClientActive: false,
					voice: {
						guildId: "guild-1",
						channelId: "voice-1",
						allowedGuildIds: voiceSettingsState?.allowedGuildIds ?? [],
						allowedChannelIds: voiceSettingsState?.allowedChannelIds ?? [],
						model: DEFAULT_REALTIME_MODEL,
						participationEagerness: 63,
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
			select(title: string) {
				if (title.startsWith("Discord voice settings")) return Promise.resolve("Allowed servers");
				if (title === "Discord voice allowed servers") return Promise.resolve("Add server ids");
				return Promise.resolve("Keep current/default");
			},
			input(title: string) {
				if (title.includes("server")) return Promise.resolve("guild-ui");
				if (title.includes("guild")) return Promise.resolve("guild-ui");
				if (title.includes("channel")) return Promise.resolve("voice-ui");
				return Promise.resolve(undefined);
			},
			confirm() {
				return Promise.resolve(false);
			},
			notify(message: string) {
				notifications.push(message);
			},
			setStatus(_key: string, value: string | undefined) {
				voiceLoadingStatuses.push(value);
			},
			setWidget(_key: string, value: string[] | undefined) {
				voiceLoadingWidgets.push(value);
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
				message.includes("Realtime agent provider: OpenAI Realtime.") &&
				message.includes("Realtime agent model:") &&
				message.includes("Voice participation eagerness: 63/100.") &&
				message.includes("Speech output provider: OpenAI Realtime audio.") &&
				message.includes("Native screen watch: supported.") &&
				message.includes("Voice stats: input audio 2, output audio 3, realtime tool calls 4, decoded frames 5.") &&
				message.includes("Voice speakers: unique 2, max concurrent 2.") &&
				message.includes("Realtime status: transcripts 6, API errors 7, socket errors 8, socket closes 9."),
		)
	) {
		throw new Error(`smoke: /discord-status did not report voice bridge status: ${notifications.join("\n---\n")}`);
	}

	const voiceCommand = commands["discord-voice"];
	if (voiceCommand === undefined) throw new Error("smoke: /discord-voice command was not registered");
	await assertCommandCompletionIncludes(voiceCommand, "", "set tts-provider elevenlabs");
	await assertCommandCompletionIncludes(voiceCommand, "eleven", "set elevenlabs-voice ");
	await assertCommandCompletionIncludes(voiceCommand, "set tts-provider ", "set tts-provider openai");
	await assertCommandCompletionIncludes(voiceCommand, "set eag", "set eagerness ");
	await voiceCommand.handler("", ctx);
	if (getRestarts() !== 1) {
		throw new Error(`smoke: /discord-voice wizard should hot-restart bridge once, got ${restarts}`);
	}
	if (!voiceProgressPhases.includes("waiting_for_client_ready") || !voiceProgressPhases.includes("ready")) {
		throw new Error(`smoke: /discord-voice did not report voice startup progress: ${voiceProgressPhases.join(",")}`);
	}
	if (!voiceLoadingWidgets.some((widget) => widget?.join("\n").includes("Waiting for Discord voice client"))) {
		throw new Error(
			`smoke: /discord-voice did not render voice loading widget: ${JSON.stringify(voiceLoadingWidgets)}`,
		);
	}
	if (voiceLoadingWidgets.at(-1) !== undefined || voiceLoadingStatuses.at(-1) !== undefined) {
		throw new Error("smoke: /discord-voice loading UI was not cleared");
	}
	const wizardVoiceSettings = getVoiceSettings();
	if (
		wizardVoiceSettings?.enabled !== true ||
		wizardVoiceSettings.guildId !== undefined ||
		wizardVoiceSettings.channelId !== undefined ||
		wizardVoiceSettings.allowedGuildIds?.join(",") !== "guild-ui"
	) {
		throw new Error(`smoke: /discord-voice wizard wrote wrong settings ${JSON.stringify(wizardVoiceSettings)}`);
	}

	const statusNotificationCount = notifications.length;
	await voiceCommand.handler("", ctx);
	if (getRestarts() !== 1) {
		throw new Error(`smoke: configured /discord-voice should show status without restart, got ${restarts}`);
	}
	const statusNotifications = notifications.slice(statusNotificationCount);
	if (
		!statusNotifications.some(
			(message) =>
				message.includes("Pinned voice target: none.") &&
				message.includes("Allowed servers: guild-ui.") &&
				message.includes("Allowed voice channels: all channels the Discord credential can access."),
		)
	) {
		throw new Error(
			`smoke: /discord-voice status did not show profile settings ${statusNotifications.join("\n---\n")}`,
		);
	}

	await voiceCommand.handler("allow-server guild-2 guild-ui", ctx);
	if (getRestarts() !== 2) {
		throw new Error(`smoke: /discord-voice allow-server should hot-restart bridge again, got ${restarts}`);
	}
	const serverAllowlistedVoiceSettings = getVoiceSettings();
	if (serverAllowlistedVoiceSettings?.allowedGuildIds?.join(",") !== "guild-ui,guild-2") {
		throw new Error(
			`smoke: /discord-voice allow-server wrote wrong settings ${JSON.stringify(serverAllowlistedVoiceSettings)}`,
		);
	}

	await voiceCommand.handler("allow-channel voice-2 voice-3 voice-2", ctx);
	if (getRestarts() !== 3) {
		throw new Error(`smoke: /discord-voice allow-channel should hot-restart bridge again, got ${restarts}`);
	}
	const allowlistedVoiceSettings = getVoiceSettings();
	if (allowlistedVoiceSettings?.allowedChannelIds?.join(",") !== "voice-2,voice-3") {
		throw new Error(`smoke: /discord-voice allow wrote wrong settings ${JSON.stringify(allowlistedVoiceSettings)}`);
	}

	await voiceCommand.handler("enable guild-2 voice-2", ctx);
	if (getRestarts() !== 4) {
		throw new Error(`smoke: /discord-voice enable should hot-restart bridge again, got ${restarts}`);
	}
	const enabledVoiceSettings = getVoiceSettings();
	if (
		enabledVoiceSettings?.enabled !== true ||
		enabledVoiceSettings.guildId !== "guild-2" ||
		enabledVoiceSettings.channelId !== "voice-2" ||
		enabledVoiceSettings.allowedGuildIds?.join(",") !== "guild-ui,guild-2" ||
		enabledVoiceSettings.allowedChannelIds?.join(",") !== "voice-2,voice-3"
	) {
		throw new Error(`smoke: /discord-voice enable wrote wrong settings ${JSON.stringify(enabledVoiceSettings)}`);
	}
	if (!notifications.some((message) => message.includes("Discord voice enabled for guild guild-2, channel voice-2."))) {
		throw new Error("smoke: /discord-voice enable did not report saved setting");
	}

	await voiceCommand.handler("disable", ctx);
	if (getRestarts() !== 5) {
		throw new Error(`smoke: /discord-voice disable should hot-restart bridge again, got ${restarts}`);
	}
	const disabledVoiceSettings = getVoiceSettings();
	if (disabledVoiceSettings?.enabled !== false) {
		throw new Error(`smoke: /discord-voice disable wrote wrong settings ${JSON.stringify(disabledVoiceSettings)}`);
	}

	await voiceCommand.handler("set elevenlabs-output-format pcm_16000", ctx);
	if (getRestarts() !== 6) {
		throw new Error(`smoke: /discord-voice set output format should hot-restart bridge again, got ${restarts}`);
	}
	await voiceCommand.handler("set elevenlabs-base-url https://api.example.test", ctx);
	if (getRestarts() !== 7) {
		throw new Error(`smoke: /discord-voice set base URL should hot-restart bridge again, got ${restarts}`);
	}
	await voiceCommand.handler("set eagerness 72", ctx);
	if (getRestarts() !== 8) {
		throw new Error(`smoke: /discord-voice set eagerness should hot-restart bridge again, got ${restarts}`);
	}
	const elevenLabsVoiceSettings = getVoiceSettings();
	if (
		elevenLabsVoiceSettings?.elevenLabsOutputFormat !== "pcm_16000" ||
		elevenLabsVoiceSettings.elevenLabsBaseUrl !== "https://api.example.test" ||
		elevenLabsVoiceSettings.participationEagerness !== 72
	) {
		throw new Error(
			`smoke: /discord-voice ElevenLabs settings did not persist ${JSON.stringify(elevenLabsVoiceSettings)}`,
		);
	}

	const logoutCommand = commands["discord-logout"];
	if (logoutCommand === undefined) throw new Error("smoke: /discord-logout command was not registered");
	await logoutCommand.handler([], ctx);
	if (getRestarts() !== 9) {
		throw new Error(`smoke: /discord-logout should hot-restart bridge after logout, got ${restarts}`);
	}
	if (resolveAgentDiscordGatewayConfig({}, authStorage) !== undefined) {
		throw new Error("smoke: /discord-logout should remove stored Discord credentials");
	}
	if (!notifications.some((message) => message.includes("Discord bridge restarted after logout."))) {
		throw new Error("smoke: /discord-logout did not report bridge restart after logout");
	}
}

async function assertClankyAuthExtensionCommand(): Promise<void> {
	const authStorage = AuthStorage.inMemory();
	saveStoredOpenAiApiKey(authStorage, "stored-openai-key");
	saveStoredXAiApiKey(authStorage, "stored-xai-key");
	saveStoredElevenLabsApiKey(authStorage, "stored-elevenlabs-key");
	saveStoredDiscordCredential(authStorage, {
		token: "stored-discord-token",
		credentialKind: "bot-token",
	});
	let reloads = 0;
	let restarts = 0;
	const getReloads = () => reloads;
	const getRestarts = () => restarts;
	const notifications: string[] = [];
	const confirmations: string[] = [];
	const commands: Record<string, RegisteredCommand> = {};
	const factory = createClankyAuthExtensionFactory({
		authStorage,
		authFilePath: "/tmp/clanky-auth.json",
		discordProviderId: DEFAULT_CLANKY_DISCORD_PROVIDER_ID,
		gatewayController: {
			async restart() {
				restarts += 1;
			},
		} as ClankyDiscordGatewayController,
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
			async confirm(title: string) {
				confirmations.push(title);
				return true;
			},
		},
		async reload() {
			reloads += 1;
		},
	} as unknown as ExtensionCommandContext;

	const authCommand = commands.auth;
	if (authCommand === undefined) throw new Error("smoke: /auth command was not registered");
	await assertCommandCompletionIncludes(authCommand, "", "list");
	await assertCommandCompletionIncludes(authCommand, "remove ", `remove ${DEFAULT_OPENAI_PROVIDER_ID}`);

	await authCommand.handler("", ctx);
	const status = notifications.at(-1);
	if (
		status === undefined ||
		!status.includes(`${DEFAULT_OPENAI_PROVIDER_ID}: api_key`) ||
		!status.includes(`${DEFAULT_XAI_PROVIDER_ID}: api_key`) ||
		!status.includes(`${DEFAULT_ELEVENLABS_PROVIDER_ID}: api_key`) ||
		!status.includes(`${DEFAULT_CLANKY_DISCORD_PROVIDER_ID}: api_key`)
	) {
		throw new Error(`smoke: /auth status did not list stored credentials: ${status}`);
	}

	await authCommand.handler(`remove ${DEFAULT_OPENAI_PROVIDER_ID}`, ctx);
	if (authStorage.get(DEFAULT_OPENAI_PROVIDER_ID) !== undefined) {
		throw new Error("smoke: /auth remove openai should remove stored OpenAI credentials");
	}
	if (getReloads() !== 1) throw new Error(`smoke: /auth remove openai should reload once, got ${reloads}`);
	if (
		!notifications.at(-1)?.includes(`Removed stored api_key credential for provider "${DEFAULT_OPENAI_PROVIDER_ID}"`)
	) {
		throw new Error("smoke: /auth remove openai did not report credential removal");
	}

	await authCommand.handler(`remove ${DEFAULT_CLANKY_DISCORD_PROVIDER_ID}`, ctx);
	if (authStorage.get(DEFAULT_CLANKY_DISCORD_PROVIDER_ID) !== undefined) {
		throw new Error("smoke: /auth remove clanky-discord should remove stored Discord credentials");
	}
	if (getRestarts() !== 1) {
		throw new Error(`smoke: /auth remove clanky-discord should restart bridge once, got ${restarts}`);
	}
	if (getReloads() !== 2) throw new Error(`smoke: /auth remove clanky-discord should reload again, got ${reloads}`);

	await authCommand.handler("remove all", ctx);
	if (authStorage.list().length !== 0) {
		throw new Error(`smoke: /auth remove all should clear stored credentials, got ${authStorage.list().join(", ")}`);
	}
	if (confirmations.length !== 1 || confirmations[0] !== "Remove all stored provider credentials?") {
		throw new Error(`smoke: /auth remove all should require confirmation, got ${confirmations.join(", ")}`);
	}
	if (getRestarts() !== 2) {
		throw new Error(`smoke: /auth remove all should restart bridge for ElevenLabs, got ${restarts}`);
	}
	if (getReloads() !== 3) throw new Error(`smoke: /auth remove all should reload once more, got ${reloads}`);
	if (!notifications.at(-1)?.includes("Environment variables and models.json request auth were not changed.")) {
		throw new Error("smoke: /auth remove all did not report environment/model auth caveat");
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

async function assertClankyEffortExtensionCommand(): Promise<void> {
	const defaults = {
		mainThinkingLevel: DEFAULT_CLANKY_MAIN_THINKING_LEVEL,
		subagentThinkingLevel: DEFAULT_CLANKY_SUBAGENT_THINKING_LEVEL,
	};
	let currentThinkingLevel: string = defaults.mainThinkingLevel;
	let activeSubagentThinkingLevel: string | undefined;
	let thinkingLevelHandler: ((event: { level: string }) => void) | undefined;
	const notifications: string[] = [];
	const commands: Record<string, RegisteredCommand> = {};
	const factory = createClankyEffortExtensionFactory(defaults, {
		setActiveSubagentThinkingLevel(level) {
			activeSubagentThinkingLevel = level;
			return 2;
		},
	});
	factory({
		on(event: string, handler: (event: { level: string }) => void) {
			if (event === "thinking_level_select") thinkingLevelHandler = handler;
		},
		registerCommand(name: string, command: RegisteredCommand) {
			commands[name] = command;
		},
		getThinkingLevel() {
			return currentThinkingLevel;
		},
		setThinkingLevel(level: string) {
			currentThinkingLevel = level;
		},
	} as unknown as Parameters<ExtensionFactory>[0]);

	const effort = commands.effort;
	if (effort === undefined) throw new Error("smoke: /effort command was not registered");
	await assertCommandCompletionIncludes(effort, "", "status");
	await assertCommandCompletionIncludes(effort, "subagents ", "subagents high");
	const ctx = {
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
		},
	} as unknown as ExtensionCommandContext;

	await effort.handler("", ctx);
	if (
		!notifications.at(-1)?.includes("Main Clanky: xhigh") ||
		!notifications.at(-1)?.includes("Clanky subagents: medium")
	) {
		throw new Error(`smoke: /effort status mismatch: ${JSON.stringify(notifications)}`);
	}
	await effort.handler("subagents high", ctx);
	if (defaults.subagentThinkingLevel !== "high" || activeSubagentThinkingLevel !== "high") {
		throw new Error("smoke: /effort subagents did not update subagent defaults");
	}
	if (!notifications.at(-1)?.includes("Active subagent sessions updated: 2")) {
		throw new Error(`smoke: /effort subagents did not report active updates: ${JSON.stringify(notifications)}`);
	}
	await effort.handler("main low", ctx);
	if (defaults.mainThinkingLevel !== "low" || currentThinkingLevel !== "low") {
		throw new Error("smoke: /effort main did not update main thinking");
	}
	await effort.handler("all xhigh", ctx);
	assertStringEquals(defaults.mainThinkingLevel, "xhigh", "smoke: /effort all did not update main default");
	assertStringEquals(defaults.subagentThinkingLevel, "xhigh", "smoke: /effort all did not update subagent default");
	assertStringEquals(currentThinkingLevel, "xhigh", "smoke: /effort all did not update main runtime");
	assertStringEquals(activeSubagentThinkingLevel, "xhigh", "smoke: /effort all did not update active subagents");
	thinkingLevelHandler?.({ level: "medium" });
	assertStringEquals(
		defaults.mainThinkingLevel,
		"medium",
		"smoke: Pi thinking-level event did not update main Clanky default",
	);
	await effort.handler("subagents maximum", ctx);
	if (!notifications.at(-1)?.includes("Usage: /effort")) {
		throw new Error("smoke: /effort invalid args did not show usage");
	}
}

async function assertClankySetupExtensionCommand(): Promise<void> {
	const authStorage = AuthStorage.inMemory();
	saveStoredOpenAiApiKey(authStorage, "stored-openai-key");
	saveStoredDiscordCredential(authStorage, {
		token: "stored-discord-token",
		credentialKind: "bot-token",
		identity: { id: "222", username: "stored-bot" },
	});
	saveStoredElevenLabsApiKey(authStorage, "stored-elevenlabs-key");
	saveStoredXAiApiKey(authStorage, "stored-xai-key");
	const paths = resolveClankyPaths({ homeDir: join(tmpdir(), "clanky-setup-smoke") });
	const notifications: string[] = [];
	const commands: Record<string, RegisteredCommand> = {};
	let voiceSettingsState: StoredDiscordVoiceSettings | undefined = {
		enabled: true,
		guildId: "guild-1",
		channelId: "voice-1",
	};
	const factory = createClankySetupExtensionFactory({
		cwd: process.cwd(),
		paths,
		authStorage,
		discordProviderId: DEFAULT_CLANKY_DISCORD_PROVIDER_ID,
		gatewayController: {} as never,
		voiceSettings: {
			path: "/tmp/clanky-discord-voice.json",
			read() {
				return voiceSettingsState;
			},
			write(settings: StoredDiscordVoiceSettings) {
				voiceSettingsState = settings;
			},
			clear() {
				const hadSettings = voiceSettingsState !== undefined;
				voiceSettingsState = undefined;
				return hadSettings;
			},
		},
	});
	factory({
		registerCommand(name: string, command: RegisteredCommand) {
			commands[name] = command;
		},
	} as never);
	const setup = commands.setup;
	if (setup === undefined) throw new Error("smoke: /setup command was not registered");
	await assertCommandCompletionIncludes(setup, "", "status");
	const ctx = {
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
		},
	} as unknown as ExtensionCommandContext;

	await setup.handler("status", ctx);
	const status = notifications.at(-1);
	if (
		status === undefined ||
		!status.includes("Clanky setup") ||
		!status.includes("OpenAI:") ||
		!status.includes("Discord text: stored bot-token as stored-bot") ||
		!status.includes("Discord voice: enabled") ||
		!status.includes("ElevenLabs:") ||
		!status.includes("xAI media:")
	) {
		throw new Error(`smoke: /setup status summary was incomplete: ${status}`);
	}

	await setup.handler("mcp linear https://mcp.linear.app/mcp", ctx);
	if (!notifications.at(-1)?.includes("Saved linear")) {
		throw new Error("smoke: /setup mcp did not save the profile MCP server");
	}
	await setup.handler("mcp", ctx);
	if (!notifications.at(-1)?.includes("linear")) {
		throw new Error("smoke: /setup mcp did not list the profile MCP server");
	}

	await setup.handler("fresh", ctx);
	if (!notifications.at(-1)?.includes("pnpm dev:setup:fresh")) {
		throw new Error("smoke: /setup fresh did not print the fresh-user command");
	}
}

async function assertClankyVoiceLogsExtensionCommand(): Promise<void> {
	const tmpRoot = await mkdtemp(join(tmpdir(), "clanky-voice-logs-smoke-"));
	try {
		const voiceLogPath = join(tmpRoot, "discord-voice.log");
		await writeFile(voiceLogPath, ["first voice line", "second voice line", ""].join("\n"));
		const commands: Record<string, RegisteredCommand> = {};
		const notifications: string[] = [];
		const factory = createClankyVoiceLogsExtensionFactory({ voiceLogPath });
		factory({
			registerCommand(name: string, command: RegisteredCommand) {
				commands[name] = command;
			},
		} as never);
		const command = commands["voice-logs"];
		if (command === undefined || commands.voice_logs === undefined) {
			throw new Error("smoke: /voice-logs command aliases were not registered");
		}
		await assertCommandCompletionIncludes(command, "", "tail");
		await assertCommandCompletionIncludes(command, "cl", "clear");
		const ctx = {
			hasUI: false,
			ui: {
				notify(message: string) {
					notifications.push(message);
				},
			},
		} as unknown as ExtensionCommandContext;

		await command.handler("tail", ctx);
		const output = notifications.at(-1);
		if (output === undefined || !output.includes(voiceLogPath) || !output.includes("second voice line")) {
			throw new Error(`smoke: /voice-logs tail did not show log tail: ${output}`);
		}
		const missing = await readVoiceLogTail(join(tmpRoot, "missing.log"));
		if (missing.length !== 0) throw new Error("smoke: missing voice log should read as an empty tail");
	} finally {
		await rm(tmpRoot, { recursive: true, force: true });
	}
}

function assertStringEquals(actual: string | undefined, expected: string, message: string): void {
	if (actual !== expected) throw new Error(message);
}

interface RegisteredCommand {
	getArgumentCompletions?: (argumentPrefix: string) => unknown[] | null | Promise<unknown[] | null>;
	handler(args: unknown, ctx: unknown): unknown | Promise<unknown>;
}

async function assertCommandCompletionIncludes(
	command: RegisteredCommand,
	prefix: string,
	expectedValue: string,
): Promise<void> {
	const completions = await command.getArgumentCompletions?.(prefix);
	if (!Array.isArray(completions)) {
		throw new Error(`smoke: command did not return completions for prefix "${prefix}"`);
	}
	const values = completions.flatMap((completion) => {
		if (typeof completion !== "object" || completion === null) return [];
		const value = (completion as Record<string, unknown>).value;
		return typeof value === "string" ? [value] : [];
	});
	if (!values.includes(expectedValue)) {
		throw new Error(
			`smoke: completion for prefix "${prefix}" did not include "${expectedValue}"; got ${values.join(", ")}`,
		);
	}
}

function testControllerPaths() {
	return resolveClankyPaths({ homeDir: join(tmpdir(), "clanky-controller-smoke") });
}

async function assertDiscordGatewayControllerStartup(): Promise<void> {
	await assertControllerVoiceTargetDoesNotAutoJoinOnStartup();
	await assertControllerSharedChatAndVoiceStartup();
	await assertControllerWaitsForSharedClientReady();
	await assertControllerVoiceOnlyStartup();
	await assertControllerVoiceRestartKeepsTextBridge();
	await assertControllerStoredVoiceConfigErrorDoesNotBlockTextBridge();
	await assertControllerEnvVoiceConfigErrorStillFailsFast();
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
			CLANKY_DISCORD_VOICE_AUTO_JOIN: "1",
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
					setSubagentThinkingLevel: () => 0,
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

async function assertControllerVoiceTargetDoesNotAutoJoinOnStartup(): Promise<void> {
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
			async startGateway(input) {
				calls.startGatewayCalls += 1;
				if (input.client !== undefined) {
					throw new Error("smoke: startup without auto-join should let text gateway create its own client");
				}
				return {
					client: calls.sharedClient as never,
					setSubagentThinkingLevel: () => 0,
					async stop() {
						calls.textStops += 1;
					},
				};
			},
			async startVoice() {
				calls.startVoiceCalls += 1;
				throw new Error("smoke: startup should not join pinned Discord voice without auto-join");
			},
		},
	});
	controller.bindRuntime({} as never);
	await controller.start();
	const status = controller.status();
	if (
		calls.createdClientOptions.length !== 0 ||
		calls.startGatewayCalls !== 1 ||
		calls.startVoiceCalls !== 0 ||
		calls.loginCalls !== 0
	) {
		throw new Error("smoke: startup without auto-join should start text only");
	}
	if (
		status.textBridgeActive !== true ||
		status.voiceBridgeActive !== false ||
		status.voiceOnlyClientActive !== false
	) {
		throw new Error(`smoke: no-auto-join startup status mismatch: ${JSON.stringify(status)}`);
	}
	await controller.stop();
}

async function assertControllerWaitsForSharedClientReady(): Promise<void> {
	const authStorage = AuthStorage.inMemory();
	const calls = createControllerCallRecorder();
	calls.sharedClient.ready = false;
	const controller = new ClankyDiscordGatewayController({
		authStorage,
		paths: testControllerPaths(),
		env: {
			CLANKY_DISCORD_TOKEN: "discord-token",
			CLANKY_DISCORD_VOICE_ENABLED: "1",
			CLANKY_DISCORD_VOICE_AUTO_JOIN: "1",
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
				setTimeout(() => {
					calls.sharedClient.ready = true;
				}, 0);
				return {
					client: calls.sharedClient as never,
					setSubagentThinkingLevel: () => 0,
					async stop() {
						calls.textStops += 1;
					},
				};
			},
			async startVoice(input) {
				calls.startVoiceCalls += 1;
				if (!input.client.isReady()) throw new Error("smoke: voice started before shared client was ready");
				return createFakeVoiceHandle(calls);
			},
		},
	});
	controller.bindRuntime({} as never);
	await controller.start();
	if (calls.startGatewayCalls !== 1 || calls.startVoiceCalls !== 1) {
		throw new Error("smoke: ready wait should allow shared voice startup after client becomes ready");
	}
	await controller.stop();
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
			CLANKY_DISCORD_VOICE_AUTO_JOIN: "1",
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

async function assertControllerVoiceRestartKeepsTextBridge(): Promise<void> {
	const authStorage = AuthStorage.inMemory();
	const calls = createControllerCallRecorder();
	const voiceOnlyClient = new FakeControllerDiscordClient();
	let voiceSettings: StoredDiscordVoiceSettings | undefined;
	const controller = new ClankyDiscordGatewayController({
		authStorage,
		paths: testControllerPaths(),
		env: {
			CLANKY_DISCORD_TOKEN: "discord-token",
			OPENAI_API_KEY: "openai-key",
		},
		readVoiceSettings: () => voiceSettings,
		dependencies: {
			createClient(options) {
				calls.createdClientOptions.push(options ?? {});
				return voiceOnlyClient as never;
			},
			async loginClient(client, config) {
				calls.loginCalls += 1;
				if ((client as unknown) !== voiceOnlyClient) throw new Error("smoke: voice restart logged in the wrong client");
				if (config.token !== "discord-token") throw new Error("smoke: voice restart used wrong Discord token");
				voiceOnlyClient.ready = true;
			},
			async startGateway(input) {
				calls.startGatewayCalls += 1;
				if (input.client !== undefined) throw new Error("smoke: text-only startup should not precreate voice client");
				return {
					client: calls.sharedClient as never,
					setSubagentThinkingLevel: () => 0,
					async stop() {
						calls.textStops += 1;
					},
				};
			},
			async startVoice(input) {
				calls.startVoiceCalls += 1;
				if ((input.client as unknown) !== voiceOnlyClient) {
					throw new Error("smoke: voice restart should use a voice-only client without stopping text");
				}
				return createFakeVoiceHandle(calls);
			},
		},
	});
	controller.bindRuntime({} as never);
	await controller.start();
	if (calls.startGatewayCalls !== 1 || calls.startVoiceCalls !== 0 || calls.createdClientOptions.length !== 0) {
		throw new Error("smoke: text-only controller startup should start only the text gateway");
	}

	voiceSettings = { enabled: true, guildId: "guild-1", channelId: "voice-1" };
	await controller.restartVoice({ joinRequested: true });
	const created = calls.createdClientOptions[0];
	const status = controller.status();
	if (created === undefined || created.voice !== true || created.chat !== false) {
		throw new Error("smoke: voice restart should create a voice-only Discord client");
	}
	const startVoiceCalls = Number(calls.startVoiceCalls);
	if (calls.startGatewayCalls !== 1 || calls.textStops !== 0 || calls.loginCalls !== 1 || startVoiceCalls !== 1) {
		throw new Error("smoke: voice restart should not restart the text gateway");
	}
	if (status.textBridgeActive !== true || status.voiceBridgeActive !== true || status.voiceOnlyClientActive !== true) {
		throw new Error(`smoke: voice restart status mismatch: ${JSON.stringify(status)}`);
	}

	await controller.stop();
	const voiceStops = Number(calls.voiceStops);
	const textStops = Number(calls.textStops);
	const destroyCalls = Number(voiceOnlyClient.destroyCalls);
	if (voiceStops !== 1 || textStops !== 1 || destroyCalls !== 1) {
		throw new Error("smoke: stop after voice restart should stop voice, text, and voice-only client");
	}
}

async function assertControllerStoredVoiceConfigErrorDoesNotBlockTextBridge(): Promise<void> {
	const authStorage = AuthStorage.inMemory();
	const calls = createControllerCallRecorder();
	const controller = new ClankyDiscordGatewayController({
		authStorage,
		paths: testControllerPaths(),
		env: {
			CLANKY_DISCORD_TOKEN: "discord-token",
		},
		readVoiceSettings: () => ({ enabled: true, guildId: "guild-1", channelId: "voice-1" }),
		dependencies: {
			async startGateway() {
				calls.startGatewayCalls += 1;
				return {
					client: calls.sharedClient as never,
					setSubagentThinkingLevel: () => 0,
					async stop() {
						calls.textStops += 1;
					},
				};
			},
			async startVoice() {
				calls.startVoiceCalls += 1;
				throw new Error("smoke: stored voice config error should skip voice startup");
			},
		},
	});
	controller.bindRuntime({} as never);
	await controller.start();
	const status = controller.status();
	if (calls.startGatewayCalls !== 1 || calls.startVoiceCalls !== 0) {
		throw new Error("smoke: stored voice config error should keep text bridge and skip voice");
	}
	if (
		status.textBridgeActive !== true ||
		status.voiceBridgeActive !== false ||
		typeof status.voiceConfigError !== "string" ||
		!status.voiceConfigError.includes("OpenAI credentials")
	) {
		throw new Error(`smoke: stored voice config error status mismatch: ${JSON.stringify(status)}`);
	}
	await controller.stop();
}

async function assertControllerEnvVoiceConfigErrorStillFailsFast(): Promise<void> {
	const authStorage = AuthStorage.inMemory();
	const controller = new ClankyDiscordGatewayController({
		authStorage,
		paths: testControllerPaths(),
		env: {
			CLANKY_DISCORD_TOKEN: "discord-token",
			CLANKY_DISCORD_VOICE_ENABLED: "1",
			CLANKY_DISCORD_VOICE_AUTO_JOIN: "1",
			CLANKY_DISCORD_VOICE_GUILD_ID: "guild-1",
			CLANKY_DISCORD_VOICE_CHANNEL_ID: "voice-1",
		},
	});
	controller.bindRuntime({} as never);
	await assertRejects(() => controller.start(), "OpenAI credentials");
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
			CLANKY_DISCORD_VOICE_AUTO_JOIN: "1",
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
					setSubagentThinkingLevel: () => 0,
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
			CLANKY_DISCORD_VOICE_AUTO_JOIN: "1",
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
