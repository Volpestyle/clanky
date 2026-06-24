import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	ConnectionAuthorizationFailedError,
	ConnectionAuthorizationRequiredError,
	defineInteractiveAuthorization,
	type ConnectionPrincipal,
	type TokenResult,
} from "eve/connections";
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { resolveClankyDataPath } from "./paths.ts";

export interface McpOAuthConnectionConfig {
	connectionName: string;
	serverUrl: string;
	displayName: string;
	clientName: string;
	clientUri?: string;
	scope?: string;
	clientMetadataUrlEnv?: string;
}

export type McpOAuthResume = {
	readonly [key: string]: string | null;
	readonly redirectUrl: string;
	readonly state: string | null;
};

interface McpOAuthStore {
	connections?: Record<string, Record<string, StoredMcpOAuthEntry>>;
}

interface StoredMcpOAuthEntry {
	clientInformation?: OAuthClientInformationMixed;
	tokens?: OAuthTokens;
	tokenExpiresAt?: number;
	codeVerifier?: string;
	state?: string;
	redirectUrl?: string;
	discoveryState?: OAuthDiscoveryState;
}

const EXPIRY_SKEW_MS = 60_000;

export function defineMcpOAuthAuthorization(config: McpOAuthConnectionConfig) {
	return defineInteractiveAuthorization<McpOAuthResume>({
		getToken: async ({ principal }) => {
			const token = await getStoredMcpOAuthToken(config, principal);
			if (token !== undefined) return token;
			throw new ConnectionAuthorizationRequiredError(config.connectionName);
		},
		startAuthorization: async ({ principal, callbackUrl }) => {
			const provider = new PersistentMcpOAuthProvider(config, principal, callbackUrl);
			const result = await auth(provider, { serverUrl: config.serverUrl });
			if (result !== "REDIRECT" || provider.authorizationUrl === undefined) {
				const token = await provider.tokenResult();
				if (token !== undefined) {
					return {
						challenge: {
							displayName: config.displayName,
							instructions: `${config.displayName} is already authorized. Retry the requested action.`,
						},
						resume: { redirectUrl: callbackUrl, state: provider.authorizationState ?? null },
					};
				}
				throw new ConnectionAuthorizationFailedError(config.connectionName, {
					reason: "authorization_not_started",
				});
			}
			return {
				challenge: {
					url: provider.authorizationUrl.toString(),
					displayName: config.displayName,
					instructions: `Authorize Clanky to use ${config.displayName}.`,
				},
				resume: { redirectUrl: callbackUrl, state: provider.authorizationState ?? null },
			};
		},
		completeAuthorization: async ({ principal, callback, callbackUrl, resume }) => {
			const callbackError = callback.params.error;
			if (callbackError !== undefined) {
				throw new ConnectionAuthorizationFailedError(config.connectionName, {
					reason: callbackError,
					retryable: callbackError !== "access_denied",
				});
			}
			const code = callback.params.code;
			if (code === undefined || code.length === 0) {
				throw new ConnectionAuthorizationFailedError(config.connectionName, { reason: "missing_code" });
			}
			const actualState = callback.params.state ?? null;
			const expectedState = resume?.state ?? (await readStoredEntry(config.connectionName, principalStoreKey(principal)))?.state ?? null;
			if (expectedState !== null && actualState !== expectedState) {
				throw new ConnectionAuthorizationFailedError(config.connectionName, {
					reason: "state_mismatch",
					retryable: false,
				});
			}
			const provider = new PersistentMcpOAuthProvider(config, principal, resume?.redirectUrl ?? callbackUrl);
			try {
				const result = await auth(provider, { serverUrl: config.serverUrl, authorizationCode: code });
				if (result !== "AUTHORIZED") {
					throw new ConnectionAuthorizationFailedError(config.connectionName, { reason: "token_exchange_incomplete" });
				}
				const token = await provider.tokenResult();
				if (token === undefined) {
					throw new ConnectionAuthorizationFailedError(config.connectionName, { reason: "missing_token" });
				}
				return token;
			} catch (error) {
				if (error instanceof ConnectionAuthorizationFailedError) throw error;
				throw new ConnectionAuthorizationFailedError(config.connectionName, {
					message: error instanceof Error ? error.message : String(error),
					reason: "token_exchange_failed",
				});
			}
		},
		evict: async ({ principal }) => {
			await updateStoredEntry(config.connectionName, principalStoreKey(principal), (entry) => ({
				...entry,
				tokens: undefined,
				tokenExpiresAt: undefined,
			})).catch(() => undefined);
		},
	});
}

async function getStoredMcpOAuthToken(
	config: McpOAuthConnectionConfig,
	principal: ConnectionPrincipal,
): Promise<TokenResult | undefined> {
	const principalKey = principalStoreKey(principal);
	const entry = await readStoredEntry(config.connectionName, principalKey);
	const cached = tokenResultFromEntry(entry);
	if (cached !== undefined) return cached;
	if (entry?.tokens?.refresh_token === undefined || entry.clientInformation === undefined || entry.redirectUrl === undefined) {
		return undefined;
	}
	const provider = new PersistentMcpOAuthProvider(config, principal, entry.redirectUrl);
	try {
		const result = await auth(provider, { serverUrl: config.serverUrl });
		if (result !== "AUTHORIZED") return undefined;
		return await provider.tokenResult();
	} catch {
		await updateStoredEntry(config.connectionName, principalKey, (stored) => ({
			...stored,
			tokens: undefined,
			tokenExpiresAt: undefined,
		}));
		return undefined;
	}
}

class PersistentMcpOAuthProvider implements OAuthClientProvider {
	private readonly config: McpOAuthConnectionConfig;
	private readonly principalKey: string;
	private readonly redirect: string;
	private authorizationRedirect?: URL;
	private requestedState?: string;

	constructor(config: McpOAuthConnectionConfig, principal: ConnectionPrincipal, redirectUrl: string) {
		this.config = config;
		this.principalKey = principalStoreKey(principal);
		this.redirect = redirectUrl;
	}

	get redirectUrl(): string {
		return this.redirect;
	}

	get clientMetadataUrl(): string | undefined {
		return this.config.clientMetadataUrlEnv === undefined ? undefined : process.env[this.config.clientMetadataUrlEnv]?.trim() || undefined;
	}

	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: this.config.clientName,
			redirect_uris: [this.redirect],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "client_secret_post",
			...(this.config.clientUri === undefined ? {} : { client_uri: this.config.clientUri }),
			...(this.config.scope === undefined ? {} : { scope: this.config.scope }),
		};
	}

	get authorizationUrl(): URL | undefined {
		return this.authorizationRedirect;
	}

	get authorizationState(): string | undefined {
		return this.requestedState;
	}

	async state(): Promise<string> {
		const state = randomUUID();
		this.requestedState = state;
		await updateStoredEntry(this.config.connectionName, this.principalKey, (entry) => ({ ...entry, state }));
		return state;
	}

	async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
		return (await this.entry())?.clientInformation;
	}

	async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
		await updateStoredEntry(this.config.connectionName, this.principalKey, (entry) => ({ ...entry, clientInformation }));
	}

	async tokens(): Promise<OAuthTokens | undefined> {
		return (await this.entry())?.tokens;
	}

	async saveTokens(tokens: OAuthTokens): Promise<void> {
		await updateStoredEntry(this.config.connectionName, this.principalKey, (entry) => {
			// Many OAuth servers omit refresh_token on refresh unless they rotate it.
			// Keep the prior refresh token so the next expiry can refresh again
			// instead of forcing a full reauthorization.
			const merged: OAuthTokens =
				tokens.refresh_token === undefined && entry.tokens?.refresh_token !== undefined
					? { ...tokens, refresh_token: entry.tokens.refresh_token }
					: tokens;
			return { ...entry, tokens: merged, tokenExpiresAt: expiresAtForTokens(merged) };
		});
	}

	async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
		this.authorizationRedirect = authorizationUrl;
		await updateStoredEntry(this.config.connectionName, this.principalKey, (entry) => ({
			...entry,
			redirectUrl: this.redirect,
		}));
	}

	async saveCodeVerifier(codeVerifier: string): Promise<void> {
		await updateStoredEntry(this.config.connectionName, this.principalKey, (entry) => ({ ...entry, codeVerifier }));
	}

	async codeVerifier(): Promise<string> {
		const verifier = (await this.entry())?.codeVerifier;
		if (verifier === undefined) throw new Error(`No OAuth PKCE verifier saved for ${this.config.connectionName}.`);
		return verifier;
	}

	async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
		await updateStoredEntry(this.config.connectionName, this.principalKey, (entry) => ({ ...entry, discoveryState }));
	}

	async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
		return (await this.entry())?.discoveryState;
	}

	async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
		await updateStoredEntry(this.config.connectionName, this.principalKey, (entry) => invalidateEntry(entry, scope));
	}

	async tokenResult(): Promise<TokenResult | undefined> {
		return tokenResultFromEntry(await this.entry());
	}

	private async entry(): Promise<StoredMcpOAuthEntry | undefined> {
		return await readStoredEntry(this.config.connectionName, this.principalKey);
	}
}

function invalidateEntry(entry: StoredMcpOAuthEntry, scope: "all" | "client" | "tokens" | "verifier" | "discovery"): StoredMcpOAuthEntry {
	if (scope === "all") return {};
	return {
		...entry,
		...(scope === "client" ? { clientInformation: undefined } : {}),
		...(scope === "tokens" ? { tokens: undefined, tokenExpiresAt: undefined } : {}),
		...(scope === "verifier" ? { codeVerifier: undefined, state: undefined } : {}),
		...(scope === "discovery" ? { discoveryState: undefined } : {}),
	};
}

function tokenResultFromEntry(entry: StoredMcpOAuthEntry | undefined): TokenResult | undefined {
	if (entry?.tokens?.access_token === undefined) return undefined;
	if (entry.tokenExpiresAt !== undefined && entry.tokenExpiresAt <= Date.now() + EXPIRY_SKEW_MS) return undefined;
	return {
		token: entry.tokens.access_token,
		...(entry.tokenExpiresAt === undefined ? {} : { expiresAt: entry.tokenExpiresAt }),
	};
}

function expiresAtForTokens(tokens: OAuthTokens): number | undefined {
	return tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000;
}

async function readStoredEntry(connectionName: string, principalKey: string): Promise<StoredMcpOAuthEntry | undefined> {
	const store = await readOAuthStore();
	return store.connections?.[connectionName]?.[principalKey];
}

async function updateStoredEntry(
	connectionName: string,
	principalKey: string,
	update: (entry: StoredMcpOAuthEntry) => StoredMcpOAuthEntry,
): Promise<StoredMcpOAuthEntry> {
	const store = await readOAuthStore();
	const connections = { ...(store.connections ?? {}) };
	const principals = { ...(connections[connectionName] ?? {}) };
	const next = update(principals[principalKey] ?? {});
	principals[principalKey] = next;
	connections[connectionName] = principals;
	await writeOAuthStore({ connections });
	return next;
}

async function readOAuthStore(): Promise<McpOAuthStore> {
	try {
		const raw = await readFile(oauthStorePath(), "utf8");
		const parsed = JSON.parse(raw) as McpOAuthStore;
		return { connections: parsed.connections ?? {} };
	} catch (error) {
		if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") {
			return { connections: {} };
		}
		throw error;
	}
}

async function writeOAuthStore(store: McpOAuthStore): Promise<void> {
	const path = oauthStorePath();
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(path, `${JSON.stringify(store, null, "\t")}\n`, { mode: 0o600 });
}

function oauthStorePath(): string {
	return resolveClankyDataPath("connections/mcp-oauth.json");
}

function principalStoreKey(principal: ConnectionPrincipal): string {
	if (principal.type === "app") return "app";
	return `user:${encodeURIComponent(principal.issuer)}:${encodeURIComponent(principal.id)}`;
}
