/**
 * Interactive Discord auth flow for Clanky.
 *
 * Pi's built-in `/login` menu is hard-coded to model providers and has no
 * registration hook for non-model credentials, so we expose the Discord
 * setup via custom slash commands instead: `/discord-login`,
 * `/discord-logout`, `/discord-whoami`.
 *
 * Tokens are persisted in the profile `AuthStorage` (same `auth.json`,
 * `0600` perms) under provider id `clanky-discord` by default. See
 * `@clanky/core` discord-credentials helpers for the on-disk shape.
 *
 * Token validation hits Discord's REST API directly (`GET /users/@me`)
 * so we do not pull in discord.js just for login. The chat gateway itself
 * still goes through `@agentroom/chat-discord`.
 */
import {
	type ClankyCommandCompletionSpec,
	type ClankyDiscordCredentialKind,
	type ClankyDiscordCredentialPayload,
	completeClankyCommandArgument,
	DEFAULT_CLANKY_DISCORD_PROVIDER_ID,
	DEFAULT_ELEVENLABS_PROVIDER_ID,
	getElevenLabsCredentialStatus,
	loadStoredDiscordCredential,
	removeStoredDiscordCredential,
	saveStoredDiscordCredential,
} from "@clanky/core";
import type { AuthStorage, ExtensionCommandContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { DEFAULT_XAI_REALTIME_MODEL } from "./agentDiscordVoice.ts";
import type { ClankyDiscordGatewayController, DiscordVoiceStartProgress } from "./discordGatewayController.ts";
import type {
	DiscordVoiceRealtimeAgentProvider,
	DiscordVoiceSettingsAccessor,
	DiscordVoiceTtsProvider,
	StoredDiscordVoiceSettings,
} from "./discordVoiceSettings.ts";
import { runElevenLabsLogin } from "./elevenLabsAuth.ts";
import { promptForSecret } from "./secretPrompt.ts";
import {
	DEFAULT_ELEVENLABS_OUTPUT_FORMAT,
	type ElevenLabsPcmOutputFormat,
	parseElevenLabsPcmOutputFormat,
} from "./voice/elevenLabsTtsClient.ts";

const DEV_PORTAL_URL = "https://discord.com/developers/applications";
const DISCORD_API_BASE = "https://discord.com/api/v10";
const ELEVENLABS_OUTPUT_FORMAT_OPTIONS: ElevenLabsPcmOutputFormat[] = [
	"pcm_16000",
	"pcm_22050",
	"pcm_24000",
	"pcm_44100",
];
const DISCORD_VOICE_LOADING_UI_KEY = "clanky-discord-voice-loading";
const DISCORD_VOICE_LOADING_FRAMES = ["-", "\\", "|", "/"];
const DISCORD_VOICE_COMMAND_COMPLETIONS = [
	{ value: "setup", description: "Open the Discord voice setup UI.", aliases: ["configure", "ui"] },
	{ value: "status", description: "Show stored voice settings and live bridge status." },
	{ value: "enable", description: "Enable dynamic Discord voice access without pinning a channel." },
	{
		value: "enable ",
		label: "enable <guild-id> <voice-channel-id>",
		description: "Enable voice and pin a Discord voice channel target.",
	},
	{
		value: "join ",
		label: "join <guild-id> <voice-channel-id>",
		description: "Pin and join a Discord voice channel.",
		aliases: ["target "],
	},
	{
		value: "allow-server ",
		label: "allow-server <guild-id> [...]",
		description: "Allow Discord voice joins for specific servers.",
		aliases: ["allow-servers ", "server ", "servers ", "guild ", "guilds "],
	},
	{
		value: "allow-server all",
		description: "Clear the server allowlist so all accessible servers are allowed.",
		aliases: ["allow-server clear", "allow-server none"],
	},
	{
		value: "allow-channel ",
		label: "allow-channel <voice-channel-id> [...]",
		description: "Allow Discord voice joins for specific channels.",
		aliases: ["allow-channels ", "allow ", "allowlist "],
	},
	{
		value: "allow-channel all",
		description: "Clear the channel allowlist so all accessible voice channels are allowed.",
		aliases: ["allow-channel clear", "allow-channel none", "allow all"],
	},
	{ value: "set guild ", label: "set guild <guild-id>", description: "Store the pinned Discord guild id." },
	{
		value: "set channel ",
		label: "set channel <voice-channel-id>",
		description: "Store the pinned Discord voice channel id.",
	},
	{
		value: "set allowed-servers ",
		label: "set allowed-servers <guild-id> [...]",
		description: "Replace the server allowlist.",
		aliases: ["set allowed-guilds ", "set servers ", "set guilds "],
	},
	{
		value: "set allowed-servers clear",
		description: "Clear the server allowlist.",
		aliases: ["set allowed-servers all", "set allowed-servers none"],
	},
	{
		value: "set allowed-channels ",
		label: "set allowed-channels <voice-channel-id> [...]",
		description: "Replace the voice channel allowlist.",
		aliases: ["set allowed ", "set allowlist ", "set channels "],
	},
	{
		value: "set allowed-channels clear",
		description: "Clear the voice channel allowlist.",
		aliases: ["set allowed-channels all", "set allowed-channels none"],
	},
	{
		value: "set model ",
		label: "set model <openai-realtime-model>",
		description: "Override the OpenAI Realtime agent model for Discord voice.",
	},
	{
		value: "set realtime-provider xai",
		description: "Use xAI Grok Voice as the realtime reasoning/tool agent.",
		aliases: ["set realtime-agent-provider xai"],
	},
	{
		value: "set realtime-provider openai",
		description: "Use OpenAI Realtime as the realtime reasoning/tool agent.",
		aliases: ["set realtime-agent-provider openai"],
	},
	{
		value: "set realtime-provider default",
		description: "Clear the realtime agent provider override.",
		aliases: [
			"set realtime-provider clear",
			"set realtime-agent-provider default",
			"set realtime-agent-provider clear",
		],
	},
	{
		value: "set voice ",
		label: "set voice <openai-realtime-voice>",
		description: "Override the OpenAI Realtime output voice.",
	},
	{
		value: "set xai-model grok-voice-latest",
		description: "Use the default xAI Grok Voice realtime model.",
	},
	{
		value: "set xai-model ",
		label: "set xai-model <model-id>",
		description: "Override the xAI Grok Voice realtime model.",
	},
	{
		value: "set xai-model default",
		description: "Clear the xAI Grok Voice realtime model override.",
		aliases: ["set xai-model clear"],
	},
	{
		value: "set xai-voice ",
		label: "set xai-voice <voice-id>",
		description: "Override the xAI Grok Voice output voice.",
	},
	{
		value: "set xai-voice default",
		description: "Clear the xAI Grok Voice output voice override.",
		aliases: ["set xai-voice clear"],
	},
	{ value: "set tts-provider elevenlabs", description: "Use ElevenLabs speech for Discord voice output." },
	{ value: "set tts-provider openai", description: "Use selected realtime agent audio for Discord voice output." },
	{
		value: "set tts-provider default",
		description: "Clear the speech output provider override.",
		aliases: ["set tts-provider clear"],
	},
	{
		value: "set elevenlabs-voice ",
		label: "set elevenlabs-voice <voice-id>",
		description: "Store the ElevenLabs voice id used for speech.",
		aliases: ["set elevenlabs-voice-id "],
	},
	{
		value: "set elevenlabs-voice clear",
		description: "Clear the stored ElevenLabs voice id.",
		aliases: ["set elevenlabs-voice default"],
	},
	{
		value: "set elevenlabs-model eleven_flash_v2_5",
		description: "Use the default low-latency ElevenLabs speech model.",
	},
	{
		value: "set elevenlabs-model ",
		label: "set elevenlabs-model <model-id>",
		description: "Override the ElevenLabs speech model.",
	},
	{
		value: "set elevenlabs-model default",
		description: "Clear the ElevenLabs model override.",
		aliases: ["set elevenlabs-model clear"],
	},
	...ELEVENLABS_OUTPUT_FORMAT_OPTIONS.map((format) => ({
		value: `set elevenlabs-output-format ${format}`,
		description: "Set the ElevenLabs PCM output format.",
	})),
	{
		value: "set elevenlabs-output-format default",
		description: "Clear the ElevenLabs output format override.",
		aliases: ["set elevenlabs-output-format clear"],
	},
	{
		value: "set elevenlabs-base-url ",
		label: "set elevenlabs-base-url <url>",
		description: "Override the ElevenLabs API base URL.",
		aliases: ["set elevenlabs-url "],
	},
	{
		value: "set elevenlabs-base-url default",
		description: "Clear the ElevenLabs base URL override.",
		aliases: ["set elevenlabs-base-url clear"],
	},
	{ value: "set reasoning minimal", description: "Set OpenAI Realtime agent reasoning effort to minimal." },
	{ value: "set reasoning low", description: "Set OpenAI Realtime agent reasoning effort to low." },
	{ value: "set reasoning medium", description: "Set OpenAI Realtime agent reasoning effort to medium." },
	{ value: "set reasoning high", description: "Set OpenAI Realtime agent reasoning effort to high." },
	{ value: "set reasoning xhigh", description: "Set OpenAI Realtime agent reasoning effort to xhigh." },
	{
		value: "set reasoning default",
		description: "Clear the OpenAI Realtime agent reasoning effort override.",
		aliases: ["set reasoning clear"],
	},
	{
		value: "set frame-interval ",
		label: "set frame-interval <milliseconds>",
		description: "Set the screen-share frame auto-attach interval.",
		aliases: ["set frame_interval "],
	},
	{
		value: "set eagerness ",
		label: "set eagerness <0-100>",
		description: "Set how often Clanky should choose to speak in Discord voice.",
		aliases: ["set participation-eagerness ", "set participation "],
	},
	{
		value: "set eagerness default",
		description: "Clear the Discord voice participation eagerness override.",
		aliases: ["set eagerness clear", "set participation-eagerness default", "set participation-eagerness clear"],
	},
	{ value: "clear", description: "Clear all stored Discord voice settings." },
	{ value: "disable", description: "Disable Discord voice access." },
] satisfies readonly ClankyCommandCompletionSpec[];

interface DiscordIdentity {
	id: string;
	username: string;
	discriminator?: string;
	bot: boolean;
}

interface DiscordValidationSuccess {
	ok: true;
	credentialKind: ClankyDiscordCredentialKind;
	identity: DiscordIdentity;
}

interface DiscordValidationAttempt {
	credentialKind: ClankyDiscordCredentialKind;
	status: number;
	message: string;
}

interface DiscordValidationFailure {
	ok: false;
	attempts: DiscordValidationAttempt[];
	message: string;
}

type DiscordValidationResult = DiscordValidationSuccess | DiscordValidationFailure;

const VALIDATION_USER_AGENT = "Clanky (clanky-pi, validate)";

/**
 * Hit `GET /users/@me` and infer the credential kind by trying bot mode
 * first, then user (selfbot) mode. Returns the inferred kind alongside
 * the identity so the caller can persist the right `credentialKind`.
 *
 * Bot tokens use `Authorization: Bot <token>`; user tokens use the raw
 * token. Both shapes look identical to the eye, so asking the user to
 * pick upfront is a trap (a wrong pick yields a 401 that doesn't say so).
 */
export async function validateDiscordToken(token: string): Promise<DiscordValidationResult> {
	const attempts: DiscordValidationAttempt[] = [];
	for (const credentialKind of ["bot-token", "user-token"] as const) {
		const authorization = credentialKind === "bot-token" ? `Bot ${token}` : token;
		let response: Response;
		try {
			response = await fetch(`${DISCORD_API_BASE}/users/@me`, {
				method: "GET",
				headers: {
					Authorization: authorization,
					"User-Agent": VALIDATION_USER_AGENT,
				},
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				ok: false,
				attempts: [...attempts, { credentialKind, status: 0, message: `Network error: ${message}` }],
				message: `Network error contacting Discord: ${message}`,
			};
		}

		if (!response.ok) {
			const bodyText = await response.text().catch(() => "");
			attempts.push({
				credentialKind,
				status: response.status,
				message: `${response.status} ${response.statusText}${bodyText ? `: ${bodyText.slice(0, 200)}` : ""}`,
			});
			continue;
		}

		const json = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
		if (json === undefined) {
			attempts.push({
				credentialKind,
				status: response.status,
				message: "Unparseable response body.",
			});
			continue;
		}

		const id = json.id;
		const username = json.username;
		if (typeof id !== "string" || typeof username !== "string") {
			attempts.push({
				credentialKind,
				status: response.status,
				message: "Response missing id or username.",
			});
			continue;
		}

		const identity: DiscordIdentity = {
			id,
			username,
			bot: json.bot === true,
		};
		if (typeof json.discriminator === "string" && json.discriminator !== "0") {
			identity.discriminator = json.discriminator;
		}
		return { ok: true, credentialKind, identity };
	}

	const summary = attempts.map((attempt) => `${attempt.credentialKind} → ${attempt.message}`).join("; ");
	return {
		ok: false,
		attempts,
		message: `Discord rejected the token in both bot-token and user-token modes. ${summary}`,
	};
}

function formatIdentity(identity: DiscordIdentity): string {
	const handle =
		identity.discriminator !== undefined ? `${identity.username}#${identity.discriminator}` : identity.username;
	const kind = identity.bot ? "bot" : "user";
	return `${handle} (${kind}, id ${identity.id})`;
}

/**
 * State shared across the three Discord slash commands. Captured by the
 * extension factory so each handler can read/write the same AuthStorage,
 * and so `/discord-login` can hot-restart the running Discord bridge
 * (via `gatewayController`) without restarting the Clanky process.
 */
export interface DiscordAuthCommandDeps {
	authStorage: AuthStorage;
	providerId: string;
	authFilePath: string;
	gatewayController?: ClankyDiscordGatewayController;
	voiceSettings?: DiscordVoiceSettingsAccessor;
}

function loginInstructions(): string {
	return [
		"Paste your Discord token at the prompt — Clanky auto-detects bot vs user token.",
		"",
		"Bot token (recommended):",
		`  1. Open ${DEV_PORTAL_URL}`,
		"  2. Create (or open) an application; under Bot, click Reset Token.",
		"  3. Copy the token; invite the bot to your server with Send Messages",
		"     permission and enable Message Content Intent in the portal.",
		"",
		"User token (selfbot — against Discord's TOS, account bans possible):",
		"  1. Open Discord in a browser, log in, then open DevTools.",
		"  2. Network tab → find any XHR → copy the Authorization header value.",
		"  3. Use a burner account.",
	].join("\n");
}

export async function runDiscordLogin(deps: DiscordAuthCommandDeps, ctx: ExtensionCommandContext): Promise<void> {
	const { ui } = ctx;

	ui.notify(loginInstructions());

	const token = (
		await promptForSecret(ui, {
			title: "Paste Discord token (bot or user):",
			subtitle: "(input is masked; credential kind is auto-detected)",
		})
	)?.trim();

	if (token === undefined || token.length === 0) {
		ui.notify("Discord login cancelled (no token entered).");
		return;
	}

	ui.notify("Validating token against Discord REST API (trying bot-token, then user-token)...");
	const validation = await validateDiscordToken(token);
	if (!validation.ok) {
		ui.notify(`Discord login failed: ${validation.message}`, "error");
		return;
	}

	const credentialKind = validation.credentialKind;
	if (credentialKind === "user-token") {
		ui.notify(
			"Detected as USER token (selfbot path). Discord ToS prohibits selfbots; account bans are possible. Burner accounts only.",
		);
	}

	const includeConversation = await ui.confirm(
		"Bind to a specific Discord conversation?",
		"Optional. Pick yes to restrict Clanky to one DM/channel/thread id. Pick no to accept DMs + mentions.",
	);
	let conversationId: string | undefined;
	if (includeConversation) {
		const value = (
			await ui.input("Discord conversation id (channel/thread/DM):", "leave blank to cancel binding")
		)?.trim();
		if (value !== undefined && value.length > 0) conversationId = value;
	}

	const payload: ClankyDiscordCredentialPayload = {
		token,
		credentialKind,
		identity: {
			id: validation.identity.id,
			username: validation.identity.username,
		},
	};
	if (conversationId !== undefined) payload.conversationId = conversationId;

	saveStoredDiscordCredential(deps.authStorage, payload, deps.providerId);

	const summaryLines = [
		`Logged in to Discord as ${formatIdentity(validation.identity)} (kind: ${credentialKind}).`,
		`Credentials saved to ${deps.authFilePath} (provider id "${deps.providerId}", perms 0600).`,
		conversationId !== undefined ? `Bound to conversation id ${conversationId}.` : "Accepting DMs and mentions.",
	];

	if (deps.gatewayController !== undefined) {
		try {
			await deps.gatewayController.restart();
			summaryLines.push("Discord bridge restarted with the new token.");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			summaryLines.push(`Failed to restart Discord bridge: ${message}. Restart Clanky to recover.`);
		}
	} else {
		summaryLines.push("Restart Clanky to start the agent-owned Discord gateway with the new token.");
	}

	summaryLines.push("Reloading session to refresh persona...");
	ui.notify(summaryLines.join("\n"));

	// ctx is stale after reload — do this last and do not touch ctx again.
	await ctx.reload();
}

async function runDiscordLogout(deps: DiscordAuthCommandDeps, ctx: ExtensionCommandContext): Promise<void> {
	const existing = loadStoredDiscordCredential(deps.authStorage, deps.providerId);
	if (existing === undefined) {
		ctx.ui.notify(`No stored Discord credentials under provider "${deps.providerId}".`);
		return;
	}
	const identity = existing.payload.identity;
	const removed = removeStoredDiscordCredential(deps.authStorage, deps.providerId);
	if (!removed) {
		ctx.ui.notify("Discord logout: nothing to remove.");
		return;
	}
	const who = identity !== undefined ? `${identity.username} (id ${identity.id})` : "stored Discord credentials";
	const lines = [
		`Removed ${who} from ${deps.authFilePath}.`,
		"Environment variable CLANKY_DISCORD_TOKEN, if set, is unchanged and still takes precedence on next launch.",
	];
	if (deps.gatewayController !== undefined) {
		try {
			await deps.gatewayController.restart();
			lines.push("Discord bridge restarted after logout.");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			lines.push(`Failed to restart Discord bridge after logout: ${message}. Restart Clanky to recover.`);
		}
	}
	ctx.ui.notify(lines.join("\n"));
}

function runDiscordWhoami(deps: DiscordAuthCommandDeps, ctx: ExtensionCommandContext): void {
	const envToken = process.env.CLANKY_DISCORD_TOKEN?.trim();
	const stored = loadStoredDiscordCredential(deps.authStorage, deps.providerId);
	const lines: string[] = [];
	if (envToken !== undefined && envToken.length > 0) {
		lines.push("CLANKY_DISCORD_TOKEN env var is set (takes precedence over stored credentials).");
	}
	if (stored === undefined) {
		lines.push(`No Discord credentials stored under provider "${deps.providerId}".`);
	} else {
		const identity = stored.payload.identity;
		lines.push(`Stored credential kind: ${stored.payload.credentialKind}.`);
		if (identity !== undefined) lines.push(`Stored identity: ${identity.username} (id ${identity.id}).`);
		if (stored.payload.conversationId !== undefined) {
			lines.push(`Bound conversation id: ${stored.payload.conversationId}.`);
		} else {
			lines.push("No conversation binding (DMs + mentions accepted).");
		}
		lines.push(`Stored in ${deps.authFilePath} (provider id "${deps.providerId}").`);
	}
	if (envToken === undefined && stored === undefined) {
		lines.push("Run /discord-login to configure interactively.");
	}
	ctx.ui.notify(lines.join("\n"));
}

function formatDiscordBridgeStatus(status: unknown): string {
	if (!isRecord(status)) return "Discord bridge status is unavailable.";
	const textBridgeActive = status.textBridgeActive === true;
	const voiceBridgeActive = status.voiceBridgeActive === true;
	const voiceOnlyClientActive = status.voiceOnlyClientActive === true;
	const lines = [
		`Text bridge: ${textBridgeActive ? "active" : "inactive"}.`,
		`Voice bridge: ${voiceBridgeActive ? "active" : "inactive"}.`,
		`Voice-only client: ${voiceOnlyClientActive ? "active" : "inactive"}.`,
	];
	if (typeof status.voiceConfigError === "string" && status.voiceConfigError.length > 0) {
		lines.push(`Voice config error: ${status.voiceConfigError}`);
	}
	const voice = isRecord(status.voice) ? status.voice : undefined;
	if (voice !== undefined) {
		if (voice.active === false && voice.mode === "dynamic") {
			lines.push("Voice access: enabled; no voice channel is joined.");
		}
		if (typeof voice.guildId === "string" && typeof voice.channelId === "string") {
			lines.push(`Voice target: guild ${voice.guildId}, channel ${voice.channelId}.`);
		}
		const allowedGuildIds = readStringArray(voice.allowedGuildIds);
		if (allowedGuildIds.length > 0) {
			lines.push(`Allowed servers: ${allowedGuildIds.join(", ")}.`);
		} else if (voice.mode === "dynamic") {
			lines.push("Allowed servers: all servers the Discord credential can access.");
		}
		const allowedChannelIds = readStringArray(voice.allowedChannelIds);
		if (allowedChannelIds.length > 0) {
			lines.push(`Allowed voice channels: ${allowedChannelIds.join(", ")}.`);
		} else if (voice.mode === "dynamic") {
			lines.push("Allowed voice channels: all channels the Discord credential can access.");
		}
		const realtimeAgentProvider = readStatusString(voice, "realtimeAgentProvider") ?? "openai";
		const realtimeAgentModel = readStatusString(voice, "realtimeAgentModel") ?? readStatusString(voice, "model");
		const speechOutputProvider =
			readStatusString(voice, "speechOutputProvider") ?? readStatusString(voice, "ttsProvider") ?? "openai";
		lines.push(`Realtime agent provider: ${formatRealtimeAgentProviderLabel(realtimeAgentProvider)}.`);
		if (realtimeAgentModel !== undefined) lines.push(`Realtime agent model: ${realtimeAgentModel}.`);
		if (typeof voice.reasoningEffort === "string") {
			lines.push(`Realtime agent reasoning effort: ${voice.reasoningEffort}.`);
		}
		if (typeof voice.participationEagerness === "number") {
			lines.push(`Voice participation eagerness: ${voice.participationEagerness}/100.`);
		}
		lines.push(
			`Speech output provider: ${formatSpeechOutputProviderLabel(speechOutputProvider, realtimeAgentProvider)}.`,
		);
		const realtimeAgentVoice = readStatusString(voice, "realtimeAgentVoice") ?? readStatusString(voice, "voice");
		if (speechOutputProvider !== "elevenlabs" && realtimeAgentVoice !== undefined) {
			lines.push(`${formatRealtimeAgentProviderLabel(realtimeAgentProvider)} speech voice: ${realtimeAgentVoice}.`);
		}
		if (typeof voice.elevenLabsVoiceId === "string") lines.push(`ElevenLabs voice id: ${voice.elevenLabsVoiceId}.`);
		if (typeof voice.elevenLabsModel === "string") lines.push(`ElevenLabs model: ${voice.elevenLabsModel}.`);
		if (typeof voice.elevenLabsOutputFormat === "string")
			lines.push(`ElevenLabs output format: ${voice.elevenLabsOutputFormat}.`);
		if (typeof voice.elevenLabsBaseUrl === "string") lines.push(`ElevenLabs base URL: ${voice.elevenLabsBaseUrl}.`);
		if (typeof voice.discordCredentialKind === "string") {
			lines.push(`Discord credential kind: ${voice.discordCredentialKind}.`);
		}
		if (typeof voice.nativeScreenWatchSupported === "boolean") {
			lines.push(`Native screen watch: ${voice.nativeScreenWatchSupported ? "supported" : "requires user-token"}.`);
		}
		if (typeof voice.nativeStreamPublishSupported === "boolean") {
			lines.push(`Native stream publish: ${voice.nativeStreamPublishSupported ? "supported" : "requires user-token"}.`);
		}
		if (typeof voice.discoveredStreams === "number")
			lines.push(`Discovered screen shares: ${voice.discoveredStreams}.`);
		if (voice.activeStreamWatchKey !== undefined) {
			lines.push(`Active screen watch: ${String(voice.activeStreamWatchKey)}.`);
		}
		const media = isRecord(voice.media) ? voice.media : undefined;
		if (media !== undefined) {
			const music = isRecord(media.music) ? media.music : undefined;
			const streamPublish = isRecord(media.streamPublish) ? media.streamPublish : undefined;
			if (music !== undefined && typeof music.status === "string") {
				lines.push(`Voice music: ${music.status}${typeof music.url === "string" ? ` (${music.url})` : ""}.`);
			}
			if (streamPublish !== undefined && typeof streamPublish.status === "string") {
				lines.push(
					`Go Live publish: ${streamPublish.status}${streamPublish.streamKey ? ` (${String(streamPublish.streamKey)})` : ""}.`,
				);
			}
		}
		const stats = isRecord(voice.stats) ? voice.stats : undefined;
		if (stats !== undefined) {
			const inputAudio = typeof stats.discordInputAudioEventCount === "number" ? stats.discordInputAudioEventCount : 0;
			const uniqueSpeakers =
				typeof stats.discordInputUniqueSpeakerCount === "number" ? stats.discordInputUniqueSpeakerCount : 0;
			const maxConcurrentSpeakers =
				typeof stats.discordInputMaxConcurrentSpeakers === "number" ? stats.discordInputMaxConcurrentSpeakers : 0;
			const outputAudio = typeof stats.realtimeAudioDeltaCount === "number" ? stats.realtimeAudioDeltaCount : 0;
			const toolCalls = typeof stats.realtimeFunctionCallCount === "number" ? stats.realtimeFunctionCallCount : 0;
			const frames = typeof stats.decodedVideoFrameCount === "number" ? stats.decodedVideoFrameCount : 0;
			const transcripts = typeof stats.realtimeTranscriptCount === "number" ? stats.realtimeTranscriptCount : 0;
			const realtimeErrors = typeof stats.realtimeErrorEventCount === "number" ? stats.realtimeErrorEventCount : 0;
			const socketErrors = typeof stats.realtimeSocketErrorCount === "number" ? stats.realtimeSocketErrorCount : 0;
			const socketCloses = typeof stats.realtimeSocketCloseCount === "number" ? stats.realtimeSocketCloseCount : 0;
			lines.push(
				`Voice stats: input audio ${inputAudio}, output audio ${outputAudio}, realtime tool calls ${toolCalls}, decoded frames ${frames}.`,
			);
			lines.push(`Voice speakers: unique ${uniqueSpeakers}, max concurrent ${maxConcurrentSpeakers}.`);
			lines.push(
				`Realtime status: transcripts ${transcripts}, API errors ${realtimeErrors}, socket errors ${socketErrors}, socket closes ${socketCloses}.`,
			);
		}
	}
	return lines.join("\n");
}

function runDiscordStatus(deps: DiscordAuthCommandDeps, ctx: ExtensionCommandContext): void {
	if (deps.gatewayController === undefined) {
		ctx.ui.notify("Discord bridge controller is not available in this session.");
		return;
	}
	ctx.ui.notify(formatDiscordBridgeStatus(deps.gatewayController.status()));
}

function discordVoiceUsage(path: string | undefined): string {
	const lines = [
		"Discord voice",
		"Run /discord-voice to show status once configured, or open setup when unconfigured.",
		"",
		"Shortcut commands:",
		"  /discord-voice status",
		"  /discord-voice enable",
		"  /discord-voice join <guild-id> <voice-channel-id>",
		"  /discord-voice allow-server <guild-id> [more-guild-ids...]",
		"  /discord-voice allow-channel <voice-channel-id> [more-channel-ids...]",
		"  /discord-voice allow <voice-channel-id> [more-channel-ids...]",
		"  /discord-voice set realtime-provider xai",
		"  /discord-voice set tts-provider elevenlabs",
		"  /discord-voice set xai-model grok-voice-latest",
		"  /discord-voice set elevenlabs-voice <voice-id>",
		"  /discord-voice set elevenlabs-output-format pcm_24000",
		"  /discord-voice set eagerness <0-100>",
		"  /elevenlabs-login",
		"  /discord-voice disable",
	];
	if (path !== undefined) lines.push("", `Profile settings file: ${path}`);
	lines.push("", "Env vars still work and override profile voice settings when present.");
	lines.push(
		"`tts-provider` is only the speech output provider; the realtime reasoning/tool agent is configured separately.",
	);
	return lines.join("\n");
}

function formatDiscordVoiceSettings(settings: StoredDiscordVoiceSettings | undefined, path: string): string[] {
	const lines = [`Profile settings file: ${path}`];
	if (settings === undefined) {
		lines.push("Profile voice setting: not configured.");
		return lines;
	}
	lines.push(`Profile voice setting: ${settings.enabled ? "enabled" : "disabled"}.`);
	if (settings.guildId !== undefined && settings.channelId !== undefined) {
		lines.push(`Pinned voice target: guild ${settings.guildId}, channel ${settings.channelId}.`);
	} else {
		lines.push("Pinned voice target: none.");
	}
	if (settings.allowedGuildIds !== undefined && settings.allowedGuildIds.length > 0) {
		lines.push(`Allowed servers: ${settings.allowedGuildIds.join(", ")}.`);
	} else {
		lines.push("Allowed servers: all servers the Discord credential can access.");
	}
	if (settings.allowedChannelIds !== undefined && settings.allowedChannelIds.length > 0) {
		lines.push(`Allowed voice channels: ${settings.allowedChannelIds.join(", ")}.`);
	} else {
		lines.push("Allowed voice channels: all channels the Discord credential can access.");
	}
	const realtimeAgentProvider = settings.realtimeAgentProvider ?? "openai";
	lines.push(`Realtime agent provider: ${formatRealtimeAgentProviderLabel(realtimeAgentProvider)}.`);
	if (settings.openAiRealtimeModel !== undefined) {
		lines.push(`Stored realtime agent model: ${settings.openAiRealtimeModel}.`);
	}
	if (settings.openAiRealtimeVoice !== undefined) {
		lines.push(`Stored OpenAI speech voice: ${settings.openAiRealtimeVoice}.`);
	}
	if (settings.xAiRealtimeModel !== undefined) {
		lines.push(`Stored xAI Grok Voice model: ${settings.xAiRealtimeModel}.`);
	}
	if (settings.xAiRealtimeVoice !== undefined) {
		lines.push(`Stored xAI Grok Voice output voice: ${settings.xAiRealtimeVoice}.`);
	}
	lines.push(
		`Speech output provider: ${formatSpeechOutputProviderLabel(settings.ttsProvider ?? "openai", realtimeAgentProvider)}.`,
	);
	if (settings.elevenLabsVoiceId !== undefined)
		lines.push(`Stored ElevenLabs voice id: ${settings.elevenLabsVoiceId}.`);
	if (settings.elevenLabsModel !== undefined) lines.push(`Stored ElevenLabs model: ${settings.elevenLabsModel}.`);
	if (settings.elevenLabsOutputFormat !== undefined) {
		lines.push(`Stored ElevenLabs output format: ${settings.elevenLabsOutputFormat}.`);
	}
	if (settings.elevenLabsBaseUrl !== undefined) {
		lines.push(`Stored ElevenLabs base URL: ${settings.elevenLabsBaseUrl}.`);
	}
	if (settings.openAiRealtimeReasoningEffort !== undefined) {
		lines.push(`Stored realtime agent reasoning effort: ${settings.openAiRealtimeReasoningEffort}.`);
	}
	if (settings.participationEagerness !== undefined) {
		lines.push(`Stored voice participation eagerness: ${settings.participationEagerness}/100.`);
	}
	if (settings.videoFrameAutoAttachIntervalMs !== undefined) {
		lines.push(`Stored video frame auto-attach interval: ${settings.videoFrameAutoAttachIntervalMs} ms.`);
	}
	return lines;
}

function formatDiscordVoiceEnvOverrides(): string[] {
	const lines: string[] = [];
	const enabled = process.env.CLANKY_DISCORD_VOICE_ENABLED ?? process.env.CLANKY_DISCORD_VOICE;
	if (cleanArg(enabled) !== undefined) lines.push(`Env voice enable override: ${enabled}.`);
	const guildId = cleanArg(process.env.CLANKY_DISCORD_VOICE_GUILD_ID);
	if (guildId !== undefined) lines.push(`Env guild id override: ${guildId}.`);
	const channelId = cleanArg(process.env.CLANKY_DISCORD_VOICE_CHANNEL_ID);
	if (channelId !== undefined) lines.push(`Env voice channel id override: ${channelId}.`);
	const allowedGuildIds = cleanArg(process.env.CLANKY_DISCORD_VOICE_ALLOWED_GUILD_IDS);
	if (allowedGuildIds !== undefined) lines.push(`Env allowed server override: ${allowedGuildIds}.`);
	const allowedChannelIds = cleanArg(process.env.CLANKY_DISCORD_VOICE_ALLOWED_CHANNEL_IDS);
	if (allowedChannelIds !== undefined) lines.push(`Env allowed voice channel override: ${allowedChannelIds}.`);
	const realtimeAgentProvider = cleanArg(
		process.env.CLANKY_DISCORD_VOICE_REALTIME_AGENT_PROVIDER ?? process.env.CLANKY_VOICE_REALTIME_AGENT_PROVIDER,
	);
	if (realtimeAgentProvider !== undefined) {
		lines.push(`Env realtime agent provider override: ${realtimeAgentProvider}.`);
	}
	const ttsProvider = cleanArg(process.env.CLANKY_DISCORD_VOICE_TTS_PROVIDER ?? process.env.CLANKY_VOICE_TTS_PROVIDER);
	if (ttsProvider !== undefined) lines.push(`Env speech output provider override: ${ttsProvider}.`);
	const model = cleanArg(process.env.CLANKY_OPENAI_REALTIME_MODEL);
	if (model !== undefined) lines.push(`Env OpenAI Realtime agent model override: ${model}.`);
	const voice = cleanArg(process.env.CLANKY_OPENAI_REALTIME_VOICE);
	if (voice !== undefined) lines.push(`Env OpenAI speech voice override: ${voice}.`);
	const xAiModel = cleanArg(process.env.CLANKY_XAI_REALTIME_MODEL ?? process.env.CLANKY_XAI_VOICE_MODEL);
	if (xAiModel !== undefined) lines.push(`Env xAI Grok Voice model override: ${xAiModel}.`);
	const xAiVoice = cleanArg(process.env.CLANKY_XAI_REALTIME_VOICE ?? process.env.CLANKY_XAI_VOICE);
	if (xAiVoice !== undefined) lines.push(`Env xAI Grok Voice output voice override: ${xAiVoice}.`);
	const xAiApiKey = cleanArg(process.env.XAI_API_KEY);
	if (xAiApiKey !== undefined) lines.push("Env xAI API key override is set.");
	const xAiBaseUrl = cleanArg(process.env.CLANKY_XAI_BASE_URL ?? process.env.XAI_BASE_URL);
	if (xAiBaseUrl !== undefined) lines.push(`Env xAI API base URL override: ${xAiBaseUrl}.`);
	const participationEagerness = cleanArg(
		process.env.CLANKY_DISCORD_VOICE_PARTICIPATION_EAGERNESS ?? process.env.CLANKY_DISCORD_VOICE_EAGERNESS,
	);
	if (participationEagerness !== undefined) {
		lines.push(`Env voice participation eagerness override: ${participationEagerness}.`);
	}
	const elevenLabsVoice = cleanArg(process.env.CLANKY_ELEVENLABS_VOICE_ID);
	if (elevenLabsVoice !== undefined) lines.push(`Env ElevenLabs voice override: ${elevenLabsVoice}.`);
	const elevenLabsModel = cleanArg(process.env.CLANKY_ELEVENLABS_MODEL);
	if (elevenLabsModel !== undefined) lines.push(`Env ElevenLabs model override: ${elevenLabsModel}.`);
	const elevenLabsOutputFormat = cleanArg(process.env.CLANKY_ELEVENLABS_OUTPUT_FORMAT);
	if (elevenLabsOutputFormat !== undefined)
		lines.push(`Env ElevenLabs output format override: ${elevenLabsOutputFormat}.`);
	const elevenLabsBaseUrl = cleanArg(process.env.CLANKY_ELEVENLABS_BASE_URL ?? process.env.ELEVENLABS_BASE_URL);
	if (elevenLabsBaseUrl !== undefined) lines.push(`Env ElevenLabs base URL override: ${elevenLabsBaseUrl}.`);
	const elevenLabsApiKey = cleanArg(process.env.CLANKY_ELEVENLABS_API_KEY ?? process.env.ELEVENLABS_API_KEY);
	if (elevenLabsApiKey !== undefined) lines.push("Env ElevenLabs API key override is set.");
	return lines;
}

function hasDiscordVoiceEnvConfiguration(): boolean {
	return (
		cleanArg(process.env.CLANKY_DISCORD_VOICE_ENABLED ?? process.env.CLANKY_DISCORD_VOICE) !== undefined ||
		cleanArg(process.env.CLANKY_DISCORD_VOICE_GUILD_ID) !== undefined ||
		cleanArg(process.env.CLANKY_DISCORD_VOICE_CHANNEL_ID) !== undefined ||
		cleanArg(process.env.CLANKY_DISCORD_VOICE_ALLOWED_GUILD_IDS) !== undefined ||
		cleanArg(process.env.CLANKY_DISCORD_VOICE_ALLOWED_CHANNEL_IDS) !== undefined ||
		cleanArg(
			process.env.CLANKY_DISCORD_VOICE_REALTIME_AGENT_PROVIDER ?? process.env.CLANKY_VOICE_REALTIME_AGENT_PROVIDER,
		) !== undefined ||
		cleanArg(process.env.CLANKY_DISCORD_VOICE_TTS_PROVIDER ?? process.env.CLANKY_VOICE_TTS_PROVIDER) !== undefined ||
		cleanArg(process.env.CLANKY_XAI_REALTIME_MODEL ?? process.env.CLANKY_XAI_VOICE_MODEL) !== undefined ||
		cleanArg(process.env.CLANKY_XAI_REALTIME_VOICE ?? process.env.CLANKY_XAI_VOICE) !== undefined ||
		cleanArg(process.env.XAI_API_KEY) !== undefined ||
		cleanArg(process.env.CLANKY_XAI_BASE_URL ?? process.env.XAI_BASE_URL) !== undefined ||
		cleanArg(process.env.CLANKY_DISCORD_VOICE_PARTICIPATION_EAGERNESS ?? process.env.CLANKY_DISCORD_VOICE_EAGERNESS) !==
			undefined ||
		cleanArg(process.env.CLANKY_ELEVENLABS_VOICE_ID) !== undefined ||
		cleanArg(process.env.CLANKY_ELEVENLABS_MODEL) !== undefined ||
		cleanArg(process.env.CLANKY_ELEVENLABS_OUTPUT_FORMAT) !== undefined ||
		cleanArg(process.env.CLANKY_ELEVENLABS_BASE_URL ?? process.env.ELEVENLABS_BASE_URL) !== undefined ||
		cleanArg(process.env.CLANKY_ELEVENLABS_API_KEY ?? process.env.ELEVENLABS_API_KEY) !== undefined
	);
}

function formatDiscordVoiceCommandStatus(deps: DiscordAuthCommandDeps): string {
	const lines = ["Discord voice"];
	if (deps.voiceSettings === undefined) {
		lines.push("Profile voice settings are not available in this session.");
	} else {
		lines.push(...formatDiscordVoiceSettings(deps.voiceSettings.read(), deps.voiceSettings.path));
	}
	lines.push(`ElevenLabs API key: ${formatElevenLabsCredentialLabel(deps)}.`);
	const envLines = formatDiscordVoiceEnvOverrides();
	if (envLines.length > 0) lines.push("", ...envLines);
	if (deps.gatewayController !== undefined) {
		lines.push("", formatDiscordBridgeStatus(deps.gatewayController.status()));
	}
	return lines.join("\n");
}

export async function runDiscordVoiceCommand(
	deps: DiscordAuthCommandDeps,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (deps.voiceSettings === undefined) {
		ctx.ui.notify("Discord voice settings are not available in this session.", "error");
		return;
	}
	const parts = parseCommandArgs(args);
	const subcommand = parts[0]?.toLowerCase();
	if (subcommand === undefined) {
		if (hasDiscordVoiceConfiguration(deps.voiceSettings.read()) || hasDiscordVoiceEnvConfiguration()) {
			ctx.ui.notify(formatDiscordVoiceCommandStatus(deps));
			return;
		}
		await runDiscordVoiceWizard(deps, ctx);
		return;
	}
	if (subcommand === "setup" || subcommand === "configure" || subcommand === "ui") {
		await runDiscordVoiceWizard(deps, ctx);
		return;
	}
	if (subcommand === "status") {
		ctx.ui.notify(formatDiscordVoiceCommandStatus(deps));
		return;
	}
	if (subcommand === "enable") {
		await runDiscordVoiceEnable(deps, parts.slice(1), ctx);
		return;
	}
	if (subcommand === "join" || subcommand === "target") {
		await runDiscordVoiceJoin(deps, parts.slice(1), ctx);
		return;
	}
	if (
		subcommand === "allow-server" ||
		subcommand === "allow-servers" ||
		subcommand === "server" ||
		subcommand === "servers" ||
		subcommand === "guild" ||
		subcommand === "guilds"
	) {
		await runDiscordVoiceAllowGuilds(deps, parts.slice(1), ctx);
		return;
	}
	if (subcommand === "allow-channel" || subcommand === "allow-channels") {
		await runDiscordVoiceAllowChannels(deps, parts.slice(1), ctx);
		return;
	}
	if (subcommand === "allow" || subcommand === "allowlist") {
		await runDiscordVoiceAllowChannels(deps, parts.slice(1), ctx);
		return;
	}
	if (subcommand === "disable") {
		await runDiscordVoiceDisable(deps, ctx);
		return;
	}
	if (subcommand === "set") {
		await runDiscordVoiceSet(deps, parts.slice(1), ctx);
		return;
	}
	if (subcommand === "clear") {
		await runDiscordVoiceClear(deps, ctx);
		return;
	}
	ctx.ui.notify(discordVoiceUsage(deps.voiceSettings.path), "warning");
}

async function runDiscordVoiceWizard(deps: DiscordAuthCommandDeps, ctx: ExtensionCommandContext): Promise<void> {
	const settings = deps.voiceSettings?.read();
	const toggleOption = settings?.enabled === true ? "Disable voice access" : "Enable voice access";
	const choice = await ctx.ui.select(discordVoiceWizardTitle(settings), [
		toggleOption,
		"Join voice channel target",
		"Allowed servers",
		"Allowed channels",
		"Advanced settings",
		"Show status",
		"Clear settings",
		"Cancel",
	]);
	if (choice === undefined || choice === "Cancel") return;
	if (choice === "Enable voice access") {
		await runDiscordVoiceEnable(deps, [], ctx);
		return;
	}
	if (choice === "Disable voice access") {
		await runDiscordVoiceDisable(deps, ctx);
		return;
	}
	if (choice === "Join voice channel target") {
		await runDiscordVoiceJoin(deps, [], ctx);
		return;
	}
	if (choice === "Allowed servers") {
		await runDiscordVoiceAllowedGuildsWizard(deps, ctx);
		return;
	}
	if (choice === "Allowed channels") {
		await runDiscordVoiceAllowedChannelsWizard(deps, ctx);
		return;
	}
	if (choice === "Advanced settings") {
		await runDiscordVoiceAdvancedWizard(deps, ctx);
		return;
	}
	if (choice === "Show status") {
		ctx.ui.notify(formatDiscordVoiceCommandStatus(deps));
		return;
	}
	if (choice === "Clear settings") {
		await runDiscordVoiceClear(deps, ctx);
	}
}

async function runDiscordVoiceJoin(
	deps: DiscordAuthCommandDeps,
	args: string[],
	ctx: ExtensionCommandContext,
): Promise<void> {
	const current = deps.voiceSettings?.read() ?? { enabled: false };
	const guildId = await readDiscordVoiceValue(ctx, args[0], "Discord guild id:", current.guildId);
	if (guildId === undefined) {
		ctx.ui.notify(discordVoiceUsage(deps.voiceSettings?.path), "warning");
		return;
	}
	const channelId = await readDiscordVoiceValue(ctx, args[1], "Discord voice channel id:", current.channelId);
	if (channelId === undefined) {
		ctx.ui.notify(discordVoiceUsage(deps.voiceSettings?.path), "warning");
		return;
	}
	let next: StoredDiscordVoiceSettings = {
		...current,
		enabled: true,
		guildId,
		channelId,
		allowedGuildIds: mergeDiscordIds(current.allowedGuildIds, [guildId]),
	};
	if (current.allowedChannelIds !== undefined && current.allowedChannelIds.length > 0) {
		next.allowedChannelIds = mergeDiscordIds(current.allowedChannelIds, [channelId]);
	}
	const configureAdvanced = await ctx.ui.confirm(
		"Configure advanced voice settings?",
		"Optional: realtime agent model/reasoning, speech output provider/voice, and video frame auto-attach interval.",
	);
	if (configureAdvanced) next = await collectDiscordVoiceAdvancedSettings(ctx, next);
	deps.voiceSettings?.write(next);
	const lines = [`Discord voice enabled for guild ${guildId}, channel ${channelId}.`];
	await restartDiscordBridgeAfterVoiceSettingsChange(deps, lines, ctx);
	ctx.ui.notify(lines.join("\n"));
}

async function runDiscordVoiceAdvancedWizard(
	deps: DiscordAuthCommandDeps,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const current = deps.voiceSettings?.read() ?? { enabled: false };
	const menu = discordVoiceAdvancedMenu(current, formatElevenLabsCredentialLabel(deps));
	const choiceLabel = await ctx.ui.select(
		"Discord voice advanced settings",
		menu.map((item) => item.label),
	);
	const choice = menu.find((item) => item.label === choiceLabel);
	if (choice === undefined || choice.action === "back") return;
	let next: StoredDiscordVoiceSettings = { ...current };
	switch (choice.action) {
		case "realtime-provider":
			next = await collectDiscordVoiceRealtimeAgentProvider(ctx, next);
			break;
		case "speech-provider":
			next = await collectDiscordVoiceTtsProvider(ctx, next);
			break;
		case "elevenlabs-api-key":
			await runElevenLabsLogin(
				{
					authStorage: deps.authStorage,
					authFilePath: deps.authFilePath,
					baseUrl: () => deps.voiceSettings?.read()?.elevenLabsBaseUrl,
					...(deps.gatewayController === undefined ? {} : { gatewayController: deps.gatewayController }),
				},
				ctx,
				{ reload: false },
			);
			return;
		case "openai-model":
			next = await collectDiscordVoiceModel(ctx, next);
			break;
		case "openai-voice":
			next = await collectDiscordVoiceVoice(ctx, next);
			break;
		case "openai-reasoning":
			next = await collectDiscordVoiceReasoning(ctx, next);
			break;
		case "openai-frame-interval":
			next = await collectDiscordVoiceFrameInterval(ctx, next);
			break;
		case "participation-eagerness":
			next = await collectDiscordVoiceParticipationEagerness(ctx, next);
			break;
		case "xai-model":
			next = await collectDiscordVoiceXAiModel(ctx, next);
			break;
		case "xai-voice":
			next = await collectDiscordVoiceXAiVoice(ctx, next);
			break;
		case "elevenlabs-voice":
			next = await collectDiscordVoiceElevenLabsVoice(ctx, next);
			break;
		case "elevenlabs-model":
			next = await collectDiscordVoiceElevenLabsModel(ctx, next);
			break;
		case "elevenlabs-output-format":
			next = await collectDiscordVoiceElevenLabsOutputFormat(ctx, next);
			break;
		case "elevenlabs-base-url":
			next = await collectDiscordVoiceElevenLabsBaseUrl(ctx, next);
			break;
		case "clear":
			delete next.realtimeAgentProvider;
			delete next.openAiRealtimeModel;
			delete next.openAiRealtimeVoice;
			delete next.openAiRealtimeReasoningEffort;
			delete next.xAiRealtimeModel;
			delete next.xAiRealtimeVoice;
			delete next.ttsProvider;
			delete next.elevenLabsVoiceId;
			delete next.elevenLabsModel;
			delete next.elevenLabsOutputFormat;
			delete next.elevenLabsBaseUrl;
			delete next.videoFrameAutoAttachIntervalMs;
			delete next.participationEagerness;
			break;
	}
	deps.voiceSettings?.write(next);
	const lines = ["Discord voice advanced settings updated."];
	await restartDiscordBridgeAfterVoiceSettingsChange(deps, lines, ctx);
	ctx.ui.notify(lines.join("\n"));
}

type DiscordVoiceAdvancedAction =
	| "realtime-provider"
	| "speech-provider"
	| "openai-model"
	| "openai-voice"
	| "openai-reasoning"
	| "openai-frame-interval"
	| "participation-eagerness"
	| "xai-model"
	| "xai-voice"
	| "elevenlabs-api-key"
	| "elevenlabs-voice"
	| "elevenlabs-model"
	| "elevenlabs-output-format"
	| "elevenlabs-base-url"
	| "clear"
	| "back";

interface DiscordVoiceAdvancedMenuItem {
	action: DiscordVoiceAdvancedAction;
	label: string;
}

function discordVoiceAdvancedMenu(
	current: StoredDiscordVoiceSettings,
	elevenLabsCredentialLabel: string,
): DiscordVoiceAdvancedMenuItem[] {
	return [
		{
			action: "realtime-provider",
			label: `Realtime agent: provider (${formatRealtimeAgentProviderLabel(current.realtimeAgentProvider ?? "openai")})`,
		},
		{
			action: "speech-provider",
			label: `Speech output: provider (${formatTtsProviderMenuLabel(current.ttsProvider)})`,
		},
		{ action: "openai-model", label: `Realtime agent: OpenAI model (${current.openAiRealtimeModel ?? "default"})` },
		{ action: "openai-voice", label: `Speech output: OpenAI voice (${current.openAiRealtimeVoice ?? "default"})` },
		{
			action: "xai-model",
			label: `Realtime agent: xAI model (${current.xAiRealtimeModel ?? DEFAULT_XAI_REALTIME_MODEL})`,
		},
		{ action: "xai-voice", label: `Speech output: xAI voice (${current.xAiRealtimeVoice ?? "default"})` },
		{
			action: "openai-reasoning",
			label: `Realtime agent: OpenAI reasoning effort (${current.openAiRealtimeReasoningEffort ?? "default"})`,
		},
		{
			action: "openai-frame-interval",
			label: `Realtime agent: video frame interval (${formatFrameIntervalLabel(current.videoFrameAutoAttachIntervalMs)})`,
		},
		{
			action: "participation-eagerness",
			label: `Participation: eagerness (${current.participationEagerness ?? "default"})`,
		},
		{ action: "elevenlabs-api-key", label: `ElevenLabs TTS: API key (${elevenLabsCredentialLabel})` },
		{ action: "elevenlabs-voice", label: `ElevenLabs TTS: voice id (${current.elevenLabsVoiceId ?? "not set"})` },
		{ action: "elevenlabs-model", label: `ElevenLabs TTS: model (${current.elevenLabsModel ?? "default"})` },
		{
			action: "elevenlabs-output-format",
			label: `ElevenLabs TTS: output format (${current.elevenLabsOutputFormat ?? DEFAULT_ELEVENLABS_OUTPUT_FORMAT})`,
		},
		{
			action: "elevenlabs-base-url",
			label: `ElevenLabs TTS: API base URL (${current.elevenLabsBaseUrl ?? "default"})`,
		},
		{ action: "clear", label: "Reset: clear advanced overrides" },
		{ action: "back", label: "Back" },
	];
}

function formatTtsProviderMenuLabel(provider: StoredDiscordVoiceSettings["ttsProvider"]): string {
	if (provider === "elevenlabs") return "ElevenLabs TTS audio";
	if (provider === "openai") return "OpenAI Realtime audio";
	return "OpenAI Realtime audio default";
}

function formatRealtimeAgentProviderLabel(provider: string): string {
	if (provider === "openai") return "OpenAI Realtime";
	if (provider === "xai") return "xAI Grok Voice";
	return provider;
}

function formatSpeechOutputProviderLabel(provider: string, realtimeAgentProvider = "openai"): string {
	if (provider === "elevenlabs") return "ElevenLabs TTS";
	if (provider === "openai" && realtimeAgentProvider === "xai") return "xAI Grok Voice audio";
	if (provider === "openai") return "OpenAI Realtime audio";
	return provider;
}

async function runDiscordVoiceAllowedGuildsWizard(
	deps: DiscordAuthCommandDeps,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const current = deps.voiceSettings?.read() ?? { enabled: false };
	const label =
		current.allowedGuildIds !== undefined && current.allowedGuildIds.length > 0
			? current.allowedGuildIds.join(", ")
			: "all accessible servers";
	const choice = await ctx.ui.select("Discord voice allowed servers", [
		`Current (${label})`,
		"Allow all servers",
		"Replace allowlist",
		"Add server ids",
		"Remove server ids",
		"Back",
	]);
	if (choice === undefined || choice === "Back" || choice.startsWith("Current")) return;
	let next: StoredDiscordVoiceSettings = { ...current, enabled: true };
	let line: string | undefined;
	if (choice === "Allow all servers") {
		delete next.allowedGuildIds;
		line = "Discord voice server allowlist cleared; all accessible servers are allowed.";
	} else {
		const raw = await ctx.ui.input(
			"Discord server ids:",
			"Separate multiple ids with commas or spaces. Blank cancels.",
		);
		const ids = parseDiscordIds(raw);
		if (ids.length === 0) {
			ctx.ui.notify("Discord voice allowed-server update cancelled.");
			return;
		}
		if (choice === "Replace allowlist") {
			next.allowedGuildIds = ids;
			line = `Discord voice server allowlist set to ${ids.join(", ")}.`;
		} else if (choice === "Add server ids") {
			next.allowedGuildIds = mergeDiscordIds(current.allowedGuildIds, ids);
			line = `Discord voice server allowlist set to ${next.allowedGuildIds.join(", ")}.`;
		} else if (choice === "Remove server ids") {
			const remove = new Set(ids);
			const remaining = (current.allowedGuildIds ?? []).filter((id) => !remove.has(id));
			next = { ...current, enabled: true };
			if (remaining.length > 0) {
				next.allowedGuildIds = remaining;
				line = `Discord voice server allowlist set to ${remaining.join(", ")}.`;
			} else {
				delete next.allowedGuildIds;
				line = "Discord voice server allowlist cleared; all accessible servers are allowed.";
			}
		}
	}
	if (line === undefined) return;
	deps.voiceSettings?.write(next);
	const lines = [line];
	await restartDiscordBridgeAfterVoiceSettingsChange(deps, lines, ctx);
	ctx.ui.notify(lines.join("\n"));
}

async function runDiscordVoiceAllowedChannelsWizard(
	deps: DiscordAuthCommandDeps,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const current = deps.voiceSettings?.read() ?? { enabled: false };
	const label =
		current.allowedChannelIds !== undefined && current.allowedChannelIds.length > 0
			? current.allowedChannelIds.join(", ")
			: "all accessible channels";
	const choice = await ctx.ui.select("Discord voice allowed channels", [
		`Current (${label})`,
		"Allow all voice channels",
		"Replace allowlist",
		"Add channel ids",
		"Remove channel ids",
		"Back",
	]);
	if (choice === undefined || choice === "Back" || choice.startsWith("Current")) return;
	let next: StoredDiscordVoiceSettings = { ...current, enabled: true };
	let line: string | undefined;
	if (choice === "Allow all voice channels") {
		delete next.allowedChannelIds;
		line = "Discord voice channel allowlist cleared; all accessible voice channels are allowed.";
	} else {
		const raw = await ctx.ui.input(
			"Discord voice channel ids:",
			"Separate multiple ids with commas or spaces. Blank cancels.",
		);
		const ids = parseDiscordIds(raw);
		if (ids.length === 0) {
			ctx.ui.notify("Discord voice allowed-channel update cancelled.");
			return;
		}
		if (choice === "Replace allowlist") {
			next.allowedChannelIds = ids;
			line = `Discord voice channel allowlist set to ${ids.join(", ")}.`;
		} else if (choice === "Add channel ids") {
			next.allowedChannelIds = mergeDiscordIds(current.allowedChannelIds, ids);
			line = `Discord voice channel allowlist set to ${next.allowedChannelIds.join(", ")}.`;
		} else if (choice === "Remove channel ids") {
			const remove = new Set(ids);
			const remaining = (current.allowedChannelIds ?? []).filter((id) => !remove.has(id));
			next = { ...current, enabled: true };
			if (remaining.length > 0) {
				next.allowedChannelIds = remaining;
				line = `Discord voice channel allowlist set to ${remaining.join(", ")}.`;
			} else {
				delete next.allowedChannelIds;
				line = "Discord voice channel allowlist cleared; all accessible voice channels are allowed.";
			}
		}
	}
	if (line === undefined) return;
	deps.voiceSettings?.write(next);
	const lines = [line];
	await restartDiscordBridgeAfterVoiceSettingsChange(deps, lines, ctx);
	ctx.ui.notify(lines.join("\n"));
}

async function runDiscordVoiceEnable(
	deps: DiscordAuthCommandDeps,
	args: string[],
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (args.length === 0) {
		const current = deps.voiceSettings?.read() ?? { enabled: false };
		const next: StoredDiscordVoiceSettings = { ...current, enabled: true };
		delete next.guildId;
		delete next.channelId;
		deps.voiceSettings?.write(next);
		const serverScope =
			next.allowedGuildIds !== undefined && next.allowedGuildIds.length > 0
				? `allowed servers (${next.allowedGuildIds.join(", ")})`
				: "all accessible servers";
		const channelScope =
			next.allowedChannelIds !== undefined && next.allowedChannelIds.length > 0
				? `allowed voice channels (${next.allowedChannelIds.join(", ")})`
				: "all accessible voice channels";
		const lines = [`Discord voice access enabled for ${serverScope} and ${channelScope}.`];
		await restartDiscordBridgeAfterVoiceSettingsChange(deps, lines, ctx);
		ctx.ui.notify(lines.join("\n"));
		return;
	}
	await runDiscordVoiceJoin(deps, args, ctx);
}

async function runDiscordVoiceAllowGuilds(
	deps: DiscordAuthCommandDeps,
	args: string[],
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (args.length === 0) {
		await runDiscordVoiceAllowedGuildsWizard(deps, ctx);
		return;
	}
	const current = deps.voiceSettings?.read() ?? { enabled: false };
	const clear = args.length === 1 && ["all", "clear", "none", "off"].includes(args[0]?.toLowerCase() ?? "");
	const next: StoredDiscordVoiceSettings = { ...current, enabled: true };
	const lines: string[] = [];
	if (clear) {
		delete next.allowedGuildIds;
		lines.push("Discord voice server allowlist cleared; all accessible servers are allowed.");
	} else {
		const allowedGuildIds = parseDiscordIds(args.join(" "));
		if (allowedGuildIds.length === 0) {
			ctx.ui.notify(discordVoiceUsage(deps.voiceSettings?.path), "warning");
			return;
		}
		next.allowedGuildIds = mergeDiscordIds(current.allowedGuildIds, allowedGuildIds);
		lines.push(`Discord voice server allowlist set to ${next.allowedGuildIds.join(", ")}.`);
	}
	deps.voiceSettings?.write(next);
	await restartDiscordBridgeAfterVoiceSettingsChange(deps, lines, ctx);
	ctx.ui.notify(lines.join("\n"));
}

async function runDiscordVoiceAllowChannels(
	deps: DiscordAuthCommandDeps,
	args: string[],
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (args.length === 0) {
		await runDiscordVoiceAllowedChannelsWizard(deps, ctx);
		return;
	}
	const current = deps.voiceSettings?.read() ?? { enabled: false };
	const clear = args.length === 1 && ["all", "clear", "none", "off"].includes(args[0]?.toLowerCase() ?? "");
	const next: StoredDiscordVoiceSettings = { ...current, enabled: true };
	const lines: string[] = [];
	if (clear) {
		delete next.allowedChannelIds;
		lines.push("Discord voice channel allowlist cleared; all accessible voice channels are allowed.");
	} else {
		const allowedChannelIds = parseDiscordIds(args.join(" "));
		if (allowedChannelIds.length === 0) {
			ctx.ui.notify(discordVoiceUsage(deps.voiceSettings?.path), "warning");
			return;
		}
		next.allowedChannelIds = mergeDiscordIds(current.allowedChannelIds, allowedChannelIds);
		lines.push(`Discord voice channel allowlist set to ${next.allowedChannelIds.join(", ")}.`);
	}
	deps.voiceSettings?.write(next);
	await restartDiscordBridgeAfterVoiceSettingsChange(deps, lines, ctx);
	ctx.ui.notify(lines.join("\n"));
}

async function runDiscordVoiceDisable(deps: DiscordAuthCommandDeps, ctx: ExtensionCommandContext): Promise<void> {
	const current = deps.voiceSettings?.read() ?? { enabled: false };
	deps.voiceSettings?.write({ ...current, enabled: false });
	const lines = ["Discord voice disabled in profile settings."];
	await restartDiscordBridgeAfterVoiceSettingsChange(deps, lines, ctx);
	ctx.ui.notify(lines.join("\n"));
}

async function runDiscordVoiceSet(
	deps: DiscordAuthCommandDeps,
	args: string[],
	ctx: ExtensionCommandContext,
): Promise<void> {
	const field = args[0]?.toLowerCase();
	const rawValue = cleanArg(args[1]);
	const current = deps.voiceSettings?.read() ?? { enabled: false };
	const next: StoredDiscordVoiceSettings = { ...current };
	let line: string | undefined;
	if (field === "guild") {
		const value = await readDiscordVoiceValue(ctx, rawValue, "Discord guild id:", current.guildId);
		if (value === undefined) return ctx.ui.notify(discordVoiceUsage(deps.voiceSettings?.path), "warning");
		next.guildId = value;
		line = `Discord voice guild id set to ${value}.`;
	} else if (field === "channel") {
		const value = await readDiscordVoiceValue(ctx, rawValue, "Discord voice channel id:", current.channelId);
		if (value === undefined) return ctx.ui.notify(discordVoiceUsage(deps.voiceSettings?.path), "warning");
		next.channelId = value;
		line = `Discord voice channel id set to ${value}.`;
	} else if (field === "allowed-servers" || field === "allowed-guilds" || field === "servers" || field === "guilds") {
		if (rawValue === "clear" || rawValue === "all" || rawValue === "none") {
			delete next.allowedGuildIds;
			line = "Discord voice server allowlist cleared.";
		} else {
			const value = parseDiscordIds(args.slice(1).join(" "));
			if (value.length > 0) {
				next.allowedGuildIds = value;
				next.enabled = true;
				line = `Discord voice server allowlist set to ${value.join(", ")}.`;
			}
		}
	} else if (field === "allowed" || field === "allowlist" || field === "allowed-channels" || field === "channels") {
		if (rawValue === "clear" || rawValue === "all" || rawValue === "none") {
			delete next.allowedChannelIds;
			line = "Discord voice channel allowlist cleared.";
		} else {
			const value = parseDiscordIds(args.slice(1).join(" "));
			if (value.length > 0) {
				next.allowedChannelIds = value;
				next.enabled = true;
				line = `Discord voice channel allowlist set to ${value.join(", ")}.`;
			}
		}
	} else if (field === "model") {
		const value = await readDiscordVoiceValue(
			ctx,
			rawValue,
			"OpenAI Realtime agent model:",
			current.openAiRealtimeModel,
		);
		if (value === undefined) return ctx.ui.notify(discordVoiceUsage(deps.voiceSettings?.path), "warning");
		next.openAiRealtimeModel = value;
		line = `OpenAI Realtime agent model set to ${value}.`;
	} else if (field === "realtime-provider" || field === "realtime-agent-provider") {
		const provider = parseDiscordVoiceRealtimeAgentProvider(rawValue);
		if (provider !== undefined) {
			next.realtimeAgentProvider = provider;
			line = `Discord voice realtime agent provider set to ${formatRealtimeAgentProviderLabel(provider)}.`;
		} else if (rawValue === "clear" || rawValue === "default") {
			delete next.realtimeAgentProvider;
			line = "Discord voice realtime agent provider override cleared.";
		}
	} else if (field === "voice") {
		const value = await readDiscordVoiceValue(ctx, rawValue, "OpenAI speech voice:", current.openAiRealtimeVoice);
		if (value === undefined) return ctx.ui.notify(discordVoiceUsage(deps.voiceSettings?.path), "warning");
		next.openAiRealtimeVoice = value;
		line = `OpenAI speech voice set to ${value}.`;
	} else if (field === "xai-model" || field === "grok-model") {
		const value = await readDiscordVoiceValue(
			ctx,
			rawValue,
			"xAI Grok Voice realtime model:",
			current.xAiRealtimeModel,
		);
		if (value === undefined) return ctx.ui.notify(discordVoiceUsage(deps.voiceSettings?.path), "warning");
		if (value === "clear" || value === "default") {
			delete next.xAiRealtimeModel;
			line = "xAI Grok Voice realtime model override cleared.";
		} else {
			next.xAiRealtimeModel = value;
			line = `xAI Grok Voice realtime model set to ${value}.`;
		}
	} else if (field === "xai-voice" || field === "grok-voice") {
		const value = await readDiscordVoiceValue(ctx, rawValue, "xAI Grok Voice output voice:", current.xAiRealtimeVoice);
		if (value === undefined) return ctx.ui.notify(discordVoiceUsage(deps.voiceSettings?.path), "warning");
		if (value === "clear" || value === "default") {
			delete next.xAiRealtimeVoice;
			line = "xAI Grok Voice output voice override cleared.";
		} else {
			next.xAiRealtimeVoice = value;
			line = `xAI Grok Voice output voice set to ${value}.`;
		}
	} else if (field === "tts-provider" || field === "speech-provider") {
		const provider = parseDiscordVoiceTtsProvider(rawValue);
		if (provider !== undefined) {
			next.ttsProvider = provider;
			line = `Discord voice speech output provider set to ${formatSpeechOutputProviderLabel(provider, next.realtimeAgentProvider ?? "openai")}.`;
		} else if (rawValue === "clear" || rawValue === "default") {
			delete next.ttsProvider;
			line = "Discord voice speech output provider override cleared.";
		}
	} else if (field === "elevenlabs-voice" || field === "elevenlabs-voice-id") {
		const value = await readDiscordVoiceValue(ctx, rawValue, "ElevenLabs voice id:", current.elevenLabsVoiceId);
		if (value === undefined) return ctx.ui.notify(discordVoiceUsage(deps.voiceSettings?.path), "warning");
		if (value === "clear" || value === "default") {
			delete next.elevenLabsVoiceId;
			line = "ElevenLabs voice id cleared.";
		} else {
			next.elevenLabsVoiceId = value;
			line = `ElevenLabs voice id set to ${value}.`;
		}
	} else if (field === "elevenlabs-model") {
		const value = await readDiscordVoiceValue(ctx, rawValue, "ElevenLabs model:", current.elevenLabsModel);
		if (value === undefined) return ctx.ui.notify(discordVoiceUsage(deps.voiceSettings?.path), "warning");
		if (value === "clear" || value === "default") {
			delete next.elevenLabsModel;
			line = "ElevenLabs model override cleared.";
		} else {
			next.elevenLabsModel = value;
			line = `ElevenLabs model set to ${value}.`;
		}
	} else if (field === "elevenlabs-output-format" || field === "elevenlabs-format") {
		const value = await readDiscordVoiceValue(
			ctx,
			rawValue,
			"ElevenLabs output format:",
			current.elevenLabsOutputFormat,
		);
		if (value === undefined) return ctx.ui.notify(discordVoiceUsage(deps.voiceSettings?.path), "warning");
		if (value === "clear" || value === "default") {
			delete next.elevenLabsOutputFormat;
			line = "ElevenLabs output format override cleared.";
		} else {
			const parsed = parseElevenLabsPcmOutputFormat(value);
			if (parsed !== undefined) {
				next.elevenLabsOutputFormat = parsed;
				line = `ElevenLabs output format set to ${parsed}.`;
			}
		}
	} else if (field === "elevenlabs-base-url" || field === "elevenlabs-url") {
		const value = await readDiscordVoiceValue(ctx, rawValue, "ElevenLabs API base URL:", current.elevenLabsBaseUrl);
		if (value === undefined) return ctx.ui.notify(discordVoiceUsage(deps.voiceSettings?.path), "warning");
		if (value === "clear" || value === "default") {
			delete next.elevenLabsBaseUrl;
			line = "ElevenLabs base URL override cleared.";
		} else {
			const parsed = parseHttpUrl(value);
			if (parsed !== undefined) {
				next.elevenLabsBaseUrl = parsed;
				line = `ElevenLabs base URL set to ${parsed}.`;
			}
		}
	} else if (field === "reasoning") {
		if (rawValue === "clear" || rawValue === "default") {
			delete next.openAiRealtimeReasoningEffort;
			line = "OpenAI Realtime agent reasoning effort cleared.";
		} else if (isRealtimeReasoningEffort(rawValue)) {
			next.openAiRealtimeReasoningEffort = rawValue;
			line = `OpenAI Realtime agent reasoning effort set to ${rawValue}.`;
		}
	} else if (field === "frame-interval" || field === "frame_interval") {
		const value = parseNonNegativeIntegerArg(rawValue);
		if (value !== undefined) {
			next.videoFrameAutoAttachIntervalMs = value;
			line = `Video frame auto-attach interval set to ${value} ms.`;
		}
	} else if (
		field === "eagerness" ||
		field === "participation" ||
		field === "participation-eagerness" ||
		field === "participation_eagerness"
	) {
		if (rawValue === "clear" || rawValue === "default") {
			delete next.participationEagerness;
			line = "Discord voice participation eagerness override cleared.";
		} else {
			const value = parseBoundedIntegerArg(rawValue, 0, 100);
			if (value !== undefined) {
				next.participationEagerness = value;
				line = `Discord voice participation eagerness set to ${value}/100.`;
			}
		}
	}
	if (line === undefined) {
		ctx.ui.notify(discordVoiceUsage(deps.voiceSettings?.path), "warning");
		return;
	}
	deps.voiceSettings?.write(next);
	const lines = [line];
	await restartDiscordBridgeAfterVoiceSettingsChange(deps, lines, ctx);
	ctx.ui.notify(lines.join("\n"));
}

async function collectDiscordVoiceAdvancedSettings(
	ctx: ExtensionCommandContext,
	settings: StoredDiscordVoiceSettings,
): Promise<StoredDiscordVoiceSettings> {
	let next = await collectDiscordVoiceModel(ctx, settings);
	next = await collectDiscordVoiceVoice(ctx, next);
	next = await collectDiscordVoiceReasoning(ctx, next);
	return await collectDiscordVoiceFrameInterval(ctx, next);
}

async function collectDiscordVoiceRealtimeAgentProvider(
	ctx: ExtensionCommandContext,
	settings: StoredDiscordVoiceSettings,
): Promise<StoredDiscordVoiceSettings> {
	const value = await ctx.ui.select("Discord voice realtime agent provider:", [
		"OpenAI Realtime",
		"xAI Grok Voice",
		"Keep current/default",
		"Clear override",
	]);
	if (value === undefined || value === "Keep current/default") return settings;
	const next = { ...settings };
	if (value === "Clear override") delete next.realtimeAgentProvider;
	else next.realtimeAgentProvider = value === "xAI Grok Voice" ? "xai" : "openai";
	return next;
}

async function collectDiscordVoiceTtsProvider(
	ctx: ExtensionCommandContext,
	settings: StoredDiscordVoiceSettings,
): Promise<StoredDiscordVoiceSettings> {
	const value = await ctx.ui.select("Discord voice speech output provider:", [
		"OpenAI Realtime audio",
		"ElevenLabs",
		"Keep current/default",
		"Clear override",
	]);
	if (value === undefined || value === "Keep current/default") return settings;
	const next = { ...settings };
	if (value === "Clear override") delete next.ttsProvider;
	else next.ttsProvider = value === "ElevenLabs" ? "elevenlabs" : "openai";
	return next;
}

async function collectDiscordVoiceModel(
	ctx: ExtensionCommandContext,
	settings: StoredDiscordVoiceSettings,
): Promise<StoredDiscordVoiceSettings> {
	const value = cleanArg(
		await ctx.ui.input(
			"OpenAI Realtime agent model:",
			settings.openAiRealtimeModel ?? "blank keeps current/default; type clear to remove override",
		),
	);
	if (value === undefined) return settings;
	const next = { ...settings };
	if (value === "clear" || value === "default") delete next.openAiRealtimeModel;
	else next.openAiRealtimeModel = value;
	return next;
}

async function collectDiscordVoiceVoice(
	ctx: ExtensionCommandContext,
	settings: StoredDiscordVoiceSettings,
): Promise<StoredDiscordVoiceSettings> {
	const value = cleanArg(
		await ctx.ui.input(
			"OpenAI speech voice:",
			settings.openAiRealtimeVoice ?? "blank keeps current/default; type clear to remove override",
		),
	);
	if (value === undefined) return settings;
	const next = { ...settings };
	if (value === "clear" || value === "default") delete next.openAiRealtimeVoice;
	else next.openAiRealtimeVoice = value;
	return next;
}

async function collectDiscordVoiceXAiModel(
	ctx: ExtensionCommandContext,
	settings: StoredDiscordVoiceSettings,
): Promise<StoredDiscordVoiceSettings> {
	const value = cleanArg(
		await ctx.ui.input(
			"xAI Grok Voice realtime model:",
			settings.xAiRealtimeModel ?? "blank keeps current/default; type clear to remove override",
		),
	);
	if (value === undefined) return settings;
	const next = { ...settings };
	if (value === "clear" || value === "default") delete next.xAiRealtimeModel;
	else next.xAiRealtimeModel = value;
	return next;
}

async function collectDiscordVoiceXAiVoice(
	ctx: ExtensionCommandContext,
	settings: StoredDiscordVoiceSettings,
): Promise<StoredDiscordVoiceSettings> {
	const value = cleanArg(
		await ctx.ui.input(
			"xAI Grok Voice output voice:",
			settings.xAiRealtimeVoice ?? "blank keeps current/default; type clear to remove override",
		),
	);
	if (value === undefined) return settings;
	const next = { ...settings };
	if (value === "clear" || value === "default") delete next.xAiRealtimeVoice;
	else next.xAiRealtimeVoice = value;
	return next;
}

async function collectDiscordVoiceElevenLabsVoice(
	ctx: ExtensionCommandContext,
	settings: StoredDiscordVoiceSettings,
): Promise<StoredDiscordVoiceSettings> {
	const value = cleanArg(
		await ctx.ui.input(
			"ElevenLabs voice id:",
			settings.elevenLabsVoiceId ?? "blank keeps current; type clear to remove override",
		),
	);
	if (value === undefined) return settings;
	const next = { ...settings };
	if (value === "clear" || value === "default") delete next.elevenLabsVoiceId;
	else next.elevenLabsVoiceId = value;
	return next;
}

async function collectDiscordVoiceElevenLabsModel(
	ctx: ExtensionCommandContext,
	settings: StoredDiscordVoiceSettings,
): Promise<StoredDiscordVoiceSettings> {
	const value = cleanArg(
		await ctx.ui.input(
			"ElevenLabs model:",
			settings.elevenLabsModel ?? "blank keeps current/default; type clear to remove override",
		),
	);
	if (value === undefined) return settings;
	const next = { ...settings };
	if (value === "clear" || value === "default") delete next.elevenLabsModel;
	else next.elevenLabsModel = value;
	return next;
}

async function collectDiscordVoiceElevenLabsOutputFormat(
	ctx: ExtensionCommandContext,
	settings: StoredDiscordVoiceSettings,
): Promise<StoredDiscordVoiceSettings> {
	const value = await ctx.ui.select("ElevenLabs output format:", [
		"Keep current/default",
		...ELEVENLABS_OUTPUT_FORMAT_OPTIONS,
		"Clear override",
	]);
	if (value === undefined || value === "Keep current/default") return settings;
	const next = { ...settings };
	if (value === "Clear override") delete next.elevenLabsOutputFormat;
	else {
		const parsed = parseElevenLabsPcmOutputFormat(value);
		if (parsed !== undefined) next.elevenLabsOutputFormat = parsed;
	}
	return next;
}

async function collectDiscordVoiceElevenLabsBaseUrl(
	ctx: ExtensionCommandContext,
	settings: StoredDiscordVoiceSettings,
): Promise<StoredDiscordVoiceSettings> {
	const value = cleanArg(
		await ctx.ui.input(
			"ElevenLabs API base URL:",
			settings.elevenLabsBaseUrl ?? "blank keeps current/default; type clear to remove override",
		),
	);
	if (value === undefined) return settings;
	const next = { ...settings };
	if (value === "clear" || value === "default") {
		delete next.elevenLabsBaseUrl;
		return next;
	}
	const parsed = parseHttpUrl(value);
	if (parsed !== undefined) next.elevenLabsBaseUrl = parsed;
	return next;
}

async function collectDiscordVoiceReasoning(
	ctx: ExtensionCommandContext,
	settings: StoredDiscordVoiceSettings,
): Promise<StoredDiscordVoiceSettings> {
	const value = await ctx.ui.select("OpenAI Realtime agent reasoning effort:", [
		"Keep current/default",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"Clear override",
	]);
	if (value === undefined || value === "Keep current/default") return settings;
	const next = { ...settings };
	if (value === "Clear override") delete next.openAiRealtimeReasoningEffort;
	else if (isRealtimeReasoningEffort(value)) next.openAiRealtimeReasoningEffort = value;
	return next;
}

async function collectDiscordVoiceFrameInterval(
	ctx: ExtensionCommandContext,
	settings: StoredDiscordVoiceSettings,
): Promise<StoredDiscordVoiceSettings> {
	const value = cleanArg(
		await ctx.ui.input(
			"Video frame auto-attach interval in milliseconds:",
			settings.videoFrameAutoAttachIntervalMs?.toString() ??
				"blank keeps current/default; type clear to remove override",
		),
	);
	if (value === undefined) return settings;
	const next = { ...settings };
	if (value === "clear" || value === "default") {
		delete next.videoFrameAutoAttachIntervalMs;
		return next;
	}
	const parsed = parseNonNegativeIntegerArg(value);
	if (parsed !== undefined) next.videoFrameAutoAttachIntervalMs = parsed;
	return next;
}

async function collectDiscordVoiceParticipationEagerness(
	ctx: ExtensionCommandContext,
	settings: StoredDiscordVoiceSettings,
): Promise<StoredDiscordVoiceSettings> {
	const value = cleanArg(
		await ctx.ui.input(
			"Voice participation eagerness from 0 to 100:",
			settings.participationEagerness?.toString() ?? "blank keeps current/default; type clear to remove override",
		),
	);
	if (value === undefined) return settings;
	const next = { ...settings };
	if (value === "clear" || value === "default") {
		delete next.participationEagerness;
		return next;
	}
	const parsed = parseBoundedIntegerArg(value, 0, 100);
	if (parsed !== undefined) next.participationEagerness = parsed;
	return next;
}

async function runDiscordVoiceClear(deps: DiscordAuthCommandDeps, ctx: ExtensionCommandContext): Promise<void> {
	const confirmed = await ctx.ui.confirm(
		"Clear stored Discord voice settings?",
		"Discord voice env vars, if set, are unchanged and still take precedence.",
	);
	if (!confirmed) {
		ctx.ui.notify("Discord voice settings clear cancelled.");
		return;
	}
	const removed = deps.voiceSettings?.clear() === true;
	const lines = [removed ? "Stored Discord voice settings cleared." : "No stored Discord voice settings to clear."];
	await restartDiscordBridgeAfterVoiceSettingsChange(deps, lines, ctx);
	ctx.ui.notify(lines.join("\n"));
}

async function readDiscordVoiceValue(
	ctx: ExtensionCommandContext,
	argValue: string | undefined,
	prompt: string,
	currentValue: string | undefined,
): Promise<string | undefined> {
	if (argValue !== undefined) return argValue;
	const suffix = currentValue !== undefined ? `current: ${currentValue}` : "leave blank to cancel";
	const input = (await ctx.ui.input(prompt, suffix))?.trim();
	return input !== undefined && input.length > 0 ? input : undefined;
}

async function restartDiscordBridgeAfterVoiceSettingsChange(
	deps: DiscordAuthCommandDeps,
	lines: string[],
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (deps.gatewayController === undefined) {
		lines.push("Restart Clanky to apply the voice setting.");
		return;
	}
	const loadingUi = createDiscordVoiceLoadingUi(ctx);
	try {
		await deps.gatewayController.restartVoice({
			onProgress: (progress) => loadingUi.update(progress),
		});
		const status = deps.gatewayController.status();
		const voiceConfigError = readStatusString(status, "voiceConfigError");
		if (voiceConfigError === undefined) {
			lines.push("Discord voice client started with the updated setting.");
		} else {
			lines.push(`Discord voice setting applied, but voice is inactive: ${voiceConfigError}`);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		lines.push(`Failed to start Discord voice client: ${message}. Fix the setting or restart Clanky to recover.`);
	} finally {
		loadingUi.stop();
	}
}

function createDiscordVoiceLoadingUi(ctx: ExtensionCommandContext): {
	update(progress: DiscordVoiceStartProgress): void;
	stop(): void;
} {
	let latest: DiscordVoiceStartProgress = {
		phase: "resolving_config",
		message: "Preparing Discord voice client.",
	};
	let frame = 0;
	const startedAt = Date.now();
	const render = () => {
		const elapsed = formatElapsed(Date.now() - startedAt);
		const spinner = DISCORD_VOICE_LOADING_FRAMES[frame % DISCORD_VOICE_LOADING_FRAMES.length] ?? "-";
		frame += 1;
		const target = formatDiscordVoiceProgressTarget(latest);
		const statusText = `discord voice ${spinner} ${latest.message} (${elapsed})`;
		ctx.ui.setStatus?.(DISCORD_VOICE_LOADING_UI_KEY, statusText);
		ctx.ui.setWidget?.(
			DISCORD_VOICE_LOADING_UI_KEY,
			[
				"Discord Voice",
				`${spinner} ${latest.message}`,
				`Phase: ${latest.phase.replace(/_/g, " ")}`,
				...(target === undefined ? [] : [target]),
				`Elapsed: ${elapsed}`,
				"Logs: /voice-logs",
			],
			{ placement: "belowEditor" },
		);
	};
	const timer = setInterval(render, 250);
	timer.unref?.();
	render();
	return {
		update(progress) {
			latest = progress;
			render();
		},
		stop() {
			clearInterval(timer);
			ctx.ui.setStatus?.(DISCORD_VOICE_LOADING_UI_KEY, undefined);
			ctx.ui.setWidget?.(DISCORD_VOICE_LOADING_UI_KEY, undefined);
		},
	};
}

function formatDiscordVoiceProgressTarget(progress: DiscordVoiceStartProgress): string | undefined {
	const parts = [
		progress.guildId === undefined ? undefined : `guild ${progress.guildId}`,
		progress.channelId === undefined ? undefined : `channel ${progress.channelId}`,
	].filter((part): part is string => part !== undefined);
	return parts.length === 0 ? undefined : `Target: ${parts.join(", ")}`;
}

function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return `${minutes}m ${rest}s`;
}

function cleanArg(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

function parseDiscordIds(value: string | undefined): string[] {
	const cleaned = cleanArg(value);
	if (cleaned === undefined) return [];
	return mergeDiscordIds(undefined, cleaned.split(/[,\s]+/));
}

function mergeDiscordIds(current: readonly string[] | undefined, next: readonly string[]): string[] {
	const seen = new Set<string>();
	const merged: string[] = [];
	for (const value of [...(current ?? []), ...next]) {
		const cleaned = cleanArg(value);
		if (cleaned === undefined || seen.has(cleaned)) continue;
		seen.add(cleaned);
		merged.push(cleaned);
	}
	return merged;
}

function parseCommandArgs(args: string): string[] {
	return args.trim().split(/\s+/).filter(Boolean);
}

function parseNonNegativeIntegerArg(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseBoundedIntegerArg(value: string | undefined, min: number, max: number): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed)) return undefined;
	const integer = Math.trunc(parsed);
	if (integer < min) return min;
	if (integer > max) return max;
	return integer;
}

function parseHttpUrl(value: string): string | undefined {
	try {
		const url = new URL(value.trim());
		if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
		return url.toString().replace(/\/+$/, "");
	} catch {
		return undefined;
	}
}

function discordVoiceWizardTitle(settings: StoredDiscordVoiceSettings | undefined): string {
	const enabled = settings?.enabled === true ? "enabled" : "disabled";
	const target = hasDiscordVoiceTarget(settings)
		? `guild ${settings.guildId}, channel ${settings.channelId}`
		: "all accessible channels";
	const allowedServers =
		settings?.allowedGuildIds !== undefined && settings.allowedGuildIds.length > 0
			? `${settings.allowedGuildIds.length} server${settings.allowedGuildIds.length === 1 ? "" : "s"}`
			: "all servers";
	const allowedChannels =
		settings?.allowedChannelIds !== undefined && settings.allowedChannelIds.length > 0
			? `${settings.allowedChannelIds.length} allowed channel${settings.allowedChannelIds.length === 1 ? "" : "s"}`
			: "all channels";
	return `Discord voice settings (${enabled}; ${target}; ${allowedServers}; ${allowedChannels})`;
}

function formatFrameIntervalLabel(value: number | undefined): string {
	return value === undefined ? "default" : `${value} ms`;
}

function hasDiscordVoiceTarget(
	settings: StoredDiscordVoiceSettings | undefined,
): settings is StoredDiscordVoiceSettings & {
	guildId: string;
	channelId: string;
} {
	return cleanArg(settings?.guildId) !== undefined && cleanArg(settings?.channelId) !== undefined;
}

function hasDiscordVoiceConfiguration(settings: StoredDiscordVoiceSettings | undefined): boolean {
	return settings !== undefined;
}

function formatElevenLabsCredentialLabel(deps: DiscordAuthCommandDeps): string {
	const status = getElevenLabsCredentialStatus(process.env, deps.authStorage, DEFAULT_ELEVENLABS_PROVIDER_ID);
	if (status.env.clankyElevenLabsApiKey) return "env CLANKY_ELEVENLABS_API_KEY";
	if (status.env.elevenLabsApiKey) return "env ELEVENLABS_API_KEY";
	if (status.stored !== undefined) return "stored";
	return "not set";
}

function isRealtimeReasoningEffort(
	value: string | undefined,
): value is NonNullable<StoredDiscordVoiceSettings["openAiRealtimeReasoningEffort"]> {
	return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function parseDiscordVoiceTtsProvider(value: string | undefined): DiscordVoiceTtsProvider | undefined {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "openai" || normalized === "realtime") return "openai";
	if (normalized === "elevenlabs" || normalized === "eleven_labs" || normalized === "11labs") return "elevenlabs";
	return undefined;
}

function parseDiscordVoiceRealtimeAgentProvider(
	value: string | undefined,
): DiscordVoiceRealtimeAgentProvider | undefined {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "openai") return "openai";
	if (normalized === "xai" || normalized === "grok") return "xai";
	return undefined;
}

function readStatusString(status: unknown, key: string): string | undefined {
	if (!isRecord(status)) return undefined;
	const value = status[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string" && item.length > 0)
		: [];
}

/**
 * Build an extension factory that registers the Discord auth slash
 * commands against the supplied AuthStorage + provider id.
 */
export function createDiscordAuthExtensionFactory(deps: DiscordAuthCommandDeps): ExtensionFactory {
	return (pi) => {
		pi.registerCommand("discord-login", {
			description: "Configure Clanky's agent-owned Discord token interactively",
			handler: async (_args, ctx) => {
				try {
					await runDiscordLogin(deps, ctx);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Discord login error: ${message}`, "error");
				}
			},
		});
		pi.registerCommand("discord-logout", {
			description: "Remove Clanky's stored Discord token from the profile auth store",
			handler: async (_args, ctx) => {
				try {
					await runDiscordLogout(deps, ctx);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Discord logout error: ${message}`, "error");
				}
			},
		});
		pi.registerCommand("discord-whoami", {
			description: "Show which Discord credential Clanky will use on next launch",
			handler: async (_args, ctx) => {
				try {
					runDiscordWhoami(deps, ctx);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Discord whoami error: ${message}`, "error");
				}
			},
		});
		pi.registerCommand("discord-status", {
			description: "Show Clanky's active Discord text and voice bridge status",
			handler: async (_args, ctx) => {
				try {
					runDiscordStatus(deps, ctx);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Discord status error: ${message}`, "error");
				}
			},
		});
		pi.registerCommand("discord-voice", {
			description: "Manage Clanky's Discord voice access from the TUI",
			getArgumentCompletions: (prefix) => completeClankyCommandArgument(prefix, DISCORD_VOICE_COMMAND_COMPLETIONS),
			handler: async (args, ctx) => {
				try {
					await runDiscordVoiceCommand(deps, args, ctx);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Discord voice settings error: ${message}`, "error");
				}
			},
		});
	};
}

export function resolveDefaultDiscordProviderId(env: NodeJS.ProcessEnv = process.env): string {
	return env.CLANKY_DISCORD_PROVIDER_ID?.trim() || DEFAULT_CLANKY_DISCORD_PROVIDER_ID;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
