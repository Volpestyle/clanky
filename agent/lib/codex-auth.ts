/**
 * OpenAI Codex (ChatGPT subscription) OAuth credential store for Clanky.
 *
 * Browser login flow for minting once via the face's /login or
 * `pnpm codex:login`, refreshing before expiry, and reading valid credentials.
 * The source reference is documented in SPEC.md §4.6.
 *
 * This module intentionally uses the browser callback flow that matches the
 * laptop face.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { generatePkce } from "./oauth-pkce.ts";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const STORE_KEY = "openai-codex";
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PORT = 1455;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/auth/callback`;
const SCOPE = "openid profile email offline_access";
// Refresh a few minutes before the token actually expires.
const REFRESH_SKEW_MS = 5 * 60_000;

export interface CodexCredentials {
	type: "oauth";
	access: string;
	refresh: string;
	/** Epoch milliseconds. */
	expires: number;
	accountId: string;
}

interface RefreshResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	id_token?: string;
}

function authPath(): string {
	return (
		process.env.CLANKY_CODEX_AUTH ??
		join(homedir(), ".clanky", "profiles", "default", "auth.json")
	);
}

/**
 * Pull the ChatGPT account id out of a JWT. The Codex login derives account_id
 * from the id_token (see persist_tokens_async in openai/codex); access tokens
 * usually carry it too, under the same auth claim. Checks the auth claim first,
 * then a top-level chatgpt_account_id (id_token shape). Accepts undefined so
 * callers can chain access-token then id_token.
 */
function decodeAccountId(token: string | undefined): string | null {
	if (token === undefined) return null;
	try {
		const segment = token.split(".")[1] ?? "";
		const payload = JSON.parse(Buffer.from(segment, "base64").toString("utf8")) as Record<string, unknown>;
		const claim = payload[JWT_CLAIM_PATH];
		const fromClaim = typeof claim === "object" && claim !== null ? (claim as { chatgpt_account_id?: unknown }).chatgpt_account_id : undefined;
		const id = typeof fromClaim === "string" && fromClaim.length > 0 ? fromClaim : (payload as { chatgpt_account_id?: unknown }).chatgpt_account_id;
		return typeof id === "string" && id.length > 0 ? id : null;
	} catch {
		return null;
	}
}

async function readStore(): Promise<Record<string, CodexCredentials | undefined>> {
	const raw = await readFile(authPath(), "utf8").catch(() => "{}");
	try {
		return JSON.parse(raw) as Record<string, CodexCredentials | undefined>;
	} catch {
		return {};
	}
}

async function persist(creds: CodexCredentials): Promise<void> {
	const store = await readStore();
	store[STORE_KEY] = creds;
	const path = authPath();
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

async function refresh(refreshToken: string): Promise<CodexCredentials> {
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: CLIENT_ID,
		}),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`Codex token refresh failed (${res.status}): ${text || res.statusText}`);
	}
	const json = (await res.json()) as RefreshResponse;
	const accountId = decodeAccountId(json.access_token) ?? decodeAccountId(json.id_token);
	if (!accountId) {
		throw new Error("Codex token refresh: no chatgpt_account_id in access or id token");
	}
	return {
		type: "oauth",
		access: json.access_token,
		refresh: json.refresh_token,
		expires: Date.now() + json.expires_in * 1000,
		accountId,
	};
}

function randomState(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function exchangeCode(code: string, verifier: string): Promise<CodexCredentials> {
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code,
			code_verifier: verifier,
			redirect_uri: REDIRECT_URI,
		}),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`Codex token exchange failed (${res.status}): ${text || res.statusText}`);
	}
	const json = (await res.json()) as RefreshResponse;
	const accountId = decodeAccountId(json.access_token) ?? decodeAccountId(json.id_token);
	if (!accountId) {
		throw new Error("Codex token exchange: no chatgpt_account_id in access or id token");
	}
	return {
		type: "oauth",
		access: json.access_token,
		refresh: json.refresh_token,
		expires: Date.now() + json.expires_in * 1000,
		accountId,
	};
}

/**
 * Browser login (Codex CLI simplified flow): print the authorize URL, catch the
 * localhost callback, exchange the code, and persist. Mirrors loginClaude;
 * driven by the face's `/login` command or `pnpm codex:login`. Pass a signal to
 * close the callback server on cancel.
 */
export async function loginCodex(
	onUrl: (url: string) => void,
	signal?: AbortSignal,
): Promise<CodexCredentials> {
	const { verifier, challenge } = await generatePkce();
	const state = randomState();
	const code = await new Promise<string>((resolve, reject) => {
		const server = createServer((req, res) => {
			const url = new URL(req.url ?? "", "http://localhost");
			if (url.pathname !== "/auth/callback") {
				res.writeHead(404).end("not found");
				return;
			}
			if (url.searchParams.get("state") !== state) {
				res.writeHead(400).end("state mismatch");
				return;
			}
			const authCode = url.searchParams.get("code");
			if (!authCode) {
				res.writeHead(400).end("missing code");
				return;
			}
			res.writeHead(200, { "Content-Type": "text/html" }).end("<h2>Clanky: Codex login complete. You can close this tab.</h2>");
			server.close();
			resolve(authCode);
		});
		server.on("error", reject);
		if (signal !== undefined) {
			if (signal.aborted) {
				reject(new Error("Login cancelled"));
				return;
			}
			signal.addEventListener(
				"abort",
				() => {
					server.close();
					reject(new Error("Login cancelled"));
				},
				{ once: true },
			);
		}
		server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
			const params = new URLSearchParams({
				response_type: "code",
				client_id: CLIENT_ID,
				redirect_uri: REDIRECT_URI,
				scope: SCOPE,
				code_challenge: challenge,
				code_challenge_method: "S256",
				state,
				id_token_add_organizations: "true",
				codex_cli_simplified_flow: "true",
				originator: "clanky",
			});
			onUrl(`${AUTHORIZE_URL}?${params.toString()}`);
		});
	});
	const creds = await exchangeCode(code, verifier);
	await persist(creds);
	return creds;
}

/**
 * Return currently-valid Codex credentials, refreshing and persisting when the
 * stored token is within the refresh skew of expiry. Safe to call on every
 * request; the network refresh only fires when actually needed.
 */
export async function getValidCodexCredentials(): Promise<CodexCredentials> {
	const stored = (await readStore())[STORE_KEY];
	if (!stored?.access || !stored.refresh) {
		throw new Error(
			`No '${STORE_KEY}' credential in ${authPath()}. Mint one with the Codex CLI login.`,
		);
	}
	// Some writers store seconds, some milliseconds; normalize to ms.
	const expiresMs = stored.expires > 1e12 ? stored.expires : stored.expires * 1000;
	if (expiresMs - REFRESH_SKEW_MS > Date.now()) {
		const accountId = stored.accountId || decodeAccountId(stored.access);
		if (!accountId) {
			throw new Error("Stored Codex credential is missing accountId and none could be decoded");
		}
		return { type: "oauth", access: stored.access, refresh: stored.refresh, expires: expiresMs, accountId };
	}
	const refreshed = await refresh(stored.refresh);
	await persist(refreshed);
	return refreshed;
}

/** Stored-credential presence and expiry without refreshing. For status display. */
export async function codexCredentialStatus(): Promise<{ present: boolean; expiresMs?: number }> {
	const stored = (await readStore())[STORE_KEY];
	if (!stored?.access || !stored.refresh) return { present: false };
	return { present: true, expiresMs: stored.expires > 1e12 ? stored.expires : stored.expires * 1000 };
}
