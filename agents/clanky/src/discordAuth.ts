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
	type ClankyDiscordCredentialKind,
	type ClankyDiscordCredentialPayload,
	DEFAULT_CLANKY_DISCORD_PROVIDER_ID,
	DEFAULT_ELEVENLABS_PROVIDER_ID,
	getElevenLabsCredentialStatus,
	loadStoredDiscordCredential,
	removeStoredDiscordCredential,
	saveStoredDiscordCredential,
} from "@clanky/core";
import type { AuthStorage, ExtensionCommandContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ClankyDiscordGatewayController } from "./discordGatewayController.ts";
import type {
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

async function runDiscordLogin(deps: DiscordAuthCommandDeps, ctx: ExtensionCommandContext): Promise<void> {
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
		if (typeof voice.model === "string") lines.push(`Realtime model: ${voice.model}.`);
		if (typeof voice.ttsProvider === "string") lines.push(`Speech provider: ${voice.ttsProvider}.`);
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
		"  /discord-voice set tts-provider elevenlabs",
		"  /discord-voice set elevenlabs-voice <voice-id>",
		"  /discord-voice set elevenlabs-output-format pcm_24000",
		"  /elevenlabs-login",
		"  /discord-voice disable",
	];
	if (path !== undefined) lines.push("", `Profile settings file: ${path}`);
	lines.push("", "Env vars still work and override profile voice settings when present.");
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
	if (settings.openAiRealtimeModel !== undefined) lines.push(`Stored Realtime model: ${settings.openAiRealtimeModel}.`);
	if (settings.openAiRealtimeVoice !== undefined) lines.push(`Stored Realtime voice: ${settings.openAiRealtimeVoice}.`);
	lines.push(`Speech provider: ${settings.ttsProvider ?? "openai"}.`);
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
		lines.push(`Stored Realtime reasoning effort: ${settings.openAiRealtimeReasoningEffort}.`);
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
	const ttsProvider = cleanArg(process.env.CLANKY_DISCORD_VOICE_TTS_PROVIDER ?? process.env.CLANKY_VOICE_TTS_PROVIDER);
	if (ttsProvider !== undefined) lines.push(`Env speech provider override: ${ttsProvider}.`);
	const model = cleanArg(process.env.CLANKY_OPENAI_REALTIME_MODEL);
	if (model !== undefined) lines.push(`Env Realtime model override: ${model}.`);
	const voice = cleanArg(process.env.CLANKY_OPENAI_REALTIME_VOICE);
	if (voice !== undefined) lines.push(`Env Realtime voice override: ${voice}.`);
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
		cleanArg(process.env.CLANKY_DISCORD_VOICE_TTS_PROVIDER ?? process.env.CLANKY_VOICE_TTS_PROVIDER) !== undefined ||
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

async function runDiscordVoiceCommand(
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
		"Configure advanced Realtime settings?",
		"Optional: model, voice, reasoning effort, and video frame auto-attach interval.",
	);
	if (configureAdvanced) next = await collectDiscordVoiceAdvancedSettings(ctx, next);
	deps.voiceSettings?.write(next);
	const lines = [`Discord voice enabled for guild ${guildId}, channel ${channelId}.`];
	await restartDiscordBridgeAfterVoiceSettingsChange(deps, lines);
	ctx.ui.notify(lines.join("\n"));
}

async function runDiscordVoiceAdvancedWizard(
	deps: DiscordAuthCommandDeps,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const current = deps.voiceSettings?.read() ?? { enabled: false };
	const choice = await ctx.ui.select("Discord voice advanced settings", [
		`Speech provider (${current.ttsProvider ?? "openai"})`,
		`ElevenLabs API key (${formatElevenLabsCredentialLabel(deps)})`,
		`Realtime model (${current.openAiRealtimeModel ?? "default"})`,
		`Realtime voice (${current.openAiRealtimeVoice ?? "default"})`,
		`ElevenLabs voice id (${current.elevenLabsVoiceId ?? "not set"})`,
		`ElevenLabs model (${current.elevenLabsModel ?? "default"})`,
		`ElevenLabs output format (${current.elevenLabsOutputFormat ?? DEFAULT_ELEVENLABS_OUTPUT_FORMAT})`,
		`ElevenLabs base URL (${current.elevenLabsBaseUrl ?? "default"})`,
		`Reasoning effort (${current.openAiRealtimeReasoningEffort ?? "default"})`,
		`Video frame interval (${formatFrameIntervalLabel(current.videoFrameAutoAttachIntervalMs)})`,
		"Clear advanced overrides",
		"Back",
	]);
	if (choice === undefined || choice === "Back") return;
	let next: StoredDiscordVoiceSettings = { ...current };
	if (choice.startsWith("Speech provider")) {
		next = await collectDiscordVoiceTtsProvider(ctx, next);
	} else if (choice.startsWith("ElevenLabs API key")) {
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
	} else if (choice.startsWith("Realtime model")) {
		next = await collectDiscordVoiceModel(ctx, next);
	} else if (choice.startsWith("Realtime voice")) {
		next = await collectDiscordVoiceVoice(ctx, next);
	} else if (choice.startsWith("ElevenLabs voice id")) {
		next = await collectDiscordVoiceElevenLabsVoice(ctx, next);
	} else if (choice.startsWith("ElevenLabs model")) {
		next = await collectDiscordVoiceElevenLabsModel(ctx, next);
	} else if (choice.startsWith("ElevenLabs output format")) {
		next = await collectDiscordVoiceElevenLabsOutputFormat(ctx, next);
	} else if (choice.startsWith("ElevenLabs base URL")) {
		next = await collectDiscordVoiceElevenLabsBaseUrl(ctx, next);
	} else if (choice.startsWith("Reasoning effort")) {
		next = await collectDiscordVoiceReasoning(ctx, next);
	} else if (choice.startsWith("Video frame interval")) {
		next = await collectDiscordVoiceFrameInterval(ctx, next);
	} else if (choice === "Clear advanced overrides") {
		delete next.openAiRealtimeModel;
		delete next.openAiRealtimeVoice;
		delete next.openAiRealtimeReasoningEffort;
		delete next.ttsProvider;
		delete next.elevenLabsVoiceId;
		delete next.elevenLabsModel;
		delete next.elevenLabsOutputFormat;
		delete next.elevenLabsBaseUrl;
		delete next.videoFrameAutoAttachIntervalMs;
	}
	deps.voiceSettings?.write(next);
	const lines = ["Discord voice advanced settings updated."];
	await restartDiscordBridgeAfterVoiceSettingsChange(deps, lines);
	ctx.ui.notify(lines.join("\n"));
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
	await restartDiscordBridgeAfterVoiceSettingsChange(deps, lines);
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
	await restartDiscordBridgeAfterVoiceSettingsChange(deps, lines);
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
		await restartDiscordBridgeAfterVoiceSettingsChange(deps, lines);
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
	await restartDiscordBridgeAfterVoiceSettingsChange(deps, lines);
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
	await restartDiscordBridgeAfterVoiceSettingsChange(deps, lines);
	ctx.ui.notify(lines.join("\n"));
}

async function runDiscordVoiceDisable(deps: DiscordAuthCommandDeps, ctx: ExtensionCommandContext): Promise<void> {
	const current = deps.voiceSettings?.read() ?? { enabled: false };
	deps.voiceSettings?.write({ ...current, enabled: false });
	const lines = ["Discord voice disabled in profile settings."];
	await restartDiscordBridgeAfterVoiceSettingsChange(deps, lines);
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
		const value = await readDiscordVoiceValue(ctx, rawValue, "OpenAI Realtime model:", current.openAiRealtimeModel);
		if (value === undefined) return ctx.ui.notify(discordVoiceUsage(deps.voiceSettings?.path), "warning");
		next.openAiRealtimeModel = value;
		line = `Realtime model set to ${value}.`;
	} else if (field === "voice") {
		const value = await readDiscordVoiceValue(ctx, rawValue, "OpenAI Realtime voice:", current.openAiRealtimeVoice);
		if (value === undefined) return ctx.ui.notify(discordVoiceUsage(deps.voiceSettings?.path), "warning");
		next.openAiRealtimeVoice = value;
		line = `Realtime voice set to ${value}.`;
	} else if (field === "tts-provider" || field === "speech-provider") {
		const provider = parseDiscordVoiceTtsProvider(rawValue);
		if (provider !== undefined) {
			next.ttsProvider = provider;
			line = `Discord voice speech provider set to ${provider}.`;
		} else if (rawValue === "clear" || rawValue === "default") {
			delete next.ttsProvider;
			line = "Discord voice speech provider override cleared.";
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
			line = "Realtime reasoning effort cleared.";
		} else if (isRealtimeReasoningEffort(rawValue)) {
			next.openAiRealtimeReasoningEffort = rawValue;
			line = `Realtime reasoning effort set to ${rawValue}.`;
		}
	} else if (field === "frame-interval" || field === "frame_interval") {
		const value = parseNonNegativeIntegerArg(rawValue);
		if (value !== undefined) {
			next.videoFrameAutoAttachIntervalMs = value;
			line = `Video frame auto-attach interval set to ${value} ms.`;
		}
	}
	if (line === undefined) {
		ctx.ui.notify(discordVoiceUsage(deps.voiceSettings?.path), "warning");
		return;
	}
	deps.voiceSettings?.write(next);
	const lines = [line];
	await restartDiscordBridgeAfterVoiceSettingsChange(deps, lines);
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

async function collectDiscordVoiceTtsProvider(
	ctx: ExtensionCommandContext,
	settings: StoredDiscordVoiceSettings,
): Promise<StoredDiscordVoiceSettings> {
	const value = await ctx.ui.select("Discord voice speech provider:", [
		"OpenAI Realtime voice",
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
			"OpenAI Realtime model:",
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
			"OpenAI Realtime voice:",
			settings.openAiRealtimeVoice ?? "blank keeps current/default; type clear to remove override",
		),
	);
	if (value === undefined) return settings;
	const next = { ...settings };
	if (value === "clear" || value === "default") delete next.openAiRealtimeVoice;
	else next.openAiRealtimeVoice = value;
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
	const value = await ctx.ui.select("OpenAI Realtime reasoning effort:", [
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
	await restartDiscordBridgeAfterVoiceSettingsChange(deps, lines);
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
): Promise<void> {
	if (deps.gatewayController === undefined) {
		lines.push("Restart Clanky to apply the voice setting.");
		return;
	}
	try {
		await deps.gatewayController.restart();
		const status = deps.gatewayController.status();
		const voiceConfigError = readStatusString(status, "voiceConfigError");
		if (voiceConfigError === undefined) {
			lines.push("Discord bridge restarted with the updated voice setting.");
		} else {
			lines.push(`Discord bridge restarted, but voice is inactive: ${voiceConfigError}`);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		lines.push(`Failed to restart Discord bridge: ${message}. Fix the setting or restart Clanky to recover.`);
	}
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
