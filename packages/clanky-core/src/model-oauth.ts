import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
	getOAuthProvider,
	getOAuthProviders,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type OAuthProviderInterface,
} from "@earendil-works/pi-ai/oauth";
import type { OAuthCredential } from "@earendil-works/pi-coding-agent";

export const OPENAI_CODEX_OAUTH_PROVIDER = "openai-codex";
export const ANTHROPIC_OAUTH_PROVIDER = "anthropic";
export const GITHUB_COPILOT_OAUTH_PROVIDER = "github-copilot";

const DEFAULT_LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_OAUTH_INTERVAL_SECONDS = 5;
const ONAUTH_WAIT_TIMEOUT_MS = 30_000;

export interface ModelOAuthBeginResult {
	expiresAt: string;
	instructions: string;
	intervalSeconds: number;
	loginId: string;
	provider: string;
	providerName: string;
	userCode: string;
	verificationUrl: string;
}

export interface ModelOAuthCredentialResult {
	credential: OAuthCredential;
	provider: string;
}

export interface StartedModelOAuthLogin {
	cancel(): void;
	completion: Promise<ModelOAuthCredentialResult>;
	info: ModelOAuthBeginResult;
	loginId: string;
}

export interface StartProviderOAuthOptions {
	loginTimeoutMs?: number;
}

export async function startProviderOAuthLogin(
	providerId: string,
	options: StartProviderOAuthOptions = {},
): Promise<StartedModelOAuthLogin> {
	const provider = getOAuthProvider(providerId);
	if (provider === undefined) {
		throw new Error(`Unsupported OAuth provider: ${providerId}`);
	}
	return await startPiProviderLogin(provider, options);
}

async function startPiProviderLogin(
	provider: OAuthProviderInterface,
	options: StartProviderOAuthOptions,
): Promise<StartedModelOAuthLogin> {
	const controller = new AbortController();
	const loginId = randomUUID();
	const expiresAt = new Date(Date.now() + (options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS)).toISOString();

	let resolveAuth!: (info: { url: string; instructions?: string }) => void;
	let rejectAuth!: (reason: unknown) => void;
	const authReady = new Promise<{ url: string; instructions?: string }>((resolve, reject) => {
		resolveAuth = resolve;
		rejectAuth = reject;
	});

	const callbacks: OAuthLoginCallbacks = {
		onAuth: (info) => resolveAuth(info),
		onPrompt: async () => await waitForever(controller.signal),
		signal: controller.signal,
	};

	const loginPromise = provider.login(callbacks).catch((error: unknown) => {
		rejectAuth(error);
		throw error;
	});

	const authInfo = await Promise.race([
		authReady,
		delay(ONAUTH_WAIT_TIMEOUT_MS, undefined, { signal: controller.signal }).then(() => {
			throw new Error(`OAuth provider ${provider.id} did not produce an auth URL within ${ONAUTH_WAIT_TIMEOUT_MS}ms`);
		}),
	]);

	const completion = loginPromise.then((credentials) => piCredentialsToResult(provider.id, credentials));

	return {
		cancel: () => controller.abort(),
		completion,
		info: {
			expiresAt,
			instructions: authInfo.instructions ?? `Open the URL to complete ${provider.name} login.`,
			intervalSeconds: DEFAULT_OAUTH_INTERVAL_SECONDS,
			loginId,
			provider: provider.id,
			providerName: provider.name,
			userCode: authInfo.instructions ?? "",
			verificationUrl: authInfo.url,
		},
		loginId,
	};
}

function piCredentialsToResult(providerId: string, credentials: OAuthCredentials): ModelOAuthCredentialResult {
	const credential: OAuthCredential = { type: "oauth", ...credentials };
	return { credential, provider: providerId };
}

async function waitForever(signal: AbortSignal): Promise<string> {
	return await new Promise<string>((_resolve, reject) => {
		const onAbort = () => reject(new Error("OAuth login cancelled"));
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export interface AuthProviderInfo {
	id: string;
	name: string;
	supportsOAuth: boolean;
	supportsApiKey: boolean;
}

const API_KEY_PROVIDERS: ReadonlyArray<{ id: string; name: string }> = [
	{ id: "anthropic", name: "Anthropic" },
	{ id: "openai", name: "OpenAI" },
	{ id: "openai-codex", name: "OpenAI Codex" },
	{ id: "google", name: "Google" },
	{ id: "google-vertex", name: "Google Vertex" },
	{ id: "mistral", name: "Mistral" },
	{ id: "azure-openai-responses", name: "Azure OpenAI" },
	{ id: "cloudflare", name: "Cloudflare" },
	{ id: "github-copilot", name: "GitHub Copilot" },
];

export function listAuthProviderInfos(): AuthProviderInfo[] {
	const oauthProviders = new Map<string, OAuthProviderInterface>();
	for (const provider of getOAuthProviders()) oauthProviders.set(provider.id, provider);
	const result = new Map<string, AuthProviderInfo>();
	for (const entry of API_KEY_PROVIDERS) {
		result.set(entry.id, {
			id: entry.id,
			name: entry.name,
			supportsApiKey: true,
			supportsOAuth: oauthProviders.has(entry.id),
		});
	}
	for (const [id, provider] of oauthProviders) {
		const existing = result.get(id);
		if (existing === undefined) {
			result.set(id, {
				id,
				name: provider.name,
				supportsApiKey: false,
				supportsOAuth: true,
			});
		} else {
			result.set(id, { ...existing, name: existing.name === id ? provider.name : existing.name, supportsOAuth: true });
		}
	}
	return Array.from(result.values()).sort((left, right) => left.id.localeCompare(right.id));
}
