/**
 * Discord credential storage helpers.
 *
 * Discord tokens (bot or user) are persisted in Clanky's profile AuthStorage
 * under a single provider id (`clanky-discord` by default). They share the
 * same `auth.json` file used for model-provider API keys, so file permissions
 * (`0600`) and locking come from Pi's `FileAuthStorageBackend`.
 *
 * The on-disk shape:
 *
 *   {
 *     "clanky-discord": {
 *       "type": "api_key",
 *       "key": "<JSON-encoded ClankyDiscordCredentialPayload>"
 *     }
 *   }
 *
 * Encoding the structured payload inside `ApiKeyCredential.key` keeps us
 * compatible with Pi's existing storage schema without forking it.
 */
import type { AuthStorage } from "@earendil-works/pi-coding-agent";

export const DEFAULT_CLANKY_DISCORD_PROVIDER_ID = "clanky-discord";

export type ClankyDiscordCredentialKind = "bot-token" | "user-token";

export interface ClankyDiscordCredentialPayload {
	token: string;
	credentialKind: ClankyDiscordCredentialKind;
	conversationId?: string;
	identity?: {
		id: string;
		username: string;
	};
}

export interface ClankyStoredDiscordCredential {
	providerId: string;
	payload: ClankyDiscordCredentialPayload;
}

function isCredentialKind(value: unknown): value is ClankyDiscordCredentialKind {
	return value === "bot-token" || value === "user-token";
}

function parseDiscordPayload(raw: string): ClankyDiscordCredentialPayload | undefined {
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const record = parsed as Record<string, unknown>;
	const token = record.token;
	if (typeof token !== "string" || token.trim().length === 0) return undefined;
	const credentialKind = record.credentialKind;
	if (!isCredentialKind(credentialKind)) return undefined;
	const payload: ClankyDiscordCredentialPayload = {
		token: token.trim(),
		credentialKind,
	};
	if (typeof record.conversationId === "string" && record.conversationId.trim().length > 0) {
		payload.conversationId = record.conversationId.trim();
	}
	const identity = record.identity;
	if (typeof identity === "object" && identity !== null) {
		const idValue = (identity as Record<string, unknown>).id;
		const usernameValue = (identity as Record<string, unknown>).username;
		if (typeof idValue === "string" && typeof usernameValue === "string") {
			payload.identity = { id: idValue, username: usernameValue };
		}
	}
	return payload;
}

/**
 * Read the stored Discord credential payload for a provider id, if any.
 *
 * Returns `undefined` when no credential is stored, when the entry is the
 * wrong shape, or when the JSON payload fails to parse. Does not throw.
 */
export function loadStoredDiscordCredential(
	authStorage: AuthStorage,
	providerId: string = DEFAULT_CLANKY_DISCORD_PROVIDER_ID,
): ClankyStoredDiscordCredential | undefined {
	const credential = authStorage.get(providerId);
	if (credential === undefined || credential.type !== "api_key") return undefined;
	try {
		const payload = parseDiscordPayload(credential.key);
		if (payload === undefined) return undefined;
		return { providerId, payload };
	} catch {
		return undefined;
	}
}

/**
 * Persist a Discord credential payload into AuthStorage. The full payload is
 * JSON-encoded inside `ApiKeyCredential.key` so token + credential kind +
 * optional conversation id round-trip atomically.
 */
export function saveStoredDiscordCredential(
	authStorage: AuthStorage,
	payload: ClankyDiscordCredentialPayload,
	providerId: string = DEFAULT_CLANKY_DISCORD_PROVIDER_ID,
): void {
	authStorage.set(providerId, {
		type: "api_key",
		key: JSON.stringify(payload),
	});
}

/**
 * Remove the stored Discord credential, if present.
 */
export function removeStoredDiscordCredential(
	authStorage: AuthStorage,
	providerId: string = DEFAULT_CLANKY_DISCORD_PROVIDER_ID,
): boolean {
	if (!authStorage.has(providerId)) return false;
	authStorage.remove(providerId);
	return true;
}
