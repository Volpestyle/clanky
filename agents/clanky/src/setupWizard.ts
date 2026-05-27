import {
	type ClankyCommandCompletionSpec,
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
	resolveClankyChatGatewayOwner,
	resolveClankyChatMode,
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
	paths: ClankyPaths;
	authStorage: AuthStorage;
	discordProviderId: string;
	gatewayController: ClankyDiscordGatewayController;
	voiceSettings: DiscordVoiceSettingsAccessor;
}

type SetupChoice = "status" | "openai" | "discord" | "voice" | "elevenlabs" | "xai" | "agentroom" | "done";

const SETUP_COMMAND_COMPLETIONS = [
	{ value: "status", description: "Show connector and profile setup status." },
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
	const openAiStatus = getOpenAiCredentialStatus(process.env, deps.authStorage, DEFAULT_OPENAI_PROVIDER_ID);
	const elevenLabsStatus = getElevenLabsCredentialStatus(process.env, deps.authStorage, DEFAULT_ELEVENLABS_PROVIDER_ID);
	const xaiStatus = getXAiCredentialStatus(process.env, deps.authStorage, DEFAULT_XAI_PROVIDER_ID);
	const voiceSettings = deps.voiceSettings.read();
	return [
		"Status",
		`Models / OpenAI [${openAiStatus.available ? "set" : "missing"}]`,
		`Chat / Discord text [${hasDiscordCredential(deps) ? "set" : "missing"}]`,
		`Voice / Discord voice [${voiceSettings?.enabled === true ? "enabled" : "disabled"}]`,
		`Voice / ElevenLabs [${elevenLabsStatus.available ? "set" : "missing"}]`,
		`Media / xAI [${xaiStatus.available ? "set" : "missing"}]`,
		`AgentRoom [${isAgentRoomEnrolled(process.env) ? "participating" : "not enrolled"}]`,
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
	if (choice.startsWith("AgentRoom")) return "agentroom";
	return "done";
}

function formatClankySetupStatus(deps: ClankySetupWizardDeps): string {
	const openAiStatus = getOpenAiCredentialStatus(process.env, deps.authStorage, DEFAULT_OPENAI_PROVIDER_ID);
	const elevenLabsStatus = getElevenLabsCredentialStatus(process.env, deps.authStorage, DEFAULT_ELEVENLABS_PROVIDER_ID);
	const xaiStatus = getXAiCredentialStatus(process.env, deps.authStorage, DEFAULT_XAI_PROVIDER_ID);
	const storedDiscord = loadStoredDiscordCredential(deps.authStorage, deps.discordProviderId);
	const envDiscord = process.env.CLANKY_DISCORD_TOKEN?.trim();
	const voiceSettings = deps.voiceSettings.read();
	const lines = [
		"Clanky setup",
		`Profile: ${deps.paths.profile}`,
		`Home: ${deps.paths.homeDir}`,
		`Profile dir: ${deps.paths.profileDir}`,
		"",
		`OpenAI: ${openAiStatus.available ? (openAiStatus.activeSource ?? "configured") : "missing"}`,
		`Discord text: ${discordCredentialLabel(envDiscord, storedDiscord)}`,
		`Discord owner: ${resolveClankyChatGatewayOwner(process.env)} (${resolveClankyChatMode(process.env)})`,
		`Discord voice: ${voiceSettings?.enabled === true ? "enabled" : "disabled"}`,
		`ElevenLabs: ${elevenLabsStatus.available ? (elevenLabsStatus.activeSource ?? "configured") : "missing"}`,
		`xAI media: ${xaiStatus.available ? (xaiStatus.activeSource ?? "configured") : "missing"}`,
		`AgentRoom: ${isAgentRoomEnrolled(process.env) ? "participating" : "not enrolled"}`,
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
	const openAiStatus = getOpenAiCredentialStatus(process.env, deps.authStorage, DEFAULT_OPENAI_PROVIDER_ID);
	const elevenLabsStatus = getElevenLabsCredentialStatus(process.env, deps.authStorage, DEFAULT_ELEVENLABS_PROVIDER_ID);
	const xaiStatus = getXAiCredentialStatus(process.env, deps.authStorage, DEFAULT_XAI_PROVIDER_ID);
	const storedDiscord = loadStoredDiscordCredential(deps.authStorage, deps.discordProviderId);
	const envDiscord = process.env.CLANKY_DISCORD_TOKEN?.trim();
	const voiceSettings = deps.voiceSettings.read();
	const bridge = deps.gatewayController.status();
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
		`Chat mode: ${resolveClankyChatMode(process.env)}`,
		`Gateway owner: ${resolveClankyChatGatewayOwner(process.env)}`,
		`AgentRoom: ${isAgentRoomEnrolled(process.env) ? "participating" : "not enrolled"}`,
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
	const envToken = process.env.CLANKY_DISCORD_TOKEN?.trim();
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

function formatAgentRoomParticipation(deps: ClankySetupWizardDeps): string {
	const lines = [
		"AgentRoom participation",
		`Current mode: ${resolveClankyChatMode(process.env)}`,
		`AGENTROOM: ${process.env.AGENTROOM === "1" ? "1" : "not set"}`,
		`AGENTROOM_AGENT_ID: ${process.env.AGENTROOM_AGENT_ID ?? "not set"}`,
		`AGENTROOM_ROOM_ID: ${process.env.AGENTROOM_ROOM_ID ?? "not set"}`,
		"",
		"These values only mean Clanky is participating in a room.",
		"They do not transfer Clanky's personal Discord token to AgentRoom.",
		"",
		"To suppress Clanky's agent-owned gateway from an AgentRoom launcher, set:",
		"CLANKY_CHAT_GATEWAY_OWNER=room",
		"",
		"For room-owned Discord, configure the connector in AgentRoom's setup wizard instead.",
		`Current profile remains isolated at ${deps.paths.profileDir}.`,
	];
	return lines.join("\n");
}

function formatFreshUserHelp(deps: ClankySetupWizardDeps): string {
	return [
		"Fresh-user setup test",
		"",
		"From /Users/jamesvolpe/dev/clanky-pi, run:",
		"pnpm dev:setup:fresh",
		"",
		"That command creates a temporary Clanky home and launches this TUI with an empty profile.",
		"Inside the fresh TUI, run /setup.",
		"",
		`Current profile is unchanged: ${deps.paths.profileDir}`,
	].join("\n");
}

function formatSetupUsage(): string {
	return ["Usage: /setup", "", "Shortcuts:", "  /setup status"].join("\n");
}
