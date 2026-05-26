import {
	DEFAULT_XAI_PROVIDER_ID,
	getXAiCredentialStatus,
	removeStoredXAiCredential,
	saveStoredXAiApiKey,
} from "@clanky/core";
import type { AuthStorage, ExtensionCommandContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { promptForSecret } from "./secretPrompt.ts";

const XAI_API_BASE = "https://api.x.ai/v1";
const XAI_KEYS_URL = "https://console.x.ai/";
const VALIDATION_USER_AGENT = "Clanky (clanky-pi, validate)";

interface XAiValidationSuccess {
	ok: true;
	modelCount?: number;
	sampleModel?: string;
}

interface XAiValidationFailure {
	ok: false;
	status: number;
	message: string;
}

type XAiValidationResult = XAiValidationSuccess | XAiValidationFailure;

export interface XAiAuthCommandDeps {
	authStorage: AuthStorage;
	authFilePath: string;
	providerId?: string;
}

export async function validateXAiApiKey(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<XAiValidationResult> {
	let response: Response;
	try {
		response = await fetchImpl(`${XAI_API_BASE}/models`, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"User-Agent": VALIDATION_USER_AGENT,
			},
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, status: 0, message: `Network error contacting xAI: ${message}` };
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
	const result: XAiValidationSuccess = { ok: true };
	if (data !== undefined) result.modelCount = data.length;
	if (typeof id === "string" && id.length > 0) result.sampleModel = id;
	return result;
}

function loginInstructions(): string {
	return [
		"Paste an xAI API key. Clanky will validate it with xAI and store it in this profile.",
		"",
		`Create or rotate keys at ${XAI_KEYS_URL}`,
		"",
		"Stored API keys use provider id xai, used by Grok Imagine image and video tools.",
		"The XAI_API_KEY environment variable still takes precedence when set.",
	].join("\n");
}

async function runXAiLogin(deps: XAiAuthCommandDeps, ctx: ExtensionCommandContext): Promise<void> {
	const providerId = resolveXAiProviderId(deps);
	const existing = deps.authStorage.get(providerId);
	if (existing !== undefined) {
		const replace = await ctx.ui.confirm(
			"Replace stored xAI credential?",
			`Provider "${providerId}" already has a stored ${existing.type} credential.`,
		);
		if (!replace) {
			ctx.ui.notify("xAI login cancelled; existing credential left unchanged.");
			return;
		}
	}

	ctx.ui.notify(loginInstructions());

	const apiKey = (
		await promptForSecret(ctx.ui, {
			title: "Paste xAI API key:",
			subtitle: "(input is masked; key is validated before saving)",
		})
	)?.trim();

	if (apiKey === undefined || apiKey.length === 0) {
		ctx.ui.notify("xAI login cancelled (no key entered).");
		return;
	}

	ctx.ui.notify("Validating xAI API key...");
	const validation = await validateXAiApiKey(apiKey);
	if (!validation.ok) {
		ctx.ui.notify(`xAI login failed: ${validation.message}`, "error");
		return;
	}

	saveStoredXAiApiKey(deps.authStorage, apiKey, providerId);

	const lines = [
		"xAI API key validated and saved.",
		`Stored in ${deps.authFilePath} (provider id "${providerId}", perms 0600).`,
	];
	if (validation.modelCount !== undefined) lines.push(`Models endpoint returned ${validation.modelCount} model(s).`);
	if (validation.sampleModel !== undefined) lines.push(`Sample model: ${validation.sampleModel}.`);
	if (process.env.XAI_API_KEY?.trim()) {
		lines.push("XAI_API_KEY is set and will take precedence until removed from the launch environment.");
	}
	lines.push("Reloading session to refresh xAI media auth.");
	ctx.ui.notify(lines.join("\n"));

	await ctx.reload();
}

async function runXAiLogout(deps: XAiAuthCommandDeps, ctx: ExtensionCommandContext): Promise<void> {
	const providerId = resolveXAiProviderId(deps);
	const existing = deps.authStorage.get(providerId);
	if (existing === undefined) {
		ctx.ui.notify(`No stored xAI credential under provider "${providerId}".`);
		return;
	}

	const removed = removeStoredXAiCredential(deps.authStorage, providerId);
	if (!removed) {
		ctx.ui.notify("xAI logout: nothing to remove.");
		return;
	}

	const lines = [
		`Removed stored xAI ${existing.type} credential from ${deps.authFilePath}.`,
		"Environment variable XAI_API_KEY, if set, is unchanged and still takes precedence.",
		"Reloading session to refresh xAI media auth.",
	];
	ctx.ui.notify(lines.join("\n"));
	await ctx.reload();
}

function runXAiWhoami(deps: XAiAuthCommandDeps, ctx: ExtensionCommandContext): void {
	const providerId = resolveXAiProviderId(deps);
	const status = getXAiCredentialStatus(process.env, deps.authStorage, providerId);
	const lines: string[] = [];

	if (status.env.xaiApiKey) {
		lines.push("XAI_API_KEY env var is set (takes precedence).");
	}
	if (status.stored === undefined) {
		lines.push(`No stored xAI credential under provider "${providerId}".`);
	} else {
		lines.push(`Stored xAI credential type: ${status.stored.type}.`);
		lines.push(`Stored in ${deps.authFilePath} (provider id "${providerId}").`);
	}
	if (status.activeSource !== undefined) {
		lines.push(`Active xAI credential source: ${status.activeSource}.`);
	}
	if (!status.available) {
		lines.push("Run /xai-login to configure an API key interactively.");
	}

	ctx.ui.notify(lines.join("\n"));
}

export function createXAiAuthExtensionFactory(deps: XAiAuthCommandDeps): ExtensionFactory {
	return (pi) => {
		pi.registerCommand("xai-login", {
			description: "Configure an xAI API key interactively for this Clanky profile",
			handler: async (_args, ctx) => {
				try {
					await runXAiLogin(deps, ctx);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`xAI login error: ${message}`, "error");
				}
			},
		});
		pi.registerCommand("xai-logout", {
			description: "Remove the stored xAI credential from this Clanky profile",
			handler: async (_args, ctx) => {
				try {
					await runXAiLogout(deps, ctx);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`xAI logout error: ${message}`, "error");
				}
			},
		});
		pi.registerCommand("xai-whoami", {
			description: "Show which xAI credential Clanky will use",
			handler: async (_args, ctx) => {
				try {
					runXAiWhoami(deps, ctx);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`xAI whoami error: ${message}`, "error");
				}
			},
		});
	};
}

function resolveXAiProviderId(deps: XAiAuthCommandDeps): string {
	return deps.providerId?.trim() || DEFAULT_XAI_PROVIDER_ID;
}

function summarizeBody(bodyText: string): string {
	if (bodyText.length === 0) return "";
	try {
		const parsed = JSON.parse(bodyText) as unknown;
		const message = extractXAiErrorMessage(parsed);
		if (message !== undefined) return `: ${message}`;
	} catch {
		// Fall through to raw text summary.
	}
	return `: ${bodyText.replace(/\s+/g, " ").slice(0, 240)}`;
}

function extractXAiErrorMessage(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const error = (value as Record<string, unknown>).error;
	if (typeof error === "string" && error.length > 0) return error;
	if (typeof error !== "object" || error === null) return undefined;
	const message = (error as Record<string, unknown>).message;
	return typeof message === "string" && message.length > 0 ? message : undefined;
}
