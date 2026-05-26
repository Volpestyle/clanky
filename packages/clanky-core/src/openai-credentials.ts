/**
 * OpenAI credential helpers.
 *
 * Pi already understands API-key and OAuth credentials through AuthStorage.
 * Clanky stores interactive OpenAI API keys under the normal `openai`
 * provider id so the model registry, hosted web search, and voice paths can
 * share one profile-scoped credential.
 */
import type { AuthStorage } from "@earendil-works/pi-coding-agent";

export const DEFAULT_OPENAI_PROVIDER_ID = "openai";

export interface ResolvedOpenAiApiKey {
	value: string;
	source: string;
	providerId: string;
}

export interface OpenAiCredentialStatus {
	providerId: string;
	env: {
		openAiApiKey: boolean;
		clankyOpenAiApiKey: boolean;
	};
	stored?: {
		type: "api_key" | "oauth";
	};
	activeSource?: string;
	available: boolean;
}

export function saveStoredOpenAiApiKey(
	authStorage: AuthStorage,
	apiKey: string,
	providerId: string = DEFAULT_OPENAI_PROVIDER_ID,
): void {
	const trimmed = apiKey.trim();
	if (trimmed.length === 0) throw new Error("OpenAI API key must not be empty.");
	authStorage.set(providerId, {
		type: "api_key",
		key: trimmed,
	});
}

export function removeStoredOpenAiCredential(
	authStorage: AuthStorage,
	providerId: string = DEFAULT_OPENAI_PROVIDER_ID,
): boolean {
	if (!authStorage.has(providerId)) return false;
	authStorage.remove(providerId);
	return true;
}

export function getOpenAiCredentialStatus(
	env: NodeJS.ProcessEnv = process.env,
	authStorage?: AuthStorage,
	providerId: string = DEFAULT_OPENAI_PROVIDER_ID,
): OpenAiCredentialStatus {
	const envCredential = resolveOpenAiApiKeyFromEnv(env);
	const credential = authStorage?.get(providerId);
	const stored = credential?.type === "api_key" || credential?.type === "oauth" ? { type: credential.type } : undefined;
	const activeSource =
		envCredential?.source ??
		(stored !== undefined ? `stored:${stored.type}` : authStorage?.getAuthStatus(providerId).source);
	return {
		providerId,
		env: {
			openAiApiKey: hasNonEmptyEnv(env.OPENAI_API_KEY),
			clankyOpenAiApiKey: hasNonEmptyEnv(env.CLANKY_OPENAI_API_KEY),
		},
		...(stored === undefined ? {} : { stored }),
		...(activeSource === undefined ? {} : { activeSource }),
		available: envCredential !== undefined || stored !== undefined || authStorage?.hasAuth(providerId) === true,
	};
}

export async function resolveOpenAiApiKey(
	env: NodeJS.ProcessEnv = process.env,
	authStorage?: AuthStorage,
	providerId: string = DEFAULT_OPENAI_PROVIDER_ID,
): Promise<ResolvedOpenAiApiKey | undefined> {
	const envCredential = resolveOpenAiApiKeyFromEnv(env, providerId);
	if (envCredential !== undefined) return envCredential;

	if (authStorage === undefined) return undefined;
	const status = authStorage.getAuthStatus(providerId);
	const credential = authStorage.get(providerId);
	const resolved = (await authStorage.getApiKey(providerId, { includeFallback: false }))?.trim();
	if (resolved === undefined || resolved.length === 0) return undefined;
	const source =
		credential?.type === "api_key" || credential?.type === "oauth"
			? `stored:${credential.type}`
			: (status.source ?? "auth_storage");
	return { value: resolved, source, providerId };
}

export function resolveOpenAiApiKeySync(
	env: NodeJS.ProcessEnv = process.env,
	authStorage?: AuthStorage,
	providerId: string = DEFAULT_OPENAI_PROVIDER_ID,
): ResolvedOpenAiApiKey | undefined {
	const envCredential = resolveOpenAiApiKeyFromEnv(env, providerId);
	if (envCredential !== undefined) return envCredential;

	const credential = authStorage?.get(providerId);
	if (credential?.type !== "api_key") return undefined;
	const value = credential.key.trim();
	return value.length > 0 ? { value, source: "stored:api_key", providerId } : undefined;
}

function resolveOpenAiApiKeyFromEnv(
	env: NodeJS.ProcessEnv,
	providerId: string = DEFAULT_OPENAI_PROVIDER_ID,
): ResolvedOpenAiApiKey | undefined {
	const clankyOpenAiKey = env.CLANKY_OPENAI_API_KEY?.trim();
	if (clankyOpenAiKey !== undefined && clankyOpenAiKey.length > 0) {
		return { value: clankyOpenAiKey, source: "env:CLANKY_OPENAI_API_KEY", providerId };
	}

	const openAiKey = env.OPENAI_API_KEY?.trim();
	if (openAiKey !== undefined && openAiKey.length > 0) {
		return { value: openAiKey, source: "env:OPENAI_API_KEY", providerId };
	}

	return undefined;
}

function hasNonEmptyEnv(value: string | undefined): boolean {
	return value !== undefined && value.trim().length > 0;
}
