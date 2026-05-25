import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { OAuthCredential } from "@earendil-works/pi-coding-agent";

export const OPENAI_CODEX_OAUTH_PROVIDER = "openai-codex";

const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_OPENAI_OAUTH_ISSUER = "https://auth.openai.com";
const OPENAI_ACCOUNT_CLAIM = "https://api.openai.com/auth";
const DEFAULT_LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

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

export interface StartOpenAiCodexOAuthOptions {
	issuerBaseUrl?: string;
	loginTimeoutMs?: number;
	tokenUrl?: string;
}

interface DeviceAuthResponse {
	deviceAuthId: string;
	expiresAt: number;
	intervalMs: number;
	userCode: string;
	verificationUrl: string;
}

interface AuthorizationCodeResponse {
	authorizationCode: string;
	codeVerifier: string;
}

interface TokenExchangeResponse {
	accessToken: string;
	expires: number;
	refreshToken: string;
}

export async function startOpenAiCodexOAuthLogin(
	options: StartOpenAiCodexOAuthOptions = {},
): Promise<StartedModelOAuthLogin> {
	const issuer = normalizeIssuer(options.issuerBaseUrl);
	const controller = new AbortController();
	const deviceAuth = await requestDeviceAuth(issuer, controller.signal);
	const loginId = randomUUID();
	const completion = completeOpenAiCodexLogin(issuer, deviceAuth, controller.signal, options).then((credential) => ({
		credential,
		provider: OPENAI_CODEX_OAUTH_PROVIDER,
	}));

	return {
		cancel: () => controller.abort(),
		completion,
		info: {
			expiresAt: new Date(deviceAuth.expiresAt).toISOString(),
			instructions: "Open the URL, enter the code, then wait for Clanky to finish the login.",
			intervalSeconds: Math.ceil(deviceAuth.intervalMs / 1000),
			loginId,
			provider: OPENAI_CODEX_OAUTH_PROVIDER,
			providerName: "OpenAI Codex",
			userCode: deviceAuth.userCode,
			verificationUrl: deviceAuth.verificationUrl,
		},
		loginId,
	};
}

async function completeOpenAiCodexLogin(
	issuer: string,
	deviceAuth: DeviceAuthResponse,
	signal: AbortSignal,
	options: StartOpenAiCodexOAuthOptions,
): Promise<OAuthCredential> {
	const timeoutAt = Math.min(deviceAuth.expiresAt, Date.now() + (options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS));
	const authorization = await pollForAuthorizationCode(issuer, deviceAuth, timeoutAt, signal);
	const token = await exchangeAuthorizationCode(issuer, authorization, signal, options);
	const credential: OAuthCredential = {
		type: "oauth",
		access: token.accessToken,
		refresh: token.refreshToken,
		expires: token.expires,
	};
	const accountId = accountIdFromToken(token.accessToken);
	if (accountId !== undefined) credential.accountId = accountId;
	return credential;
}

async function requestDeviceAuth(issuer: string, signal: AbortSignal): Promise<DeviceAuthResponse> {
	const payload = await postJson(
		`${issuer}/api/accounts/deviceauth/usercode`,
		{ client_id: OPENAI_OAUTH_CLIENT_ID },
		signal,
	);
	const userCode = readString(payload.user_code, "OpenAI device auth user_code");
	const deviceAuthId = readString(payload.device_auth_id, "OpenAI device auth device_auth_id");
	const intervalSeconds = readPositiveNumber(payload.interval, 5);
	const expiresInSeconds = readPositiveNumber(payload.expires_in, DEFAULT_LOGIN_TIMEOUT_MS / 1000);
	const verificationUrl =
		readOptionalString(payload.verification_uri) ??
		readOptionalString(payload.verification_url) ??
		readOptionalString(payload.device_url) ??
		`${issuer}/codex/device`;
	return {
		deviceAuthId,
		expiresAt: Date.now() + expiresInSeconds * 1000,
		intervalMs: Math.max(1, intervalSeconds) * 1000,
		userCode,
		verificationUrl,
	};
}

async function pollForAuthorizationCode(
	issuer: string,
	deviceAuth: DeviceAuthResponse,
	timeoutAt: number,
	signal: AbortSignal,
): Promise<AuthorizationCodeResponse> {
	while (Date.now() < timeoutAt) {
		await delay(deviceAuth.intervalMs, undefined, { signal });
		const response = await fetch(`${issuer}/api/accounts/deviceauth/token`, {
			body: JSON.stringify({
				device_auth_id: deviceAuth.deviceAuthId,
				user_code: deviceAuth.userCode,
			}),
			headers: { "Content-Type": "application/json" },
			method: "POST",
			signal,
		});
		if (response.status === 403 || response.status === 404) continue;
		const payload = await readJsonResponse(response, "OpenAI device auth polling");
		if (!response.ok) {
			const code = readOptionalString(payload.error) ?? readOptionalString(payload.code);
			if (code === "authorization_pending" || code === "slow_down") continue;
			throw new Error(errorMessage("OpenAI device auth polling", response.status, payload));
		}
		return {
			authorizationCode: readString(payload.authorization_code, "OpenAI authorization_code"),
			codeVerifier: readString(payload.code_verifier, "OpenAI code_verifier"),
		};
	}
	throw new Error("OpenAI OAuth login timed out before authorization completed");
}

async function exchangeAuthorizationCode(
	issuer: string,
	authorization: AuthorizationCodeResponse,
	signal: AbortSignal,
	options: StartOpenAiCodexOAuthOptions,
): Promise<TokenExchangeResponse> {
	const tokenUrl = normalizeTokenUrl(issuer, options.tokenUrl);
	const response = await fetch(tokenUrl, {
		body: new URLSearchParams({
			client_id: OPENAI_OAUTH_CLIENT_ID,
			code: authorization.authorizationCode,
			code_verifier: authorization.codeVerifier,
			grant_type: "authorization_code",
			redirect_uri: `${issuer}/deviceauth/callback`,
		}),
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		method: "POST",
		signal,
	});
	const payload = await readJsonResponse(response, "OpenAI token exchange");
	if (!response.ok) throw new Error(errorMessage("OpenAI token exchange", response.status, payload));
	const accessToken = readString(payload.access_token, "OpenAI access_token");
	const refreshToken = readString(payload.refresh_token, "OpenAI refresh_token");
	const expiresIn = readOptionalNumber(payload.expires_in);
	return {
		accessToken,
		expires: expiresIn === undefined ? expiresFromToken(accessToken) : Date.now() + expiresIn * 1000,
		refreshToken,
	};
}

async function postJson(
	url: string,
	body: Record<string, string>,
	signal: AbortSignal,
): Promise<Record<string, unknown>> {
	const response = await fetch(url, {
		body: JSON.stringify(body),
		headers: { "Content-Type": "application/json" },
		method: "POST",
		signal,
	});
	const payload = await readJsonResponse(response, url);
	if (!response.ok) throw new Error(errorMessage(url, response.status, payload));
	return payload;
}

async function readJsonResponse(response: Response, label: string): Promise<Record<string, unknown>> {
	let parsed: unknown;
	try {
		parsed = await response.json();
	} catch (error) {
		throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${label} returned a non-object JSON response`);
	}
	return parsed as Record<string, unknown>;
}

function errorMessage(label: string, status: number, payload: Record<string, unknown>): string {
	const nested = payload.error;
	if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
		const message = (nested as Record<string, unknown>).message;
		if (typeof message === "string" && message.trim().length > 0) {
			return `${label} failed with status ${status}: ${message.trim()}`;
		}
	}
	const description = readOptionalString(payload.error_description) ?? readOptionalString(payload.message);
	if (description !== undefined) return `${label} failed with status ${status}: ${description}`;
	return `${label} failed with status ${status}`;
}

function normalizeIssuer(value: string | undefined): string {
	const issuer = value?.trim().replace(/\/+$/, "") || DEFAULT_OPENAI_OAUTH_ISSUER;
	if (!issuer.startsWith("https://") && !issuer.startsWith("http://")) {
		throw new Error(`Invalid OpenAI OAuth issuer URL: ${value}`);
	}
	return issuer;
}

function normalizeTokenUrl(issuer: string, value: string | undefined): string {
	const tokenUrl = value?.trim().replace(/\/+$/, "") || `${issuer}/oauth/token`;
	if (!tokenUrl.startsWith("https://") && !tokenUrl.startsWith("http://")) {
		throw new Error(`Invalid OpenAI OAuth token URL: ${value}`);
	}
	return tokenUrl;
}

function readString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
	return value.trim();
}

function readOptionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length === 0 ? undefined : trimmed;
}

function readPositiveNumber(value: unknown, fallback: number): number {
	const parsed = typeof value === "string" ? Number.parseFloat(value) : value;
	return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readOptionalNumber(value: unknown): number | undefined {
	const parsed = typeof value === "string" ? Number.parseFloat(value) : value;
	return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function expiresFromToken(accessToken: string): number {
	const claims = decodeJwtClaims(accessToken);
	const exp = claims.exp;
	if (typeof exp === "number" && Number.isFinite(exp) && exp > 0) return exp * 1000;
	return Date.now() + 60 * 60 * 1000;
}

function accountIdFromToken(accessToken: string): string | undefined {
	const claims = decodeJwtClaims(accessToken);
	const auth = claims[OPENAI_ACCOUNT_CLAIM];
	if (typeof auth !== "object" || auth === null || Array.isArray(auth)) return undefined;
	const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
	return typeof accountId === "string" && accountId.trim().length > 0 ? accountId.trim() : undefined;
}

function decodeJwtClaims(token: string): Record<string, unknown> {
	const parts = token.split(".");
	if (parts.length !== 3) return {};
	const payload = parts[1];
	if (payload === undefined) return {};
	try {
		const padded = `${payload}${"=".repeat((4 - (payload.length % 4)) % 4)}`;
		const decoded = JSON.parse(Buffer.from(padded, "base64url").toString("utf8")) as unknown;
		return typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)
			? (decoded as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}
