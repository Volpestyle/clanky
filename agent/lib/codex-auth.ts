/**
 * OpenAI Codex (ChatGPT subscription) OAuth credential store for Clanky.
 *
 * Ported from ~/dev/pi/packages/ai/src/utils/oauth/openai-codex.ts, trimmed to
 * what the eve runtime needs: read the stored credential, refresh it before
 * expiry, and persist the result. The interactive login flow (browser /
 * device-code) is not reproduced here; the credential is minted once by the
 * Codex CLI and lives in the auth store this module reads.
 *
 * See SPEC.md §4.6.
 */
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const STORE_KEY = "openai-codex";
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
}

function authPath(): string {
	return (
		process.env.CLANKY_CODEX_AUTH ??
		join(homedir(), ".clanky", "profiles", "default", "auth.json")
	);
}

/** Pull the ChatGPT account id out of the access-token JWT. */
function decodeAccountId(accessToken: string): string | null {
	try {
		const segment = accessToken.split(".")[1] ?? "";
		const payload = JSON.parse(Buffer.from(segment, "base64").toString("utf8")) as {
			[k: string]: { chatgpt_account_id?: string } | unknown;
		};
		const claim = payload[JWT_CLAIM_PATH] as { chatgpt_account_id?: string } | undefined;
		const id = claim?.chatgpt_account_id;
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
	await writeFile(authPath(), `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
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
	const accountId = decodeAccountId(json.access_token);
	if (!accountId) {
		throw new Error("Codex token refresh: access token carried no chatgpt_account_id");
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
