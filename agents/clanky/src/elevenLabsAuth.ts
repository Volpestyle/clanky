/**
 * Interactive ElevenLabs API-key auth flow for Clanky Discord voice.
 *
 * The realtime voice agent still owns reasoning, tool calls, and interruption
 * state. This credential is only for the optional external ElevenLabs speech
 * output path.
 */
import {
	DEFAULT_ELEVENLABS_PROVIDER_ID,
	getElevenLabsCredentialStatus,
	removeStoredElevenLabsCredential,
	saveStoredElevenLabsApiKey,
} from "@clanky/core";
import type { AuthStorage, ExtensionCommandContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ClankyDiscordGatewayController } from "./discordGatewayController.ts";
import { promptForSecret } from "./secretPrompt.ts";

const DEFAULT_ELEVENLABS_API_BASE = "https://api.elevenlabs.io";
const ELEVENLABS_KEYS_URL = "https://elevenlabs.io/app/settings/api-keys";
const VALIDATION_USER_AGENT = "Clanky (clanky-pi, validate)";

interface ElevenLabsValidationSuccess {
	ok: true;
	subscriptionTier?: string;
	characterCount?: number;
	characterLimit?: number;
}

interface ElevenLabsValidationFailure {
	ok: false;
	status: number;
	message: string;
}

type ElevenLabsValidationResult = ElevenLabsValidationSuccess | ElevenLabsValidationFailure;

export interface ElevenLabsAuthCommandDeps {
	authStorage: AuthStorage;
	authFilePath: string;
	providerId?: string;
	gatewayController?: ClankyDiscordGatewayController;
	baseUrl?: () => string | undefined;
}

export interface ElevenLabsLoginOptions {
	reload?: boolean;
}

export async function validateElevenLabsApiKey(
	apiKey: string,
	baseUrl: string = DEFAULT_ELEVENLABS_API_BASE,
	fetchImpl: typeof fetch = fetch,
): Promise<ElevenLabsValidationResult> {
	const normalizedBaseUrl = normalizeElevenLabsBaseUrl(baseUrl);
	let response: Response;
	try {
		response = await fetchImpl(`${normalizedBaseUrl}/v1/user`, {
			method: "GET",
			headers: {
				"User-Agent": VALIDATION_USER_AGENT,
				"xi-api-key": apiKey,
			},
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, status: 0, message: `Network error contacting ElevenLabs: ${message}` };
	}

	if (!response.ok) {
		const bodyText = await response.text().catch(() => "");
		return {
			ok: false,
			status: response.status,
			message: `${response.status} ${response.statusText}${summarizeBody(bodyText)}`,
		};
	}

	const json = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
	const result: ElevenLabsValidationSuccess = { ok: true };
	const subscription = isRecord(json?.subscription) ? json.subscription : undefined;
	if (typeof subscription?.tier === "string") result.subscriptionTier = subscription.tier;
	if (typeof subscription?.character_count === "number") result.characterCount = subscription.character_count;
	if (typeof subscription?.character_limit === "number") result.characterLimit = subscription.character_limit;
	return result;
}

export async function runElevenLabsLogin(
	deps: ElevenLabsAuthCommandDeps,
	ctx: ExtensionCommandContext,
	options: ElevenLabsLoginOptions = {},
): Promise<boolean> {
	const providerId = resolveElevenLabsProviderId(deps);
	const existing = deps.authStorage.get(providerId);
	if (existing !== undefined) {
		const replace = await ctx.ui.confirm(
			"Replace stored ElevenLabs credential?",
			`Provider "${providerId}" already has a stored ${existing.type} credential.`,
		);
		if (!replace) {
			ctx.ui.notify("ElevenLabs login cancelled; existing credential left unchanged.");
			return false;
		}
	}

	const baseUrl = resolveElevenLabsBaseUrl(deps);
	ctx.ui.notify(loginInstructions(baseUrl));

	const apiKey = (
		await promptForSecret(ctx.ui, {
			title: "Paste ElevenLabs API key:",
			subtitle: "(input is masked; key is validated before saving)",
		})
	)?.trim();

	if (apiKey === undefined || apiKey.length === 0) {
		ctx.ui.notify("ElevenLabs login cancelled (no key entered).");
		return false;
	}

	ctx.ui.notify("Validating ElevenLabs API key...");
	const validation = await validateElevenLabsApiKey(apiKey, baseUrl);
	if (!validation.ok) {
		ctx.ui.notify(`ElevenLabs login failed: ${validation.message}`, "error");
		return false;
	}

	saveStoredElevenLabsApiKey(deps.authStorage, apiKey, providerId);

	const lines = [
		"ElevenLabs API key validated and saved.",
		`Stored in ${deps.authFilePath} (provider id "${providerId}", perms 0600).`,
	];
	if (baseUrl !== DEFAULT_ELEVENLABS_API_BASE) lines.push(`Validated against ${baseUrl}.`);
	if (validation.subscriptionTier !== undefined) lines.push(`Subscription tier: ${validation.subscriptionTier}.`);
	if (validation.characterCount !== undefined && validation.characterLimit !== undefined) {
		lines.push(`Characters used: ${validation.characterCount}/${validation.characterLimit}.`);
	}
	if (process.env.CLANKY_ELEVENLABS_API_KEY?.trim()) {
		lines.push("CLANKY_ELEVENLABS_API_KEY is set and will take precedence until removed from the launch environment.");
	} else if (process.env.ELEVENLABS_API_KEY?.trim()) {
		lines.push("ELEVENLABS_API_KEY is set and will take precedence until removed from the launch environment.");
	}
	if (deps.gatewayController !== undefined) {
		try {
			await deps.gatewayController.restart();
			lines.push("Discord bridge restarted with the updated ElevenLabs credential.");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			lines.push(`Failed to restart Discord bridge: ${message}. Restart Clanky to recover.`);
		}
	}
	if (options.reload !== false) lines.push("Reloading session to refresh auth status.");
	ctx.ui.notify(lines.join("\n"));

	if (options.reload !== false) {
		// ctx is stale after reload - do this last and do not touch ctx again.
		await ctx.reload();
	}
	return true;
}

async function runElevenLabsLogout(deps: ElevenLabsAuthCommandDeps, ctx: ExtensionCommandContext): Promise<void> {
	const providerId = resolveElevenLabsProviderId(deps);
	const existing = deps.authStorage.get(providerId);
	if (existing === undefined) {
		ctx.ui.notify(`No stored ElevenLabs credential under provider "${providerId}".`);
		return;
	}

	const removed = removeStoredElevenLabsCredential(deps.authStorage, providerId);
	if (!removed) {
		ctx.ui.notify("ElevenLabs logout: nothing to remove.");
		return;
	}

	const lines = [
		`Removed stored ElevenLabs ${existing.type} credential from ${deps.authFilePath}.`,
		"Environment variables ELEVENLABS_API_KEY and CLANKY_ELEVENLABS_API_KEY, if set, are unchanged and still take precedence.",
	];
	if (deps.gatewayController !== undefined) {
		try {
			await deps.gatewayController.restart();
			lines.push("Discord bridge restarted after ElevenLabs logout.");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			lines.push(`Failed to restart Discord bridge after logout: ${message}. Restart Clanky to recover.`);
		}
	}
	lines.push("Reloading session to refresh auth status.");
	ctx.ui.notify(lines.join("\n"));
	await ctx.reload();
}

function runElevenLabsWhoami(deps: ElevenLabsAuthCommandDeps, ctx: ExtensionCommandContext): void {
	const providerId = resolveElevenLabsProviderId(deps);
	const status = getElevenLabsCredentialStatus(process.env, deps.authStorage, providerId);
	const lines: string[] = [];

	if (status.env.elevenLabsApiKey) lines.push("ELEVENLABS_API_KEY env var is set (takes precedence).");
	if (status.env.clankyElevenLabsApiKey) lines.push("CLANKY_ELEVENLABS_API_KEY env var is set.");
	if (status.env.elevenLabsApiKey && status.env.clankyElevenLabsApiKey) {
		lines.push("CLANKY_ELEVENLABS_API_KEY wins over ELEVENLABS_API_KEY for Clanky voice.");
	}
	if (status.stored === undefined) {
		lines.push(`No stored ElevenLabs credential under provider "${providerId}".`);
	} else {
		lines.push(`Stored ElevenLabs credential type: ${status.stored.type}.`);
		lines.push(`Stored in ${deps.authFilePath} (provider id "${providerId}").`);
	}
	if (status.activeSource !== undefined) lines.push(`Active ElevenLabs credential source: ${status.activeSource}.`);
	if (!status.available) lines.push("Run /elevenlabs-login to configure an API key interactively.");

	ctx.ui.notify(lines.join("\n"));
}

export function createElevenLabsAuthExtensionFactory(deps: ElevenLabsAuthCommandDeps): ExtensionFactory {
	return (pi) => {
		pi.registerCommand("elevenlabs-login", {
			description: "Configure an ElevenLabs API key interactively for Discord voice",
			handler: async (_args, ctx) => {
				try {
					await runElevenLabsLogin(deps, ctx);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`ElevenLabs login error: ${message}`, "error");
				}
			},
		});
		pi.registerCommand("elevenlabs-logout", {
			description: "Remove the stored ElevenLabs credential from this Clanky profile",
			handler: async (_args, ctx) => {
				try {
					await runElevenLabsLogout(deps, ctx);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`ElevenLabs logout error: ${message}`, "error");
				}
			},
		});
		pi.registerCommand("elevenlabs-whoami", {
			description: "Show which ElevenLabs credential Clanky will use",
			handler: async (_args, ctx) => {
				try {
					runElevenLabsWhoami(deps, ctx);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`ElevenLabs whoami error: ${message}`, "error");
				}
			},
		});
	};
}

function loginInstructions(baseUrl: string): string {
	const lines = [
		"Paste an ElevenLabs API key. Clanky will validate it and store it in this profile.",
		"",
		`Create or rotate keys at ${ELEVENLABS_KEYS_URL}`,
		"",
		`Validation base URL: ${baseUrl}`,
		"CLANKY_ELEVENLABS_API_KEY and ELEVENLABS_API_KEY environment variables still take precedence when set.",
	];
	return lines.join("\n");
}

function resolveElevenLabsProviderId(deps: ElevenLabsAuthCommandDeps): string {
	return deps.providerId?.trim() || DEFAULT_ELEVENLABS_PROVIDER_ID;
}

function resolveElevenLabsBaseUrl(deps: ElevenLabsAuthCommandDeps): string {
	return normalizeElevenLabsBaseUrl(
		process.env.CLANKY_ELEVENLABS_BASE_URL?.trim() ||
			process.env.ELEVENLABS_BASE_URL?.trim() ||
			deps.baseUrl?.() ||
			DEFAULT_ELEVENLABS_API_BASE,
	);
}

function normalizeElevenLabsBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim();
	return (trimmed.length > 0 ? trimmed : DEFAULT_ELEVENLABS_API_BASE).replace(/\/+$/, "");
}

function summarizeBody(bodyText: string): string {
	if (bodyText.length === 0) return "";
	try {
		const parsed = JSON.parse(bodyText) as unknown;
		const message = extractElevenLabsErrorMessage(parsed);
		if (message !== undefined) return `: ${message}`;
	} catch {
		// Fall through to raw text summary.
	}
	return `: ${bodyText.replace(/\s+/g, " ").slice(0, 240)}`;
}

function extractElevenLabsErrorMessage(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	const detail = value.detail;
	if (typeof detail === "string" && detail.length > 0) return detail;
	if (isRecord(detail)) {
		const message = detail.message ?? detail.status;
		if (typeof message === "string" && message.length > 0) return message;
	}
	const message = value.message ?? value.error;
	return typeof message === "string" && message.length > 0 ? message : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
