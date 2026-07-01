/**
 * Minimal FCM HTTP v1 sender for Android push notifications (SPEC §4.4).
 *
 * Gated on env; when unconfigured every send is a no-op so the relay keeps
 * running without Firebase credentials:
 *   CLANKY_FCM_SERVICE_ACCOUNT_PATH  Firebase service account JSON path
 *   GOOGLE_APPLICATION_CREDENTIALS   fallback service account JSON path
 *   CLANKY_FCM_PROJECT_ID            target Firebase project id override
 *   CLANKY_FCM_CLIENT_EMAIL          env-only service account email
 *   CLANKY_FCM_PRIVATE_KEY           env-only service account private key
 */
import { createPrivateKey, sign as cryptoSign } from "node:crypto";
import { readFileSync } from "node:fs";

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

export interface FcmConfig {
	projectId: string;
	clientEmail: string;
	privateKey: string;
	tokenUri: string;
}

export interface FcmNotification {
	title: string;
	body: string;
	data?: Record<string, unknown>;
	collapseId?: string;
}

export interface FcmResult {
	ok: boolean;
	status?: number;
	reason?: string;
	name?: string;
}

export interface FcmSendRequest {
	message: {
		token: string;
		notification: {
			title: string;
			body: string;
		};
		data?: Record<string, string>;
		android: {
			priority: "HIGH";
			collapse_key?: string;
			notification: {
				channel_id: string;
				default_sound: true;
				tag?: string;
			};
		};
		fcm_options: {
			analytics_label: string;
		};
	};
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function rec(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseJsonRecord(text: string): Record<string, unknown> {
	const parsed = JSON.parse(text) as unknown;
	const record = rec(parsed);
	if (Object.keys(record).length === 0 && (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))) {
		throw new Error("expected JSON object");
	}
	return record;
}

function normalizePrivateKey(value: string | undefined): string | undefined {
	return value?.replace(/\\n/gu, "\n").trim();
}

export function fcmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FcmConfig | undefined {
	const explicitProjectId = str(env.CLANKY_FCM_PROJECT_ID);
	const explicitClientEmail = str(env.CLANKY_FCM_CLIENT_EMAIL);
	const explicitPrivateKey = normalizePrivateKey(str(env.CLANKY_FCM_PRIVATE_KEY));
	if (explicitProjectId !== undefined && explicitClientEmail !== undefined && explicitPrivateKey !== undefined) {
		return {
			projectId: explicitProjectId,
			clientEmail: explicitClientEmail,
			privateKey: explicitPrivateKey,
			tokenUri: str(env.CLANKY_FCM_TOKEN_URI) ?? DEFAULT_TOKEN_URI,
		};
	}

	const serviceAccountPath = str(env.CLANKY_FCM_SERVICE_ACCOUNT_PATH) ?? str(env.GOOGLE_APPLICATION_CREDENTIALS);
	if (serviceAccountPath === undefined) return undefined;
	try {
		const account = parseJsonRecord(readFileSync(serviceAccountPath, "utf8"));
		const projectId = explicitProjectId ?? str(account.project_id);
		const clientEmail = explicitClientEmail ?? str(account.client_email);
		const privateKey = explicitPrivateKey ?? normalizePrivateKey(str(account.private_key));
		if (projectId === undefined || clientEmail === undefined || privateKey === undefined) return undefined;
		return {
			projectId,
			clientEmail,
			privateKey,
			tokenUri: str(account.token_uri) ?? str(env.CLANKY_FCM_TOKEN_URI) ?? DEFAULT_TOKEN_URI,
		};
	} catch {
		return undefined;
	}
}

export function fcmConfig(): FcmConfig | undefined {
	return fcmConfigFromEnv();
}

export function fcmConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
	return fcmConfigFromEnv(env) !== undefined;
}

function base64url(input: Buffer | string): string {
	return Buffer.from(input).toString("base64url");
}

let cachedAccessToken: { token: string; expiresAtMs: number; cacheKey: string } | undefined;

function serviceAccountJwt(config: FcmConfig): string {
	const now = Math.floor(Date.now() / 1000);
	const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const claims = base64url(
		JSON.stringify({
			iss: config.clientEmail,
			scope: FCM_SCOPE,
			aud: config.tokenUri,
			iat: now,
			exp: now + 3600,
		}),
	);
	const signingInput = `${header}.${claims}`;
	const key = createPrivateKey(config.privateKey);
	const signature = cryptoSign("RSA-SHA256", Buffer.from(signingInput), key);
	return `${signingInput}.${base64url(signature)}`;
}

async function accessToken(config: FcmConfig): Promise<string> {
	const now = Date.now();
	const cacheKey = `${config.clientEmail}\0${config.privateKey}\0${config.tokenUri}`;
	if (cachedAccessToken !== undefined && cachedAccessToken.cacheKey === cacheKey && cachedAccessToken.expiresAtMs > now + 60_000) {
		return cachedAccessToken.token;
	}
	const body = new URLSearchParams({
		grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
		assertion: serviceAccountJwt(config),
	});
	const response = await fetch(config.tokenUri, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body,
	});
	const text = await response.text();
	const parsed = text.trim().length === 0 ? {} : parseJsonRecord(text);
	const token = str(parsed.access_token);
	if (!response.ok || token === undefined) {
		throw new Error(fcmErrorReason(text) ?? response.statusText);
	}
	const expiresIn = num(parsed.expires_in) ?? 3600;
	cachedAccessToken = {
		token,
		expiresAtMs: now + Math.max(60, expiresIn - 60) * 1000,
		cacheKey,
	};
	return token;
}

export function fcmRequestBody(token: string, note: FcmNotification): FcmSendRequest {
	const collapseId = note.collapseId?.slice(0, 64);
	const message: FcmSendRequest["message"] = {
		token,
		notification: { title: note.title, body: note.body },
		android: {
			priority: "HIGH",
			...(collapseId === undefined ? {} : { collapse_key: collapseId }),
			notification: {
				channel_id: "clanky_status",
				default_sound: true,
				...(collapseId === undefined ? {} : { tag: collapseId }),
			},
		},
		fcm_options: { analytics_label: "clanky" },
	};
	const data = stringData(note.data);
	if (data !== undefined) message.data = data;
	return { message };
}

function stringData(data: Record<string, unknown> | undefined): Record<string, string> | undefined {
	if (data === undefined) return undefined;
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(data)) {
		if (value === undefined) continue;
		if (typeof value === "string") out[key] = value;
		else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") out[key] = String(value);
		else out[key] = JSON.stringify(value);
	}
	return Object.keys(out).length === 0 ? undefined : out;
}

export async function sendFcm(token: string, note: FcmNotification, config = fcmConfig()): Promise<FcmResult> {
	if (config === undefined) return { ok: false, reason: "fcm_unconfigured" };
	let bearer: string;
	try {
		bearer = await accessToken(config);
	} catch (error) {
		return { ok: false, reason: `oauth_error: ${(error as Error).message}` };
	}
	try {
		const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/messages:send`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${bearer}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(fcmRequestBody(token, note)),
		});
		const text = await response.text();
		if (response.ok) {
			const parsed = text.trim().length === 0 ? {} : parseJsonRecord(text);
			return { ok: true, status: response.status, name: str(parsed.name) };
		}
		return { ok: false, status: response.status, reason: fcmErrorReason(text) ?? response.statusText };
	} catch (error) {
		return { ok: false, reason: (error as Error).message };
	}
}

function fcmErrorReason(text: string): string | undefined {
	if (text.trim().length === 0) return undefined;
	try {
		const parsed = parseJsonRecord(text);
		const error = rec(parsed.error);
		const details = Array.isArray(error.details) ? error.details : [];
		for (const detail of details) {
			const code = str(rec(detail).errorCode);
			if (code !== undefined) return code;
		}
		return str(error.status) ?? str(error.message) ?? text;
	} catch {
		return text;
	}
}

export function isStaleFcmTokenReason(reason: string): boolean {
	return reason === "UNREGISTERED" || reason === "messaging/registration-token-not-registered";
}
