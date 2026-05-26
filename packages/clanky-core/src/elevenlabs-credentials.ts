/**
 * ElevenLabs credential helpers.
 *
 * Discord voice can use ElevenLabs as an external speech provider while
 * keeping OpenAI Realtime for reasoning and tool calls. API keys are stored in
 * the same profile AuthStorage as the other Clanky credentials, under a
 * dedicated provider id so they can be configured from the TUI without env vars.
 */
import type { AuthStorage } from "@earendil-works/pi-coding-agent";

export const DEFAULT_ELEVENLABS_PROVIDER_ID = "elevenlabs";

export interface ResolvedElevenLabsApiKey {
	value: string;
	source: string;
	providerId: string;
}

export interface ElevenLabsCredentialStatus {
	providerId: string;
	env: {
		elevenLabsApiKey: boolean;
		clankyElevenLabsApiKey: boolean;
	};
	stored?: {
		type: "api_key";
	};
	activeSource?: string;
	available: boolean;
}

export function saveStoredElevenLabsApiKey(
	authStorage: AuthStorage,
	apiKey: string,
	providerId: string = DEFAULT_ELEVENLABS_PROVIDER_ID,
): void {
	const trimmed = apiKey.trim();
	if (trimmed.length === 0) throw new Error("ElevenLabs API key must not be empty.");
	authStorage.set(providerId, {
		type: "api_key",
		key: trimmed,
	});
}

export function removeStoredElevenLabsCredential(
	authStorage: AuthStorage,
	providerId: string = DEFAULT_ELEVENLABS_PROVIDER_ID,
): boolean {
	if (!authStorage.has(providerId)) return false;
	authStorage.remove(providerId);
	return true;
}

export function getElevenLabsCredentialStatus(
	env: NodeJS.ProcessEnv = process.env,
	authStorage?: AuthStorage,
	providerId: string = DEFAULT_ELEVENLABS_PROVIDER_ID,
): ElevenLabsCredentialStatus {
	const envCredential = resolveElevenLabsApiKeyFromEnv(env, providerId);
	const credential = authStorage?.get(providerId);
	const stored = credential?.type === "api_key" ? { type: credential.type } : undefined;
	const activeSource = envCredential?.source ?? (stored !== undefined ? "stored:api_key" : undefined);
	return {
		providerId,
		env: {
			elevenLabsApiKey: hasNonEmptyEnv(env.ELEVENLABS_API_KEY),
			clankyElevenLabsApiKey: hasNonEmptyEnv(env.CLANKY_ELEVENLABS_API_KEY),
		},
		...(stored === undefined ? {} : { stored }),
		...(activeSource === undefined ? {} : { activeSource }),
		available: envCredential !== undefined || stored !== undefined,
	};
}

export function resolveElevenLabsApiKeySync(
	env: NodeJS.ProcessEnv = process.env,
	authStorage?: AuthStorage,
	providerId: string = DEFAULT_ELEVENLABS_PROVIDER_ID,
): ResolvedElevenLabsApiKey | undefined {
	const envCredential = resolveElevenLabsApiKeyFromEnv(env, providerId);
	if (envCredential !== undefined) return envCredential;

	const credential = authStorage?.get(providerId);
	if (credential?.type !== "api_key") return undefined;
	const value = credential.key.trim();
	return value.length > 0 ? { value, source: "stored:api_key", providerId } : undefined;
}

function resolveElevenLabsApiKeyFromEnv(
	env: NodeJS.ProcessEnv,
	providerId: string = DEFAULT_ELEVENLABS_PROVIDER_ID,
): ResolvedElevenLabsApiKey | undefined {
	const clankyElevenLabsKey = env.CLANKY_ELEVENLABS_API_KEY?.trim();
	if (clankyElevenLabsKey !== undefined && clankyElevenLabsKey.length > 0) {
		return { value: clankyElevenLabsKey, source: "env:CLANKY_ELEVENLABS_API_KEY", providerId };
	}

	const elevenLabsKey = env.ELEVENLABS_API_KEY?.trim();
	if (elevenLabsKey !== undefined && elevenLabsKey.length > 0) {
		return { value: elevenLabsKey, source: "env:ELEVENLABS_API_KEY", providerId };
	}

	return undefined;
}

function hasNonEmptyEnv(value: string | undefined): boolean {
	return value !== undefined && value.trim().length > 0;
}
