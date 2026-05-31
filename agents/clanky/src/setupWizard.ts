import {
	type ClankyCommandCompletionSpec,
	type ClankyMcpServerConfig,
	type ClankyPaths,
	completeClankyCommandArgument,
	DEFAULT_ELEVENLABS_PROVIDER_ID,
	DEFAULT_OPENAI_PROVIDER_ID,
	DEFAULT_XAI_PROVIDER_ID,
	getElevenLabsCredentialStatus,
	getOpenAiCredentialStatus,
	getXAiCredentialStatus,
	isAgentRoomEnrolled,
	loadStoredDiscordCredential,
	maybeLoadAgentRoomPortableConfig,
	readProfileMcpServers,
	removeProfileMcpServer,
	resolveClankyChatGatewayOwner,
	resolveClankyChatMode,
	upsertProfileMcpServer,
} from "@clanky/core";
import type { AuthStorage, ExtensionCommandContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { type DiscordAuthCommandDeps, runDiscordLogin, runDiscordVoiceCommand } from "./discordAuth.ts";
import type { ClankyDiscordGatewayController } from "./discordGatewayController.ts";
import type { DiscordVoiceSettingsAccessor } from "./discordVoiceSettings.ts";
import { runElevenLabsLogin } from "./elevenLabsAuth.ts";
import { runOpenAiLogin } from "./openAiAuth.ts";
import { interpretVoiceStatus, readStatusBoolean } from "./voiceStatus.ts";
import { runXAiLogin } from "./xAiAuth.ts";

interface ClankySetupWizardDeps {
	cwd: string;
	paths: ClankyPaths;
	authStorage: AuthStorage;
	discordProviderId: string;
	gatewayController: ClankyDiscordGatewayController;
	voiceSettings: DiscordVoiceSettingsAccessor;
	env?: NodeJS.ProcessEnv;
}

type SetupChoice = "status" | "openai" | "discord" | "voice" | "elevenlabs" | "xai" | "mcp" | "agentroom" | "done";

const SETUP_COMMAND_COMPLETIONS = [
	{ value: "status", description: "Show connector and profile setup status." },
	{ value: "mcp", description: "Show or configure profile-local MCP servers." },
	{ value: "agentroom", description: "Show AgentRoom room config defaults." },
	{ value: "fresh", description: "Show the fresh-profile setup smoke command." },
] satisfies readonly ClankyCommandCompletionSpec[];

export function createClankySetupExtensionFactory(deps: ClankySetupWizardDeps): ExtensionFactory {
	return (pi) => {
		pi.registerCommand("status", {
			description: "Show Clanky profile, connector, and bridge status",
			handler: async (_args, ctx) => {
				try {
					ctx.ui.notify(formatClankyStatusDashboard(deps));
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Clanky status error: ${message}`, "error");
				}
			},
		});
		pi.registerCommand("setup", {
			description: "Open Clanky's profile-local onboarding and connector setup wizard",
			getArgumentCompletions: (prefix) => completeClankyCommandArgument(prefix, SETUP_COMMAND_COMPLETIONS),
			handler: async (args, ctx) => {
				try {
					await runClankySetupCommand(deps, String(args ?? ""), ctx);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Clanky setup error: ${message}`, "error");
				}
			},
		});
	};
}

async function runClankySetupCommand(
	deps: ClankySetupWizardDeps,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const command = args.trim().toLowerCase();
	if (command === "status") {
		ctx.ui.notify(formatClankySetupStatus(deps));
		return;
	}
	if (command === "agentroom" || command === "room") {
		ctx.ui.notify(formatAgentRoomParticipation(deps));
		return;
	}
	if (command === "mcp") {
		ctx.ui.notify(formatMcpSetupStatus(deps));
		return;
	}
	if (command.startsWith("mcp ")) {
		ctx.ui.notify(configureMcpFromArgs(deps, args.trim().slice(4)));
		return;
	}
	if (command === "fresh" || command === "new-user") {
		ctx.ui.notify(formatFreshUserHelp(deps));
		return;
	}
	if (command.length > 0) {
		ctx.ui.notify(formatSetupUsage(), "warning");
		return;
	}
	await runClankySetupWizard(deps, ctx);
}

async function runClankySetupWizard(deps: ClankySetupWizardDeps, ctx: ExtensionCommandContext): Promise<void> {
	let done = false;
	while (!done) {
		const choice = await ctx.ui.select(setupTitle(deps), setupOptions(deps));
		switch (parseSetupChoice(choice)) {
			case "status":
				ctx.ui.notify(formatClankySetupStatus(deps));
				break;
			case "openai":
				await runOpenAiLogin(
					{
						authStorage: deps.authStorage,
						authFilePath: deps.paths.authFile,
						gatewayController: deps.gatewayController,
					},
					ctx,
				);
				done = true;
				break;
			case "discord":
				await runDiscordLogin(discordDeps(deps), ctx);
				done = true;
				break;
			case "voice":
				await runDiscordVoiceCommand(discordDeps(deps), "setup", ctx);
				break;
			case "elevenlabs":
				await runElevenLabsLogin(
					{
						authStorage: deps.authStorage,
						authFilePath: deps.paths.authFile,
						gatewayController: deps.gatewayController,
						baseUrl: () => deps.voiceSettings.read()?.elevenLabsBaseUrl,
					},
					ctx,
				);
				done = true;
				break;
			case "xai":
				await runXAiLogin(
					{
						authStorage: deps.authStorage,
						authFilePath: deps.paths.authFile,
					},
					ctx,
				);
				done = true;
				break;
			case "mcp":
				ctx.ui.notify(formatMcpSetupStatus(deps));
				break;
			case "agentroom":
				ctx.ui.notify(formatAgentRoomParticipation(deps));
				break;
			case "done":
				done = true;
				break;
		}
	}
}

function discordDeps(deps: ClankySetupWizardDeps): DiscordAuthCommandDeps {
	return {
		authStorage: deps.authStorage,
		providerId: deps.discordProviderId,
		authFilePath: deps.paths.authFile,
		gatewayController: deps.gatewayController,
		voiceSettings: deps.voiceSettings,
	};
}

function setupTitle(deps: ClankySetupWizardDeps): string {
	return `Clanky setup - ${deps.paths.profile}`;
}

function setupOptions(deps: ClankySetupWizardDeps): string[] {
	const env = setupEnv(deps);
	const openAiStatus = getOpenAiCredentialStatus(env, deps.authStorage, DEFAULT_OPENAI_PROVIDER_ID);
	const elevenLabsStatus = getElevenLabsCredentialStatus(env, deps.authStorage, DEFAULT_ELEVENLABS_PROVIDER_ID);
	const xaiStatus = getXAiCredentialStatus(env, deps.authStorage, DEFAULT_XAI_PROVIDER_ID);
	const voiceSettings = deps.voiceSettings.read();
	const roomConfig = maybeLoadAgentRoomPortableConfig(deps.cwd, env);
	return [
		"Status",
		`Models / OpenAI [${openAiStatus.available ? "set" : "missing"}]`,
		`Chat / Discord text [${hasDiscordCredential(deps) ? "set" : "missing"}]`,
		`Voice / Discord voice [${voiceSettings?.enabled === true ? "enabled" : "disabled"}]`,
		`Voice / ElevenLabs [${elevenLabsStatus.available ? "set" : "missing"}]`,
		`Media / xAI [${xaiStatus.available ? "set" : "missing"}]`,
		`MCP servers [${Object.keys(readProfileMcpServers(deps.paths).servers).length} profile]`,
		`AgentRoom [${agentRoomSetupLabel(env, roomConfig !== undefined)}]`,
		"Done",
	];
}

function parseSetupChoice(choice: string | undefined): SetupChoice {
	if (choice === undefined || choice === "Done") return "done";
	if (choice === "Status") return "status";
	if (choice.startsWith("Models / OpenAI")) return "openai";
	if (choice.startsWith("Chat / Discord text")) return "discord";
	if (choice.startsWith("Voice / Discord voice")) return "voice";
	if (choice.startsWith("Voice / ElevenLabs")) return "elevenlabs";
	if (choice.startsWith("Media / xAI")) return "xai";
	if (choice.startsWith("MCP servers")) return "mcp";
	if (choice.startsWith("AgentRoom")) return "agentroom";
	return "done";
}

function formatClankySetupStatus(deps: ClankySetupWizardDeps): string {
	const env = setupEnv(deps);
	const openAiStatus = getOpenAiCredentialStatus(env, deps.authStorage, DEFAULT_OPENAI_PROVIDER_ID);
	const elevenLabsStatus = getElevenLabsCredentialStatus(env, deps.authStorage, DEFAULT_ELEVENLABS_PROVIDER_ID);
	const xaiStatus = getXAiCredentialStatus(env, deps.authStorage, DEFAULT_XAI_PROVIDER_ID);
	const storedDiscord = loadStoredDiscordCredential(deps.authStorage, deps.discordProviderId);
	const envDiscord = env.CLANKY_DISCORD_TOKEN?.trim();
	const voiceSettings = deps.voiceSettings.read();
	const roomConfig = maybeLoadAgentRoomPortableConfig(deps.cwd, env);
	const profileMcp = readProfileMcpServers(deps.paths);
	const lines = [
		"Clanky setup",
		`Profile: ${deps.paths.profile}`,
		`Home: ${deps.paths.homeDir}`,
		`Profile dir: ${deps.paths.profileDir}`,
		"",
		`OpenAI: ${openAiStatus.available ? (openAiStatus.activeSource ?? "configured") : "missing"}`,
		`Discord text: ${discordCredentialLabel(envDiscord, storedDiscord)}`,
		`Discord owner: ${resolveClankyChatGatewayOwner(env)} (${resolveClankyChatMode(env)})`,
		`Discord voice: ${voiceSettings?.enabled === true ? "enabled" : "disabled"}`,
		`ElevenLabs: ${elevenLabsStatus.available ? (elevenLabsStatus.activeSource ?? "configured") : "missing"}`,
		`xAI media: ${xaiStatus.available ? (xaiStatus.activeSource ?? "configured") : "missing"}`,
		`MCP servers: ${Object.keys(profileMcp.servers).length} profile-local (${profileMcp.path})`,
		`AgentRoom: ${agentRoomSetupLabel(env, roomConfig !== undefined)}`,
		`Room config: ${roomConfig?.configPath ?? "not detected"}`,
		`Work tracker: ${env.CLANKY_WORK_TRACKER ?? "profile/default"} (${env.CLANKY_WORK_TRACKER_PROVIDER_KIND ?? "unknown"})`,
		"",
		"Connector ownership:",
		"Clanky-owned credentials live in this profile auth store.",
		"Room-owned connectors belong to AgentRoom and must not use this auth store.",
	];
	if (voiceSettings?.guildId !== undefined && voiceSettings.channelId !== undefined) {
		lines.push(`Voice target: guild ${voiceSettings.guildId}, channel ${voiceSettings.channelId}`);
	}
	return lines.join("\n");
}

function formatClankyStatusDashboard(deps: ClankySetupWizardDeps): string {
	const env = setupEnv(deps);
	const openAiStatus = getOpenAiCredentialStatus(env, deps.authStorage, DEFAULT_OPENAI_PROVIDER_ID);
	const elevenLabsStatus = getElevenLabsCredentialStatus(env, deps.authStorage, DEFAULT_ELEVENLABS_PROVIDER_ID);
	const xaiStatus = getXAiCredentialStatus(env, deps.authStorage, DEFAULT_XAI_PROVIDER_ID);
	const storedDiscord = loadStoredDiscordCredential(deps.authStorage, deps.discordProviderId);
	const envDiscord = env.CLANKY_DISCORD_TOKEN?.trim();
	const voiceSettings = deps.voiceSettings.read();
	const bridge = deps.gatewayController.status();
	const roomConfig = maybeLoadAgentRoomPortableConfig(deps.cwd, env);
	const profileMcp = readProfileMcpServers(deps.paths);
	const lines = [
		"Clanky status",
		`Profile: ${deps.paths.profile}`,
		`Home: ${deps.paths.homeDir}`,
		"",
		"Models",
		`OpenAI: ${openAiStatus.available ? (openAiStatus.activeSource ?? "configured") : "missing"}`,
		`xAI media: ${xaiStatus.available ? (xaiStatus.activeSource ?? "configured") : "missing"}`,
		"",
		"Discord",
		`Text credential: ${discordCredentialLabel(envDiscord, storedDiscord)}`,
		`Text bridge: ${formatStatusActive(readStatusBoolean(bridge, "textBridgeActive"))}`,
		`Voice settings: ${voiceSettings?.enabled === true ? "enabled" : "disabled"}`,
		`Voice bridge: ${formatVoiceDashboardStatus(bridge)}`,
		`ElevenLabs: ${elevenLabsStatus.available ? (elevenLabsStatus.activeSource ?? "configured") : "missing"}`,
		"",
		"Runtime",
		`Chat mode: ${resolveClankyChatMode(env)}`,
		`Gateway owner: ${resolveClankyChatGatewayOwner(env)}`,
		`MCP servers: ${Object.keys(profileMcp.servers).length} profile-local`,
		`AgentRoom: ${agentRoomSetupLabel(env, roomConfig !== undefined)}`,
		`Room config: ${roomConfig?.configPath ?? "not detected"}`,
		`Work tracker: ${env.CLANKY_WORK_TRACKER ?? "profile/default"} (${env.CLANKY_WORK_TRACKER_PROVIDER_KIND ?? "unknown"})`,
	];
	const nextSteps = formatStatusNextSteps(
		openAiStatus.available,
		hasDiscordCredential(deps),
		voiceSettings?.enabled === true,
	);
	if (nextSteps.length > 0) lines.push("", "Next steps", ...nextSteps);
	return lines.join("\n");
}

function formatStatusNextSteps(openAiAvailable: boolean, discordAvailable: boolean, voiceEnabled: boolean): string[] {
	const lines: string[] = [];
	if (!openAiAvailable) lines.push("- Run /setup to configure OpenAI.");
	if (!discordAvailable) lines.push("- Run /discord-login to configure Discord text access.");
	if (!voiceEnabled) lines.push("- Run /discord-voice setup to enable Discord voice.");
	return lines;
}

function discordCredentialLabel(
	envToken: string | undefined,
	storedDiscord: ReturnType<typeof loadStoredDiscordCredential>,
): string {
	if (envToken !== undefined && envToken.length > 0) return "env CLANKY_DISCORD_TOKEN";
	if (storedDiscord === undefined) return "missing";
	const identity = storedDiscord.payload.identity;
	const identityLabel = identity === undefined ? "" : ` as ${identity.username}`;
	return `stored ${storedDiscord.payload.credentialKind}${identityLabel}`;
}

function hasDiscordCredential(deps: ClankySetupWizardDeps): boolean {
	const envToken = setupEnv(deps).CLANKY_DISCORD_TOKEN?.trim();
	return (
		(envToken !== undefined && envToken.length > 0) ||
		loadStoredDiscordCredential(deps.authStorage, deps.discordProviderId) !== undefined
	);
}

function formatVoiceDashboardStatus(status: unknown): string {
	const state = interpretVoiceStatus(status);
	switch (state.kind) {
		case "unavailable":
			return "unavailable";
		case "error":
			return `error (${state.message})`;
		case "ready":
			return "ready";
		case "live":
			return state.channelId === undefined ? "active" : `active in channel ${state.channelId}`;
		case "client-live":
			return "client active";
		case "inactive":
			return "inactive";
	}
}

function formatStatusActive(active: boolean | undefined): string {
	if (active === undefined) return "unknown";
	return active ? "active" : "inactive";
}

function formatMcpSetupStatus(deps: ClankySetupWizardDeps): string {
	const profile = readProfileMcpServers(deps.paths);
	const entries = Object.entries(profile.servers);
	const lines = [
		"Clanky MCP setup",
		`Profile config: ${profile.path}`,
		`Profile-local servers: ${entries.length}`,
		"",
		"Commands:",
		"  /setup mcp <id> <url>",
		"  /setup mcp <id> stdio <command> [args...]",
		"  /setup mcp remove <id>",
		"",
		"Configured servers",
	];
	if (entries.length === 0) {
		lines.push("- none");
	} else {
		for (const [id, server] of entries) {
			const target = server.url ?? [server.command, ...(server.args ?? [])].filter(Boolean).join(" ");
			lines.push(
				`- ${id}: ${server.type ?? "stdio"}${server.disabled === true ? " (disabled)" : ""}${target ? ` - ${target}` : ""}`,
			);
		}
	}
	return lines.join("\n");
}

function configureMcpFromArgs(deps: ClankySetupWizardDeps, args: string): string {
	const patch = parseMcpSetupArgs(args);
	if (typeof patch === "string") return patch;
	if ("remove" in patch) {
		const result = removeProfileMcpServer(deps.paths, patch.remove);
		return [`Clanky MCP setup`, `Removed ${patch.remove} from ${result.path}.`].join("\n");
	}
	const result = upsertProfileMcpServer(deps.paths, patch.id, patch.config);
	return [`Clanky MCP setup`, `Saved ${patch.id} to ${result.path}.`].join("\n");
}

function parseMcpSetupArgs(args: string): { id: string; config: ClankyMcpServerConfig } | { remove: string } | string {
	const parts = args.split(/\s+/).filter((part) => part.length > 0);
	const first = parts.shift();
	if (first === undefined) return "Usage: /setup mcp <id> <url> | /setup mcp <id> stdio <command> [args...]";
	if (first === "remove" || first === "delete") {
		const id = parts.shift();
		return id === undefined ? "Usage: /setup mcp remove <id>" : { remove: id };
	}
	const transport = parseMcpTransportArg(parts[0]);
	if (transport !== undefined) parts.shift();
	const target = parts.shift();
	if (target === undefined) return "MCP server target is required.";
	const type = transport ?? (isMcpUrl(target) ? "streamable-http" : "stdio");
	if (type === "stdio") {
		return {
			id: first,
			config: {
				type,
				command: target,
				...(parts.length > 0 ? { args: parts } : {}),
			},
		};
	}
	if (!isMcpUrl(target)) return "HTTP/SSE MCP servers require an http(s) URL.";
	return { id: first, config: { type, url: target } };
}

function parseMcpTransportArg(value: string | undefined): "stdio" | "streamable-http" | "sse" | undefined {
	if (value === "stdio") return "stdio";
	if (value === "http" || value === "streamable-http") return "streamable-http";
	if (value === "sse") return "sse";
	return undefined;
}

function isMcpUrl(value: string): boolean {
	return value.startsWith("http://") || value.startsWith("https://");
}

function formatAgentRoomParticipation(deps: ClankySetupWizardDeps): string {
	const env = setupEnv(deps);
	const roomConfig = maybeLoadAgentRoomPortableConfig(deps.cwd, env);
	const clanky = roomConfig?.clanky;
	const trackerId = roomConfig?.workTracker?.default;
	const tracker = trackerId === undefined ? undefined : roomConfig?.workTracker?.providers[trackerId];
	const lines = [
		"AgentRoom participation",
		`Current mode: ${resolveClankyChatMode(env)}`,
		`Working directory: ${deps.cwd}`,
		`AGENTROOM: ${env.AGENTROOM === "1" ? "1" : "not set"}`,
		`AGENTROOM_AGENT_ID: ${env.AGENTROOM_AGENT_ID ?? "not set"}`,
		`AGENTROOM_ROOM_ID: ${env.AGENTROOM_ROOM_ID ?? "not set"}`,
		`Portable config: ${roomConfig?.configPath ?? env.CLANKY_AGENTROOM_CONFIG ?? "not detected"}`,
		`Work tracker: ${env.CLANKY_WORK_TRACKER ?? "profile/default"}`,
		"",
		"Room defaults",
		`Clanky home: ${clanky?.home ?? clanky?.homeDir ?? "not set"}`,
		`Clanky profile: ${clanky?.profile ?? "not set"}`,
		`Chat owner: ${clanky?.chatGatewayOwner ?? resolveClankyChatGatewayOwner(env)}`,
		`Tracker default: ${trackerId ?? "not set"}${tracker?.type !== undefined ? ` (${tracker.type})` : ""}`,
		`Tracker team: ${tracker?.teamId ?? "not set"}`,
		"",
		"These values only mean Clanky is participating in a room.",
		"They do not transfer Clanky's personal Discord token to AgentRoom.",
		"",
		"Room-level setup is edited in the AgentRoom TUI:",
		"  agent-room",
		"  /setup",
		"  /setup clanky room .clanky-room lead",
		"  /setup tracker linear team_123",
		"",
		"For room-owned Discord, configure the connector in AgentRoom setup.",
		`Current profile remains isolated at ${deps.paths.profileDir}.`,
	];
	return lines.join("\n");
}

function agentRoomSetupLabel(env: NodeJS.ProcessEnv, hasRoomConfig: boolean): string {
	if (isAgentRoomEnrolled(env)) return "participating";
	if (hasRoomConfig) return "room config detected";
	return "not enrolled";
}

function setupEnv(deps: ClankySetupWizardDeps): NodeJS.ProcessEnv {
	return deps.env ?? process.env;
}

function formatFreshUserHelp(deps: ClankySetupWizardDeps): string {
	return [
		"Fresh-user setup test",
		"",
		"From the clanky-pi checkout, run:",
		"pnpm dev:setup:fresh",
		"",
		"That command creates a temporary Clanky home and launches this TUI with an empty profile.",
		"Inside the fresh TUI, run /setup.",
		"",
		`Current profile is unchanged: ${deps.paths.profileDir}`,
	].join("\n");
}

function formatSetupUsage(): string {
	return [
		"Usage: /setup",
		"",
		"Shortcuts:",
		"  /setup status",
		"  /setup mcp",
		"  /setup mcp linear https://mcp.linear.app/mcp",
		"  /setup agentroom",
		"  /setup fresh",
	].join("\n");
}
