/**
 * Anthropic (Claude Pro/Max subscription) OAuth credential store for Clanky.
 *
 * Ported from ~/dev/pi/packages/ai/src/utils/oauth/anthropic.ts (+ pkce.ts).
 * Provides the browser login flow (mint once), refresh, and a valid-credential
 * accessor. The Codex twin lives in codex-auth.ts.
 *
 * NOTE: the Claude subscription has no sanctioned third-party path; the model
 * (claude-model.ts) authenticates by presenting Claude Code's identity. Use is a
 * ToS-gray area — see SPEC.md §4.6.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PORT = 53692;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;
const SCOPES =
	"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const STORE_KEY = "anthropic-oauth";
const REFRESH_SKEW_MS = 5 * 60_000;

export interface ClaudeCredentials {
	type: "oauth";
	access: string;
	refresh: string;
	/** Epoch milliseconds. */
	expires: number;
}

interface TokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
}

function authPath(): string {
	return (
		process.env.CLANKY_CLAUDE_AUTH ??
		join(homedir(), ".clanky", "profiles", "default", "auth.json")
	);
}

// --- PKCE (Web Crypto, ported from pi pkce.ts) ---

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
	const verifierBytes = new Uint8Array(32);
	crypto.getRandomValues(verifierBytes);
	const verifier = base64url(verifierBytes);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

// --- credential store ---

async function readStore(): Promise<Record<string, ClaudeCredentials | undefined>> {
	const raw = await readFile(authPath(), "utf8").catch(() => "{}");
	try {
		return JSON.parse(raw) as Record<string, ClaudeCredentials | undefined>;
	} catch {
		return {};
	}
}

async function persist(creds: ClaudeCredentials): Promise<void> {
	const store = await readStore();
	store[STORE_KEY] = creds;
	await writeFile(authPath(), `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

async function postToken(body: Record<string, string>): Promise<ClaudeCredentials> {
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`Claude token request failed (${res.status}): ${text}`);
	const data = JSON.parse(text) as TokenResponse;
	return {
		type: "oauth",
		access: data.access_token,
		refresh: data.refresh_token,
		// match pi: subtract a 5-minute safety margin from expiry
		expires: Date.now() + data.expires_in * 1000 - REFRESH_SKEW_MS,
	};
}

async function refresh(refreshToken: string): Promise<ClaudeCredentials> {
	return postToken({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: refreshToken });
}

/**
 * Browser login: print the authorize URL, catch the localhost callback, exchange
 * the code, and persist. Run once via `pnpm claude:login`.
 */
export async function loginClaude(onUrl: (url: string) => void): Promise<ClaudeCredentials> {
	const { verifier, challenge } = await generatePkce();
	const code = await new Promise<{ code: string; state: string }>((resolve, reject) => {
		const server = createServer((req, res) => {
			const url = new URL(req.url ?? "", "http://localhost");
			if (url.pathname !== "/callback") {
				res.writeHead(404).end("not found");
				return;
			}
			const code = url.searchParams.get("code");
			const state = url.searchParams.get("state");
			if (!code || !state) {
				res.writeHead(400).end("missing code/state");
				return;
			}
			res.writeHead(200, { "Content-Type": "text/html" }).end("<h2>Clanky: Claude login complete. You can close this tab.</h2>");
			server.close();
			resolve({ code, state });
		});
		server.on("error", reject);
		server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
			const params = new URLSearchParams({
				code: "true",
				client_id: CLIENT_ID,
				response_type: "code",
				redirect_uri: REDIRECT_URI,
				scope: SCOPES,
				code_challenge: challenge,
				code_challenge_method: "S256",
				state: verifier,
			});
			onUrl(`${AUTHORIZE_URL}?${params.toString()}`);
		});
	});
	if (code.state !== verifier) throw new Error("OAuth state mismatch");
	const creds = await postToken({
		grant_type: "authorization_code",
		client_id: CLIENT_ID,
		code: code.code,
		state: code.state,
		redirect_uri: REDIRECT_URI,
		code_verifier: verifier,
	});
	await persist(creds);
	return creds;
}

/** Return valid Claude credentials, refreshing and persisting near expiry. */
export async function getValidClaudeCredentials(): Promise<ClaudeCredentials> {
	const stored = (await readStore())[STORE_KEY];
	if (!stored?.access || !stored.refresh) {
		throw new Error(`No '${STORE_KEY}' credential in ${authPath()}. Run \`pnpm claude:login\` first.`);
	}
	const expiresMs = stored.expires > 1e12 ? stored.expires : stored.expires * 1000;
	if (expiresMs - REFRESH_SKEW_MS > Date.now()) {
		return { type: "oauth", access: stored.access, refresh: stored.refresh, expires: expiresMs };
	}
	const refreshed = await refresh(stored.refresh);
	await persist(refreshed);
	return refreshed;
}
