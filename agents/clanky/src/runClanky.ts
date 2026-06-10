import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ClankyCommandCompletionSpec,
	completeClankyCommandArgument,
	createClankyExtensionFactories,
	createClankyToolDefinitions,
	createToolSearchExtensionFactory,
	type DiscordVoiceJoinToolInput,
	type DiscordVoiceOperationOptions,
	getOpenAiCredentialStatus,
	loadClankySkills,
	loadStoredDiscordCredential,
	resolveClankyPaths,
	resolveMcpServerConfigs,
	truncateText,
} from "@clanky/core";
import {
	AuthStorage,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type ExtensionFactory,
	InteractiveMode,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createClankyAuthExtensionFactory } from "./authCommands.ts";
import {
	CLANKY_THINKING_LEVELS,
	type ClankyRuntimeDefaults,
	type ClankyThinkingLevel,
	DEFAULT_CLANKY_MAIN_THINKING_LEVEL,
	DEFAULT_CLANKY_MODEL_ID,
	DEFAULT_CLANKY_MODEL_PROVIDER,
	DEFAULT_CLANKY_SUBAGENT_THINKING_LEVEL,
	isClankyThinkingLevel,
} from "./clankyDefaults.ts";
import { createDiscordAuthExtensionFactory, resolveDefaultDiscordProviderId } from "./discordAuth.ts";
import { ClankyDiscordGatewayController, type DiscordVoiceStartProgress } from "./discordGatewayController.ts";
import { DiscordVoiceSettingsStore } from "./discordVoiceSettings.ts";
import { createElevenLabsAuthExtensionFactory } from "./elevenLabsAuth.ts";
import { createClankyHandlers } from "./handlers.ts";
import { createOpenAiAuthExtensionFactory } from "./openAiAuth.ts";
import { loadPersona } from "./persona.ts";
import { createClankySetupExtensionFactory } from "./setupWizard.ts";
import { createClankyStores } from "./stores.ts";
import { createClankyVoiceLogsExtensionFactory } from "./voiceLogs.ts";
import { interpretVoiceStatus } from "./voiceStatus.ts";
import {
	createVoiceSupervisorExtensionFactory,
	type VoiceSupervisorDelegateHandle,
} from "./voiceSupervisorExtension.ts";
import { createXAiAuthExtensionFactory } from "./xAiAuth.ts";

export {
	DEFAULT_CLANKY_MAIN_THINKING_LEVEL,
	DEFAULT_CLANKY_MODEL_ID,
	DEFAULT_CLANKY_MODEL_PROVIDER,
	DEFAULT_CLANKY_SUBAGENT_THINKING_LEVEL,
} from "./clankyDefaults.ts";

export interface RunClankyOptions {
	cwd?: string;
	homeDir?: string;
	profile?: string;
	initialMessage?: string;
}

const STARTUP_PROGRESS_FRAMES = ["-", "\\", "|", "/"];
const CLANKY_VOICE_STATUS_UI_KEY = "clanky-voice";
const CLANKY_VOICE_STATUS_REFRESH_MS = 2000;
const EFFORT_TARGET_COMPLETIONS = [
	{ target: "main", label: "main" },
	{ target: "subagents", label: "subagents" },
	{ target: "all", label: "all" },
] as const;
const EFFORT_COMMAND_COMPLETIONS = [
	{ value: "status", description: "Show current Clanky reasoning effort defaults." },
	...CLANKY_THINKING_LEVELS.map((level) => ({
		value: level,
		description: "Set main Clanky reasoning effort.",
	})),
	...EFFORT_TARGET_COMPLETIONS.flatMap((target) =>
		CLANKY_THINKING_LEVELS.map((level) => ({
			value: `${target.target} ${level}`,
			label: `${target.label} ${level}`,
			description: `Set ${target.label} reasoning effort.`,
		})),
	),
] satisfies readonly ClankyCommandCompletionSpec[];

/**
 * Append a "Discord identity" block to the persona markdown if a Discord
 * credential is stored for this profile. Tells Clanky who he is on Discord
 * from turn 1 without needing a tool call. Env-driven tokens skip this
 * block today (no stored identity to read); run `/discord-login` to fill
 * it in.
 */
function augmentPersonaWithDiscordIdentity(basePersona: string, authStorage: AuthStorage, providerId: string): string {
	const stored = loadStoredDiscordCredential(authStorage, providerId);
	if (stored === undefined) return basePersona;
	const { identity, credentialKind, conversationId } = stored.payload;
	if (identity === undefined) return basePersona;
	const block = [
		"## Discord identity",
		"",
		`You are connected to Discord as ${identity.username} (id ${identity.id}, ${credentialKind}).`,
		conversationId !== undefined
			? `You are bound to Discord conversation id ${conversationId}.`
			: "You respond to DMs and to messages where you are @-mentioned.",
	].join("\n");
	return `${basePersona}\n\n${block}`;
}

async function joinDiscordVoiceFromTool(
	input: DiscordVoiceJoinToolInput,
	voiceSettings: DiscordVoiceSettingsStore,
	gatewayController: ClankyDiscordGatewayController,
	options: DiscordVoiceOperationOptions = {},
): Promise<unknown> {
	const guildId = cleanRequiredDiscordVoiceToolString(input.guildId ?? input.guild_id, "guild_id");
	const channelId = cleanRequiredDiscordVoiceToolString(input.channelId ?? input.channel_id, "channel_id");
	const current = voiceSettings.read() ?? { enabled: false };
	if (current.allowedGuildIds !== undefined && current.allowedGuildIds.length > 0) {
		if (!current.allowedGuildIds.includes(guildId)) {
			throw new Error(`Discord voice guild ${guildId} is not in the configured server allowlist.`);
		}
	}
	if (current.allowedChannelIds !== undefined && current.allowedChannelIds.length > 0) {
		if (!current.allowedChannelIds.includes(channelId)) {
			throw new Error(`Discord voice channel ${channelId} is not in the configured voice allowlist.`);
		}
	}
	options.onProgress?.({
		phase: "saving_settings",
		message: "Saving Discord voice target.",
		guildId,
		channelId,
	});
	voiceSettings.write({ ...current, enabled: true, guildId, channelId });
	await gatewayController.restartVoice({
		joinRequested: true,
		onProgress: (progress) => options.onProgress?.(progress),
	});
	return {
		settings: voiceSettings.read(),
		bridge: gatewayController.status(),
		handoff: {
			subagentKind: "discord-voice",
			subagentId: `discord-voice:${guildId}:${channelId}`,
			note: "Live Discord voice conversation is owned by the separate discord-voice subagent. The text Discord subagent should only send a brief handoff confirmation if useful.",
		},
	};
}

async function leaveDiscordVoiceFromTool(
	voiceSettings: DiscordVoiceSettingsStore,
	gatewayController: ClankyDiscordGatewayController,
	options: DiscordVoiceOperationOptions = {},
): Promise<unknown> {
	options.onProgress?.({
		phase: "saving_settings",
		message: "Saving Discord voice leave request.",
	});
	const next = { ...(voiceSettings.read() ?? { enabled: false }), enabled: true };
	delete next.guildId;
	delete next.channelId;
	voiceSettings.write(next);
	await gatewayController.restartVoice({
		onProgress: (progress) => options.onProgress?.(progress),
	});
	return {
		settings: voiceSettings.read(),
		bridge: gatewayController.status(),
		handoff: {
			subagentKind: "discord-voice",
			note: "The text Discord subagent should not act as the live voice agent.",
		},
	};
}

function cleanRequiredDiscordVoiceToolString(value: string | undefined, field: string): string {
	const cleaned = value?.trim();
	if (cleaned === undefined || cleaned.length === 0) {
		throw new Error(`discord_voice_join requires ${field}.`);
	}
	return cleaned;
}

/**
 * Resolve the @clanky/agent package root from this file's location.
 *
 * This module lives at `<package>/src/runClanky.ts`, so we pop the trailing
 * `/src` to get the package root that contains `persona/SELF.md`.
 */
function resolvePackageRoot(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	return here.endsWith(`${"/"}src`) ? here.slice(0, -4) : here;
}

/**
 * Build the runtime factory clanky uses for every InteractiveMode session
 * (initial + later /new, /resume, /fork, /import).
 *
 * The factory closes over a single ClankyPaths + ClankyStores + persona
 * markdown so every recreated runtime sees the same agent identity, the same
 * sqlite/jsonl stores, and the same on-disk skills index.
 */
function buildRuntimeFactory(opts: {
	paths: ReturnType<typeof resolveClankyPaths>;
	stores: ReturnType<typeof createClankyStores>;
	basePersona: string;
	authStorage: AuthStorage;
	discordProviderId: string;
	gatewayController: ClankyDiscordGatewayController;
	discordVoiceSettings: DiscordVoiceSettingsStore;
	env: NodeJS.ProcessEnv;
	defaultThinkingLevel: () => ClankyThinkingLevel;
	includeMainWorkerDelegationTool?: boolean;
	additionalExtensionFactories?: ExtensionFactory[];
}): CreateAgentSessionRuntimeFactory {
	const {
		paths,
		stores,
		basePersona,
		authStorage,
		discordProviderId,
		gatewayController,
		discordVoiceSettings,
		env,
		defaultThinkingLevel,
		includeMainWorkerDelegationTool = true,
		additionalExtensionFactories = [],
	} = opts;
	const handlers = createClankyHandlers(paths, stores, {
		env,
		authStorage,
		mainSessionContext: async (input) => gatewayController.mainSessionContext(input),
		mainAgentActivity: async (input) => gatewayController.mainAgentActivity(input),
		mainAgentCancel: async (input) => gatewayController.cancelMainAgent(input),
		delegateToMainWorker: async (input) => gatewayController.delegateToMainWorker(input),
		sendSubagentMessage: async (input) => gatewayController.sendSubagentMessage(input),
	});
	handlers.discordVoiceStatus = async () => ({
		settings: discordVoiceSettings.read(),
		bridge: gatewayController.status(),
	});
	handlers.discordVoiceJoin = async (input, options) =>
		joinDiscordVoiceFromTool(input, discordVoiceSettings, gatewayController, options);
	handlers.discordVoiceLeave = async (options) =>
		leaveDiscordVoiceFromTool(discordVoiceSettings, gatewayController, options);
	const discordAuthFactory = createDiscordAuthExtensionFactory({
		authStorage,
		providerId: discordProviderId,
		authFilePath: paths.authFile,
		gatewayController,
		voiceSettings: discordVoiceSettings,
	});
	const openAiAuthFactory = createOpenAiAuthExtensionFactory({
		authStorage,
		authFilePath: paths.authFile,
		gatewayController,
	});
	const xAiAuthFactory = createXAiAuthExtensionFactory({
		authStorage,
		authFilePath: paths.authFile,
	});
	const elevenLabsAuthFactory = createElevenLabsAuthExtensionFactory({
		authStorage,
		authFilePath: paths.authFile,
		gatewayController,
		baseUrl: () => discordVoiceSettings.read()?.elevenLabsBaseUrl,
	});
	const clankyAuthFactory = createClankyAuthExtensionFactory({
		authStorage,
		authFilePath: paths.authFile,
		discordProviderId,
		gatewayController,
	});

	return async ({ cwd: runtimeCwd, sessionManager, sessionStartEvent }) => {
		const modelRegistry = ModelRegistry.create(authStorage, paths.modelsFile);
		const settingsManager = SettingsManager.inMemory({
			defaultProvider: DEFAULT_CLANKY_MODEL_PROVIDER,
			defaultModel: DEFAULT_CLANKY_MODEL_ID,
			defaultThinkingLevel: defaultThinkingLevel(),
		});

		const servicesOptions = {
			cwd: runtimeCwd,
			agentDir: paths.profileDir,
			authStorage,
			modelRegistry,
			settingsManager,
			resourceLoaderOptions: {
				extensionFactories: [
					...createClankyExtensionFactories(handlers),
					createToolSearchExtensionFactory({
						env,
						mcpClientOptions: { cwd: runtimeCwd, env, paths },
						mcpServers: (ctx) => resolveMcpServerConfigs({ cwd: ctx.cwd, env, paths }),
					}),
					...additionalExtensionFactories,
					discordAuthFactory,
					openAiAuthFactory,
					xAiAuthFactory,
					elevenLabsAuthFactory,
					clankyAuthFactory,
				],
				// Recomputed per call so post-`/discord-login` reloads pick up the new identity.
				systemPromptOverride: (existing: string | undefined): string => {
					const persona = augmentPersonaWithDiscordIdentity(basePersona, authStorage, discordProviderId);
					return existing && existing.length > 0 ? `${existing}\n\n${persona}` : persona;
				},
				skillsOverride: (current: ReturnType<typeof loadClankySkills>) => {
					const clankySkills = loadClankySkills({ paths });
					const byName = new Map<string, (typeof current.skills)[number]>();
					for (const skill of clankySkills.skills) byName.set(skill.name, skill);
					for (const skill of current.skills) byName.set(skill.name, skill);
					return {
						skills: [...byName.values()],
						diagnostics: [...current.diagnostics, ...clankySkills.diagnostics],
					};
				},
			},
		};

		const services = await createAgentSessionServices(servicesOptions);

		const fromServicesOptions: Parameters<typeof createAgentSessionFromServices>[0] = {
			services,
			sessionManager,
			customTools: createClankyToolDefinitions(handlers, {
				includeMainWorkerDelegation: includeMainWorkerDelegationTool,
			}),
		};
		if (sessionStartEvent !== undefined) fromServicesOptions.sessionStartEvent = sessionStartEvent;

		const result = await createAgentSessionFromServices(fromServicesOptions);
		return { ...result, services, diagnostics: services.diagnostics };
	};
}

export function createClankyEffortExtensionFactory(
	defaults: ClankyRuntimeDefaults,
	options: {
		setActiveSubagentThinkingLevel?: (level: ClankyThinkingLevel) => number;
		setKnownSubagentThinkingLevel?: (level: ClankyThinkingLevel) => Promise<number>;
	} = {},
): ExtensionFactory {
	return (pi) => {
		pi.on("thinking_level_select", (event) => {
			if (isClankyThinkingLevel(event.level)) defaults.mainThinkingLevel = event.level;
		});
		pi.registerCommand("effort", {
			description: "Show or set Clanky reasoning effort",
			getArgumentCompletions: (prefix) => completeClankyCommandArgument(prefix, EFFORT_COMMAND_COMPLETIONS),
			handler: async (args, ctx) => {
				const parsed = parseEffortCommandArgs(args);
				if (parsed === undefined) {
					ctx.ui.notify(formatEffortUsage(defaults), "warning");
					return;
				}
				if (parsed.target === "status") {
					ctx.ui.notify(formatEffortStatus(defaults, pi.getThinkingLevel()));
					return;
				}
				let activeSubagentsUpdated = 0;
				let knownSubagentsUpdated: number | undefined;
				if (parsed.target === "main" || parsed.target === "all") {
					defaults.mainThinkingLevel = parsed.level;
					pi.setThinkingLevel(parsed.level);
					const effectiveMain = pi.getThinkingLevel();
					if (isClankyThinkingLevel(effectiveMain)) defaults.mainThinkingLevel = effectiveMain;
				}
				if (parsed.target === "subagents" || parsed.target === "all") {
					defaults.subagentThinkingLevel = parsed.level;
					activeSubagentsUpdated = options.setActiveSubagentThinkingLevel?.(parsed.level) ?? 0;
					knownSubagentsUpdated = await options.setKnownSubagentThinkingLevel?.(parsed.level);
				}
				ctx.ui.notify(
					formatEffortUpdate(
						parsed.target,
						defaults,
						pi.getThinkingLevel(),
						activeSubagentsUpdated,
						knownSubagentsUpdated,
					),
				);
			},
		});
	};
}

type EffortCommandTarget = "main" | "subagents" | "all";

type ParsedEffortCommand =
	| {
			target: "status";
	  }
	| {
			target: EffortCommandTarget;
			level: ClankyThinkingLevel;
	  };

function parseEffortCommandArgs(args: string): ParsedEffortCommand | undefined {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return { target: "status" };
	const first = parts[0];
	if (parts.length === 1 && first === "status") return { target: "status" };
	if (parts.length === 1 && first !== undefined && isClankyThinkingLevel(first)) {
		return { target: "main", level: first };
	}
	if (parts.length !== 2) return undefined;
	if (first === undefined) return undefined;
	const target = parseEffortTarget(first);
	const level = parts[1];
	if (level === undefined || target === undefined || !isClankyThinkingLevel(level)) return undefined;
	return { target, level };
}

function parseEffortTarget(value: string): EffortCommandTarget | undefined {
	const normalized = value.toLowerCase();
	if (normalized === "main" || normalized === "clanky" || normalized === "self") return "main";
	if (normalized === "subagent" || normalized === "subagents" || normalized === "discord") return "subagents";
	if (normalized === "all" || normalized === "both") return "all";
	return undefined;
}

function formatEffortStatus(defaults: ClankyRuntimeDefaults, effectiveMain: string): string {
	return [
		"Effort",
		`Main Clanky: ${effectiveMain} (default ${defaults.mainThinkingLevel})`,
		`Clanky subagents: ${defaults.subagentThinkingLevel}`,
		"",
		"Usage: /effort [main|subagents|all] <off|minimal|low|medium|high|xhigh>",
	].join("\n");
}

function formatEffortUsage(defaults: ClankyRuntimeDefaults): string {
	return [
		"Effort",
		"Usage: /effort [main|subagents|all] <off|minimal|low|medium|high|xhigh>",
		`Current defaults: main ${defaults.mainThinkingLevel}, subagents ${defaults.subagentThinkingLevel}.`,
		`Levels: ${CLANKY_THINKING_LEVELS.join(", ")}`,
	].join("\n");
}

function formatEffortUpdate(
	target: EffortCommandTarget,
	defaults: ClankyRuntimeDefaults,
	effectiveMain: string,
	activeSubagentsUpdated: number,
	knownSubagentsUpdated?: number,
): string {
	const lines = [
		"Effort updated",
		`Main Clanky: ${effectiveMain} (default ${defaults.mainThinkingLevel})`,
		`Clanky subagents: ${defaults.subagentThinkingLevel}`,
	];
	if (target === "subagents" || target === "all") {
		lines.push(`Active subagent sessions updated: ${activeSubagentsUpdated}`);
		if (knownSubagentsUpdated !== undefined) {
			lines.push(`Known subagent rows updated: ${knownSubagentsUpdated}`);
		}
	}
	return lines.join("\n");
}

function createClankyWelcomeExtensionFactory(input: {
	authStorage: AuthStorage;
	profile: string;
	env: NodeJS.ProcessEnv;
}): ExtensionFactory {
	return (pi) => {
		pi.on("session_start", async (_event, ctx) => {
			if (!ctx.hasUI) return;
			const status = getOpenAiCredentialStatus(input.env, input.authStorage);
			if (status.available) {
				ctx.ui.setHeader(undefined);
				return;
			}
			ctx.ui.setHeader((_tui, theme) => ({
				render(width: number): string[] {
					const profile = truncateText(input.profile, Math.max(12, width - "Profile: ".length));
					return [
						"",
						theme.bold("Clanky"),
						theme.fg("error", "OpenAI is not configured. Type /setup to begin."),
						theme.fg("dim", `Profile: ${profile}`),
						"",
					];
				},
				invalidate() {},
			}));
		});
	};
}

function createClankyVoiceStatusExtensionFactory(gatewayController: ClankyDiscordGatewayController): ExtensionFactory {
	return (pi) => {
		let timer: ReturnType<typeof setInterval> | undefined;
		pi.on("session_start", async (_event, ctx) => {
			if (!ctx.hasUI) return;
			const update = () => {
				ctx.ui.setStatus(CLANKY_VOICE_STATUS_UI_KEY, formatClankyVoiceFooterStatus(gatewayController.status()));
			};
			update();
			timer = setInterval(update, CLANKY_VOICE_STATUS_REFRESH_MS);
			timer.unref?.();
		});
		pi.on("session_shutdown", (_event, ctx) => {
			if (timer !== undefined) {
				clearInterval(timer);
				timer = undefined;
			}
			if (ctx.hasUI) ctx.ui.setStatus(CLANKY_VOICE_STATUS_UI_KEY, undefined);
		});
	};
}

function formatClankyVoiceFooterStatus(status: unknown): string | undefined {
	const state = interpretVoiceStatus(status);
	switch (state.kind) {
		case "unavailable":
		case "inactive":
			return undefined;
		case "error":
			return "voice error";
		case "ready":
			return "voice ready";
		case "live":
			return state.channelId === undefined ? "voice live" : `voice live channel ${shortDiscordId(state.channelId)}`;
		case "client-live":
			return "voice client live";
	}
}

/**
 * Build (but do not start) the clanky AgentSessionRuntime. Exposed primarily
 * for smoke tests that want to assert wiring without needing a TTY.
 */
export async function createClankyRuntime(options: RunClankyOptions = {}) {
	const cwd = options.cwd ?? process.cwd();
	const pathsOptions: Parameters<typeof resolveClankyPaths>[0] = {};
	if (options.homeDir !== undefined) pathsOptions.homeDir = options.homeDir;
	if (options.profile !== undefined) pathsOptions.profile = options.profile;
	const paths = resolveClankyPaths(pathsOptions);
	const runtimeEnv = process.env;
	const basePersona = await loadPersona(resolvePackageRoot());
	const authStorage = AuthStorage.create(paths.authFile);
	const discordProviderId = resolveDefaultDiscordProviderId(runtimeEnv);
	const discordVoiceSettings = new DiscordVoiceSettingsStore(paths.discordVoiceSettingsFile);
	const stores = createClankyStores(paths);
	const voiceLogPath = `${paths.profileDir}/discord-voice.log`;
	const voiceSupervisorDelegate: VoiceSupervisorDelegateHandle = {};
	const runtimeDefaults: ClankyRuntimeDefaults = {
		mainThinkingLevel: DEFAULT_CLANKY_MAIN_THINKING_LEVEL,
		subagentThinkingLevel: DEFAULT_CLANKY_SUBAGENT_THINKING_LEVEL,
	};
	const gatewayController = new ClankyDiscordGatewayController({
		authStorage,
		paths,
		bridgeLogPath: `${paths.profileDir}/discord-bridge.log`,
		voiceLogPath,
		env: runtimeEnv,
		readVoiceSettings: () => discordVoiceSettings.read(),
		voiceSupervisorDelegate,
	});
	const runtimeFactoryOptions = {
		paths,
		stores,
		basePersona,
		authStorage,
		discordProviderId,
		gatewayController,
		discordVoiceSettings,
		env: runtimeEnv,
	};
	const createRuntime = buildRuntimeFactory({
		...runtimeFactoryOptions,
		defaultThinkingLevel: () => runtimeDefaults.mainThinkingLevel,
		includeMainWorkerDelegationTool: false,
		additionalExtensionFactories: [
			createClankyWelcomeExtensionFactory({
				authStorage,
				profile: paths.profile,
				env: runtimeEnv,
			}),
			createClankyVoiceStatusExtensionFactory(gatewayController),
			createClankySetupExtensionFactory({
				cwd,
				paths,
				authStorage,
				discordProviderId,
				gatewayController,
				voiceSettings: discordVoiceSettings,
				env: runtimeEnv,
			}),
			createClankyVoiceLogsExtensionFactory({
				voiceLogPath,
			}),
			createClankyEffortExtensionFactory(runtimeDefaults, {
				setActiveSubagentThinkingLevel: (level) => gatewayController.setSubagentThinkingLevel(level),
				setKnownSubagentThinkingLevel: (level) => stores.subagents.setAllSubagentThinkingLevel(level),
			}),
		],
	});
	const createSubagentRuntime = buildRuntimeFactory({
		...runtimeFactoryOptions,
		defaultThinkingLevel: () => runtimeDefaults.subagentThinkingLevel,
	});
	const createVoiceSubagentRuntime = buildRuntimeFactory({
		...runtimeFactoryOptions,
		defaultThinkingLevel: () => runtimeDefaults.subagentThinkingLevel,
		additionalExtensionFactories: [createVoiceSupervisorExtensionFactory(voiceSupervisorDelegate)],
	});
	gatewayController.bindSubagentRuntimeFactory(createSubagentRuntime, cwd, createVoiceSubagentRuntime);

	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir: paths.profileDir,
		sessionManager: SessionManager.create(cwd, paths.sessionsDir),
	});
	gatewayController.bindRuntime(runtime);

	return {
		runtime,
		paths,
		authStorage,
		gatewayController,
		discordVoiceSettings,
		createRuntime,
		createSubagentRuntime,
		createVoiceSubagentRuntime,
	};
}

/**
 * Launch clanky in interactive TUI mode.
 *
 * Wires the @clanky/core agent-tool handlers + extension factories, injects
 * the clanky persona via systemPromptOverride, merges bundled/profile skills,
 * sets Clanky's model defaults, and hands the runtime to `InteractiveMode`.
 */
export async function runClanky(options: RunClankyOptions = {}): Promise<void> {
	const startup = createStartupProgressIndicator();
	startup.update("Loading Clanky runtime.");
	const { runtime, gatewayController } = await createClankyRuntime(options);
	startup.update("Starting Discord bridges.");
	await gatewayController.start({
		onProgress: (progress) => startup.voice(progress),
	});

	const interactiveOptions: ConstructorParameters<typeof InteractiveMode>[1] = {};
	if (options.initialMessage !== undefined) interactiveOptions.initialMessage = options.initialMessage;

	const mode = new InteractiveMode(runtime, interactiveOptions);
	try {
		startup.update("Opening Pi TUI.");
		startup.stop();
		await mode.init();
		await mode.run();
	} finally {
		startup.stop();
		await gatewayController.stop();
	}
}

function createStartupProgressIndicator(stream: NodeJS.WriteStream = process.stderr): {
	update(message: string): void;
	voice(progress: DiscordVoiceStartProgress): void;
	stop(): void;
} {
	const enabled = stream.isTTY === true && process.env.CLANKY_STARTUP_PROGRESS !== "0";
	let message = "Starting Clanky.";
	let frame = 0;
	let rendered = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	const startedAt = Date.now();

	const render = () => {
		if (!enabled) return;
		const spinner = STARTUP_PROGRESS_FRAMES[frame % STARTUP_PROGRESS_FRAMES.length] ?? "-";
		frame += 1;
		const line = truncateStartupProgressLine(
			`clanky ${spinner} ${message} (${formatStartupElapsed(Date.now() - startedAt)})`,
			stream.columns,
		);
		stream.write(`\r\x1b[K${line}`);
		rendered = true;
	};

	const ensureTimer = () => {
		if (!enabled || timer !== undefined) return;
		timer = setInterval(render, 120);
		timer.unref?.();
	};

	return {
		update(nextMessage) {
			message = nextMessage;
			ensureTimer();
			render();
		},
		voice(progress) {
			this.update(formatStartupVoiceProgress(progress));
		},
		stop() {
			if (timer !== undefined) {
				clearInterval(timer);
				timer = undefined;
			}
			if (enabled && rendered) {
				stream.write("\r\x1b[K");
				rendered = false;
			}
		},
	};
}

function formatStartupVoiceProgress(progress: DiscordVoiceStartProgress): string {
	const target = [
		progress.guildId === undefined ? undefined : `guild ${shortDiscordId(progress.guildId)}`,
		progress.channelId === undefined ? undefined : `channel ${shortDiscordId(progress.channelId)}`,
	].filter((part): part is string => part !== undefined);
	const suffix = target.length === 0 ? "" : ` (${target.join(", ")})`;
	return `${progress.message}${suffix}`;
}

function shortDiscordId(id: string): string {
	if (id.length <= 10) return id;
	return `${id.slice(0, 4)}...${id.slice(-4)}`;
}

function truncateStartupProgressLine(line: string, columns: number | undefined): string {
	const width = Math.max(20, (columns ?? 80) - 1);
	return truncateText(line, width);
}

function formatStartupElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}
