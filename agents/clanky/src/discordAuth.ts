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
	loadStoredDiscordCredential,
	removeStoredDiscordCredential,
	saveStoredDiscordCredential,
} from "@clanky/core";
import type { AuthStorage, ExtensionCommandContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ClankyDiscordGatewayController } from "./discordGatewayController.ts";
import { promptForSecret } from "./secretPrompt.ts";

const DEV_PORTAL_URL = "https://discord.com/developers/applications";
const DISCORD_API_BASE = "https://discord.com/api/v10";

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
	const voice = isRecord(status.voice) ? status.voice : undefined;
	if (voice !== undefined) {
		if (typeof voice.guildId === "string" && typeof voice.channelId === "string") {
			lines.push(`Voice target: guild ${voice.guildId}, channel ${voice.channelId}.`);
		}
		if (typeof voice.model === "string") lines.push(`Realtime model: ${voice.model}.`);
		if (typeof voice.discordCredentialKind === "string") {
			lines.push(`Discord credential kind: ${voice.discordCredentialKind}.`);
		}
		if (typeof voice.nativeScreenWatchSupported === "boolean") {
			lines.push(`Native screen watch: ${voice.nativeScreenWatchSupported ? "supported" : "requires user-token"}.`);
		}
		if (typeof voice.discoveredStreams === "number")
			lines.push(`Discovered screen shares: ${voice.discoveredStreams}.`);
		if (voice.activeStreamWatchKey !== undefined) {
			lines.push(`Active screen watch: ${String(voice.activeStreamWatchKey)}.`);
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
	};
}

export function resolveDefaultDiscordProviderId(env: NodeJS.ProcessEnv = process.env): string {
	return env.CLANKY_DISCORD_PROVIDER_ID?.trim() || DEFAULT_CLANKY_DISCORD_PROVIDER_ID;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
