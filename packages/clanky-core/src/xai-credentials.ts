import type { AuthStorage } from "@earendil-works/pi-coding-agent";

export const DEFAULT_XAI_PROVIDER_ID = "xai";

export interface ResolvedXAiApiKey {
	value: string;
	source: string;
	providerId: string;
}

export interface XAiCredentialStatus {
	providerId: string;
	env: {
		xaiApiKey: boolean;
	};
	stored?: {
		type: "api_key" | "oauth";
	};
	activeSource?: string;
	available: boolean;
}

export function saveStoredXAiApiKey(
	authStorage: AuthStorage,
	apiKey: string,
	providerId: string = DEFAULT_XAI_PROVIDER_ID,
): void {
	const trimmed = apiKey.trim();
	if (trimmed.length === 0) throw new Error("xAI API key must not be empty.");
	authStorage.set(providerId, {
		type: "api_key",
		key: trimmed,
	});
}

export function removeStoredXAiCredential(
	authStorage: AuthStorage,
	providerId: string = DEFAULT_XAI_PROVIDER_ID,
): boolean {
	if (!authStorage.has(providerId)) return false;
	authStorage.remove(providerId);
	return true;
}

export function getXAiCredentialStatus(
	env: NodeJS.ProcessEnv = process.env,
	authStorage?: AuthStorage,
	providerId: string = DEFAULT_XAI_PROVIDER_ID,
): XAiCredentialStatus {
	const envCredential = resolveXAiApiKeyFromEnv(env, providerId);
	const credential = authStorage?.get(providerId);
	const stored = credential?.type === "api_key" || credential?.type === "oauth" ? { type: credential.type } : undefined;
	const activeSource =
		envCredential?.source ??
		(stored !== undefined ? `stored:${stored.type}` : authStorage?.getAuthStatus(providerId).source);
	return {
		providerId,
		env: {
			xaiApiKey: (env.XAI_API_KEY ?? "").trim().length > 0,
		},
		...(stored === undefined ? {} : { stored }),
		...(activeSource === undefined ? {} : { activeSource }),
		available: envCredential !== undefined || stored !== undefined || authStorage?.hasAuth(providerId) === true,
	};
}

export async function resolveXAiApiKey(
	env: NodeJS.ProcessEnv = process.env,
	authStorage?: AuthStorage,
	providerId: string = DEFAULT_XAI_PROVIDER_ID,
): Promise<ResolvedXAiApiKey | undefined> {
	const envCredential = resolveXAiApiKeyFromEnv(env, providerId);
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

export function resolveXAiApiKeySync(
	env: NodeJS.ProcessEnv = process.env,
	authStorage?: AuthStorage,
	providerId: string = DEFAULT_XAI_PROVIDER_ID,
): ResolvedXAiApiKey | undefined {
	const envCredential = resolveXAiApiKeyFromEnv(env, providerId);
	if (envCredential !== undefined) return envCredential;

	const credential = authStorage?.get(providerId);
	if (credential?.type !== "api_key") return undefined;
	const value = credential.key.trim();
	return value.length > 0 ? { value, source: "stored:api_key", providerId } : undefined;
}

function resolveXAiApiKeyFromEnv(
	env: NodeJS.ProcessEnv,
	providerId: string = DEFAULT_XAI_PROVIDER_ID,
): ResolvedXAiApiKey | undefined {
	const apiKey = env.XAI_API_KEY?.trim();
	return apiKey !== undefined && apiKey.length > 0
		? { value: apiKey, source: "env:XAI_API_KEY", providerId }
		: undefined;
}
