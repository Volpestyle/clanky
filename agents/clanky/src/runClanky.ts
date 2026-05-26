import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createClankyExtensionFactories,
	createClankyToolDefinitions,
	type DiscordVoiceJoinToolInput,
	loadClankySkills,
	loadStoredDiscordCredential,
	resolveClankyPaths,
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
import { ClankyDiscordGatewayController } from "./discordGatewayController.ts";
import { DiscordVoiceSettingsStore } from "./discordVoiceSettings.ts";
import { createClankyHandlers } from "./handlers.ts";
import { createOpenAiAuthExtensionFactory } from "./openAiAuth.ts";
import { loadPersona } from "./persona.ts";
import { createClankyStores } from "./stores.ts";
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
	voiceSettings.write({ ...current, enabled: true, guildId, channelId });
	await gatewayController.restart();
	return { settings: voiceSettings.read(), bridge: gatewayController.status() };
}

async function leaveDiscordVoiceFromTool(
	voiceSettings: DiscordVoiceSettingsStore,
	gatewayController: ClankyDiscordGatewayController,
): Promise<unknown> {
	const next = { ...(voiceSettings.read() ?? { enabled: false }), enabled: true };
	delete next.guildId;
	delete next.channelId;
	voiceSettings.write(next);
	await gatewayController.restart();
	return { settings: voiceSettings.read(), bridge: gatewayController.status() };
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
	defaultThinkingLevel: () => ClankyThinkingLevel;
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
		defaultThinkingLevel,
		additionalExtensionFactories = [],
	} = opts;
	const handlers = createClankyHandlers(paths, stores, {
		authStorage,
		mainSessionContext: async (input) => gatewayController.mainSessionContext(input),
		delegateToMainWorker: async (input) => gatewayController.delegateToMainWorker(input),
	});
	handlers.discordVoiceStatus = async () => ({
		settings: discordVoiceSettings.read(),
		bridge: gatewayController.status(),
	});
	handlers.discordVoiceJoin = async (input) => joinDiscordVoiceFromTool(input, discordVoiceSettings, gatewayController);
	handlers.discordVoiceLeave = async () => leaveDiscordVoiceFromTool(discordVoiceSettings, gatewayController);
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
					...additionalExtensionFactories,
					discordAuthFactory,
					openAiAuthFactory,
					xAiAuthFactory,
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
			customTools: createClankyToolDefinitions(handlers),
		};
		if (sessionStartEvent !== undefined) fromServicesOptions.sessionStartEvent = sessionStartEvent;

		const result = await createAgentSessionFromServices(fromServicesOptions);
		return { ...result, services, diagnostics: services.diagnostics };
	};
}

export function createClankyEffortExtensionFactory(
	defaults: ClankyRuntimeDefaults,
	options: { setActiveSubagentThinkingLevel?: (level: ClankyThinkingLevel) => number } = {},
): ExtensionFactory {
	return (pi) => {
		pi.on("thinking_level_select", (event) => {
			if (isClankyThinkingLevel(event.level)) defaults.mainThinkingLevel = event.level;
		});
		pi.registerCommand("effort", {
			description: "Show or set Clanky reasoning effort",
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
				if (parsed.target === "main" || parsed.target === "all") {
					defaults.mainThinkingLevel = parsed.level;
					pi.setThinkingLevel(parsed.level);
					const effectiveMain = pi.getThinkingLevel();
					if (isClankyThinkingLevel(effectiveMain)) defaults.mainThinkingLevel = effectiveMain;
				}
				if (parsed.target === "subagents" || parsed.target === "all") {
					defaults.subagentThinkingLevel = parsed.level;
					activeSubagentsUpdated = options.setActiveSubagentThinkingLevel?.(parsed.level) ?? 0;
				}
				ctx.ui.notify(formatEffortUpdate(parsed.target, defaults, pi.getThinkingLevel(), activeSubagentsUpdated));
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
): string {
	const lines = [
		"Effort updated",
		`Main Clanky: ${effectiveMain} (default ${defaults.mainThinkingLevel})`,
		`Clanky subagents: ${defaults.subagentThinkingLevel}`,
	];
	if (target === "subagents" || target === "all") {
		lines.push(`Active subagent sessions updated: ${activeSubagentsUpdated}`);
	}
	return lines.join("\n");
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
	const basePersona = await loadPersona(resolvePackageRoot());
	const authStorage = AuthStorage.create(paths.authFile);
	const discordProviderId = resolveDefaultDiscordProviderId();
	const discordVoiceSettings = new DiscordVoiceSettingsStore(paths.discordVoiceSettingsFile);
	const stores = createClankyStores(paths);
	const runtimeDefaults: ClankyRuntimeDefaults = {
		mainThinkingLevel: DEFAULT_CLANKY_MAIN_THINKING_LEVEL,
		subagentThinkingLevel: DEFAULT_CLANKY_SUBAGENT_THINKING_LEVEL,
	};
	const gatewayController = new ClankyDiscordGatewayController({
		authStorage,
		paths,
		bridgeLogPath: `${paths.profileDir}/discord-bridge.log`,
		readVoiceSettings: () => discordVoiceSettings.read(),
	});
	const runtimeFactoryOptions = {
		paths,
		stores,
		basePersona,
		authStorage,
		discordProviderId,
		gatewayController,
		discordVoiceSettings,
	};
	const createRuntime = buildRuntimeFactory({
		...runtimeFactoryOptions,
		defaultThinkingLevel: () => runtimeDefaults.mainThinkingLevel,
		additionalExtensionFactories: [
			createClankyEffortExtensionFactory(runtimeDefaults, {
				setActiveSubagentThinkingLevel: (level) => gatewayController.setSubagentThinkingLevel(level),
			}),
		],
	});
	const createSubagentRuntime = buildRuntimeFactory({
		...runtimeFactoryOptions,
		defaultThinkingLevel: () => runtimeDefaults.subagentThinkingLevel,
	});
	gatewayController.bindSubagentRuntimeFactory(createSubagentRuntime, cwd);

	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir: paths.profileDir,
		sessionManager: SessionManager.create(cwd, paths.sessionsDir),
	});
	gatewayController.bindRuntime(runtime);

	return { runtime, paths, authStorage, gatewayController, discordVoiceSettings, createRuntime, createSubagentRuntime };
}

/**
 * Launch clanky in interactive TUI mode.
 *
 * Wires the @clanky/core agent-tool handlers + extension factories, injects
 * the clanky persona via systemPromptOverride, merges bundled/profile skills,
 * sets Clanky's model defaults, and hands the runtime to `InteractiveMode`.
 */
export async function runClanky(options: RunClankyOptions = {}): Promise<void> {
	const { runtime, gatewayController } = await createClankyRuntime(options);
	await gatewayController.start();

	const interactiveOptions: ConstructorParameters<typeof InteractiveMode>[1] = {};
	if (options.initialMessage !== undefined) interactiveOptions.initialMessage = options.initialMessage;

	const mode = new InteractiveMode(runtime, interactiveOptions);
	try {
		await mode.init();
		await mode.run();
	} finally {
		await gatewayController.stop();
	}
}
