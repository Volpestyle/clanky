import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createClankyExtensionFactories,
	createClankyToolDefinitions,
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
	InteractiveMode,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createDiscordAuthExtensionFactory, resolveDefaultDiscordProviderId } from "./discordAuth.ts";
import { ClankyDiscordGatewayController } from "./discordGatewayController.ts";
import { createClankyHandlers } from "./handlers.ts";
import { createOpenAiAuthExtensionFactory } from "./openAiAuth.ts";
import { loadPersona } from "./persona.ts";
import { createClankyStores } from "./stores.ts";
import { createXAiAuthExtensionFactory } from "./xAiAuth.ts";

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
	basePersona: string;
	authStorage: AuthStorage;
	discordProviderId: string;
	gatewayController: ClankyDiscordGatewayController;
}): CreateAgentSessionRuntimeFactory {
	const { paths, basePersona, authStorage, discordProviderId, gatewayController } = opts;
	const stores = createClankyStores(paths);
	const handlers = createClankyHandlers(paths, stores, { authStorage });
	const discordAuthFactory = createDiscordAuthExtensionFactory({
		authStorage,
		providerId: discordProviderId,
		authFilePath: paths.authFile,
		gatewayController,
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
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });

		const servicesOptions = {
			cwd: runtimeCwd,
			agentDir: paths.profileDir,
			authStorage,
			modelRegistry,
			settingsManager,
			resourceLoaderOptions: {
				extensionFactories: [
					...createClankyExtensionFactories(handlers),
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
	const gatewayController = new ClankyDiscordGatewayController({
		authStorage,
		paths,
		bridgeLogPath: `${paths.profileDir}/discord-bridge.log`,
	});
	const createRuntime = buildRuntimeFactory({
		paths,
		basePersona,
		authStorage,
		discordProviderId,
		gatewayController,
	});
	gatewayController.bindSubagentRuntimeFactory(createRuntime, cwd);

	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir: paths.profileDir,
		sessionManager: SessionManager.create(cwd, paths.sessionsDir),
	});
	gatewayController.bindRuntime(runtime);

	return { runtime, paths, authStorage, gatewayController };
}

/**
 * Launch clanky in interactive TUI mode.
 *
 * Wires the @clanky/core agent-tool handlers + extension factories, injects
 * the clanky persona via systemPromptOverride, merges bundled/profile skills,
 * disables compaction, and hands the runtime to `InteractiveMode`.
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
