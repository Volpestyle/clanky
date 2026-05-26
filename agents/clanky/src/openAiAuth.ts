/**
 * Interactive OpenAI API-key auth flow for Clanky.
 *
 * Pi's normal `/login` path can store OpenAI OAuth credentials. These commands
 * provide the API-key alternative: `/openai-login`, `/openai-logout`, and
 * `/openai-whoami`. Keys are saved under provider id `openai` in the profile
 * AuthStorage so Pi's model registry and Clanky's web/voice tools share it.
 */
import {
	DEFAULT_OPENAI_PROVIDER_ID,
	getOpenAiCredentialStatus,
	removeStoredOpenAiCredential,
	saveStoredOpenAiApiKey,
} from "@clanky/core";
import type { AuthStorage, ExtensionCommandContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ClankyDiscordGatewayController } from "./discordGatewayController.ts";
import { promptForSecret } from "./secretPrompt.ts";

const OPENAI_API_BASE = "https://api.openai.com/v1";
const PLATFORM_KEYS_URL = "https://platform.openai.com/api-keys";
const VALIDATION_USER_AGENT = "Clanky (clanky-pi, validate)";

interface OpenAiValidationSuccess {
	ok: true;
	modelCount?: number;
	sampleModel?: string;
}

interface OpenAiValidationFailure {
	ok: false;
	status: number;
	message: string;
}

type OpenAiValidationResult = OpenAiValidationSuccess | OpenAiValidationFailure;

export interface OpenAiAuthCommandDeps {
	authStorage: AuthStorage;
	authFilePath: string;
	providerId?: string;
	gatewayController?: ClankyDiscordGatewayController;
}

export async function validateOpenAiApiKey(
	apiKey: string,
	fetchImpl: typeof fetch = fetch,
): Promise<OpenAiValidationResult> {
	let response: Response;
	try {
		response = await fetchImpl(`${OPENAI_API_BASE}/models`, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"User-Agent": VALIDATION_USER_AGENT,
			},
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, status: 0, message: `Network error contacting OpenAI: ${message}` };
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
	const data = Array.isArray(json?.data) ? json.data : undefined;
	const first = data?.[0];
	const id = typeof first === "object" && first !== null ? (first as Record<string, unknown>).id : undefined;
	const result: OpenAiValidationSuccess = { ok: true };
	if (data !== undefined) result.modelCount = data.length;
	if (typeof id === "string" && id.length > 0) result.sampleModel = id;
	return result;
}

function loginInstructions(): string {
	return [
		"Paste an OpenAI API key. Clanky will validate it with OpenAI and store it in this profile.",
		"",
		`Create or rotate keys at ${PLATFORM_KEYS_URL}`,
		"",
		"Stored API keys use provider id openai, the same slot Pi uses for OpenAI model auth.",
		"CLANKY_OPENAI_API_KEY and OPENAI_API_KEY environment variables still take precedence when set.",
	].join("\n");
}

async function runOpenAiLogin(deps: OpenAiAuthCommandDeps, ctx: ExtensionCommandContext): Promise<void> {
	const providerId = resolveOpenAiProviderId(deps);
	const existing = deps.authStorage.get(providerId);
	if (existing !== undefined) {
		const replace = await ctx.ui.confirm(
			"Replace stored OpenAI credential?",
			`Provider "${providerId}" already has a stored ${existing.type} credential.`,
		);
		if (!replace) {
			ctx.ui.notify("OpenAI login cancelled; existing credential left unchanged.");
			return;
		}
	}

	ctx.ui.notify(loginInstructions());

	const apiKey = (
		await promptForSecret(ctx.ui, {
			title: "Paste OpenAI API key:",
			subtitle: "(input is masked; key is validated before saving)",
		})
	)?.trim();

	if (apiKey === undefined || apiKey.length === 0) {
		ctx.ui.notify("OpenAI login cancelled (no key entered).");
		return;
	}

	ctx.ui.notify("Validating OpenAI API key...");
	const validation = await validateOpenAiApiKey(apiKey);
	if (!validation.ok) {
		ctx.ui.notify(`OpenAI login failed: ${validation.message}`, "error");
		return;
	}

	saveStoredOpenAiApiKey(deps.authStorage, apiKey, providerId);

	const lines = [
		"OpenAI API key validated and saved.",
		`Stored in ${deps.authFilePath} (provider id "${providerId}", perms 0600).`,
	];
	if (validation.modelCount !== undefined) lines.push(`Models endpoint returned ${validation.modelCount} model(s).`);
	if (validation.sampleModel !== undefined) lines.push(`Sample model: ${validation.sampleModel}.`);
	if (process.env.CLANKY_OPENAI_API_KEY?.trim()) {
		lines.push("CLANKY_OPENAI_API_KEY is set and will take precedence until removed from the launch environment.");
	} else if (process.env.OPENAI_API_KEY?.trim()) {
		lines.push("OPENAI_API_KEY is set and will take precedence until removed from the launch environment.");
	}
	if (deps.gatewayController !== undefined) {
		lines.push("Reloading session to refresh model auth; restart Discord voice if it is already running.");
	} else {
		lines.push("Reloading session to refresh model auth.");
	}
	ctx.ui.notify(lines.join("\n"));

	// ctx is stale after reload - do this last and do not touch ctx again.
	await ctx.reload();
}

async function runOpenAiLogout(deps: OpenAiAuthCommandDeps, ctx: ExtensionCommandContext): Promise<void> {
	const providerId = resolveOpenAiProviderId(deps);
	const existing = deps.authStorage.get(providerId);
	if (existing === undefined) {
		ctx.ui.notify(`No stored OpenAI credential under provider "${providerId}".`);
		return;
	}

	const removed = removeStoredOpenAiCredential(deps.authStorage, providerId);
	if (!removed) {
		ctx.ui.notify("OpenAI logout: nothing to remove.");
		return;
	}

	const lines = [
		`Removed stored OpenAI ${existing.type} credential from ${deps.authFilePath}.`,
		"Environment variables OPENAI_API_KEY and CLANKY_OPENAI_API_KEY, if set, are unchanged and still take precedence.",
		"Reloading session to refresh model auth.",
	];
	ctx.ui.notify(lines.join("\n"));
	await ctx.reload();
}

function runOpenAiWhoami(deps: OpenAiAuthCommandDeps, ctx: ExtensionCommandContext): void {
	const providerId = resolveOpenAiProviderId(deps);
	const status = getOpenAiCredentialStatus(process.env, deps.authStorage, providerId);
	const lines: string[] = [];

	if (status.env.openAiApiKey) {
		lines.push("OPENAI_API_KEY env var is set (takes precedence).");
	}
	if (status.env.clankyOpenAiApiKey) {
		lines.push("CLANKY_OPENAI_API_KEY env var is set.");
	}
	if (status.env.openAiApiKey && status.env.clankyOpenAiApiKey) {
		lines.push("CLANKY_OPENAI_API_KEY wins over OPENAI_API_KEY for Clanky tools.");
	}
	if (status.stored === undefined) {
		lines.push(`No stored OpenAI credential under provider "${providerId}".`);
	} else {
		lines.push(`Stored OpenAI credential type: ${status.stored.type}.`);
		lines.push(`Stored in ${deps.authFilePath} (provider id "${providerId}").`);
	}
	if (status.activeSource !== undefined) {
		lines.push(`Active OpenAI credential source: ${status.activeSource}.`);
	}
	if (!status.available) {
		lines.push("Run /openai-login to configure an API key interactively, or /login for OAuth.");
	}

	ctx.ui.notify(lines.join("\n"));
}

export function createOpenAiAuthExtensionFactory(deps: OpenAiAuthCommandDeps): ExtensionFactory {
	return (pi) => {
		pi.registerCommand("openai-login", {
			description: "Configure an OpenAI API key interactively for this Clanky profile",
			handler: async (_args, ctx) => {
				try {
					await runOpenAiLogin(deps, ctx);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`OpenAI login error: ${message}`, "error");
				}
			},
		});
		pi.registerCommand("openai-logout", {
			description: "Remove the stored OpenAI credential from this Clanky profile",
			handler: async (_args, ctx) => {
				try {
					await runOpenAiLogout(deps, ctx);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`OpenAI logout error: ${message}`, "error");
				}
			},
		});
		pi.registerCommand("openai-whoami", {
			description: "Show which OpenAI credential Clanky will use",
			handler: async (_args, ctx) => {
				try {
					runOpenAiWhoami(deps, ctx);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`OpenAI whoami error: ${message}`, "error");
				}
			},
		});
	};
}

function resolveOpenAiProviderId(deps: OpenAiAuthCommandDeps): string {
	return deps.providerId?.trim() || DEFAULT_OPENAI_PROVIDER_ID;
}

function summarizeBody(bodyText: string): string {
	if (bodyText.length === 0) return "";
	try {
		const parsed = JSON.parse(bodyText) as unknown;
		const message = extractOpenAiErrorMessage(parsed);
		if (message !== undefined) return `: ${message}`;
	} catch {
		// Fall through to raw text summary.
	}
	return `: ${bodyText.replace(/\s+/g, " ").slice(0, 240)}`;
}

function extractOpenAiErrorMessage(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const error = (value as Record<string, unknown>).error;
	if (typeof error !== "object" || error === null) return undefined;
	const message = (error as Record<string, unknown>).message;
	return typeof message === "string" && message.length > 0 ? message : undefined;
}
