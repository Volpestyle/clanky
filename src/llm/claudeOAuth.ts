import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";

const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_OAUTH_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const CLAUDE_OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const CLAUDE_OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const CLAUDE_OAUTH_SCOPES = "org:create_api_key user:profile user:inference";

const REQUIRED_BETA_HEADERS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14"
];

const TOKEN_FILE_PATH = join("data", "claude-oauth-tokens.json");

type ClaudeOAuthTokens = {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
};

function loadTokens(): ClaudeOAuthTokens | null {
  try {
    const raw = readFileSync(TOKEN_FILE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.refreshToken !== "string" || !parsed.refreshToken) return null;
    return {
      refreshToken: parsed.refreshToken,
      accessToken: String(parsed.accessToken || ""),
      expiresAt: Number(parsed.expiresAt || 0)
    };
  } catch {
    return null;
  }
}

function saveTokens(tokens: ClaudeOAuthTokens): void {
  try {
    mkdirSync(dirname(TOKEN_FILE_PATH), { recursive: true });
    writeFileSync(TOKEN_FILE_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  } catch (error) {
    console.error("[claude-oauth] Failed to save tokens:", error);
  }
}

function initTokensFromEnv(envRefreshToken: string): ClaudeOAuthTokens {
  const existing = loadTokens();
  if (existing) return existing;
  const tokens: ClaudeOAuthTokens = {
    refreshToken: envRefreshToken,
    accessToken: "",
    expiresAt: 0
  };
  saveTokens(tokens);
  return tokens;
}

async function refreshAccessToken(tokens: ClaudeOAuthTokens): Promise<ClaudeOAuthTokens> {
  const response = await fetch(CLAUDE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: CLAUDE_OAUTH_CLIENT_ID
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Claude OAuth token refresh failed (${response.status}): ${body.slice(0, 200)}`);
  }

  const json = await response.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const updated: ClaudeOAuthTokens = {
    refreshToken: json.refresh_token,
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000
  };
  saveTokens(updated);
  return updated;
}

// ── Client factory ──────────────────────────────────────────────────
// Uses the SDK's native authToken + defaultHeaders instead of a custom
// fetch wrapper. The previous custom fetch approach broke Bun's native
// HTTP/2 handling, causing opaque 400s from the OAuth API endpoint.

function buildClient(accessToken: string): Anthropic {
  return new Anthropic({
    authToken: accessToken,
    defaultHeaders: {
      "anthropic-beta": REQUIRED_BETA_HEADERS.join(",")
    },
    defaultQuery: { beta: "true" }
  });
}

export type ClaudeOAuthState = {
  tokens: ClaudeOAuthTokens;
  client: Anthropic;
  warmup: () => Promise<void>;
  /** Refresh the access token if expired and rebuild the SDK client. */
  ensureFresh: () => Promise<void>;
};

export function isClaudeOAuthConfigured(envRefreshToken: string): boolean {
  const normalizedEnv = String(envRefreshToken || "").trim();
  if (normalizedEnv) return true;
  const existing = loadTokens();
  return Boolean(existing?.refreshToken);
}

export function createClaudeOAuthClient(envRefreshToken: string): ClaudeOAuthState {
  const normalizedEnv = String(envRefreshToken || "").trim();
  let tokens: ClaudeOAuthTokens;

  if (normalizedEnv) {
    tokens = initTokensFromEnv(normalizedEnv);
  } else {
    const existing = loadTokens();
    if (!existing) {
      throw new Error(
        "Claude OAuth not configured. Set CLAUDE_OAUTH_REFRESH_TOKEN or create data/claude-oauth-tokens.json."
      );
    }
    tokens = existing;
  }

  let currentTokens = tokens;
  let currentClient = buildClient(currentTokens.accessToken);

  async function ensureFresh() {
    if (!currentTokens.accessToken || currentTokens.expiresAt < Date.now()) {
      currentTokens = await refreshAccessToken(currentTokens);
      currentClient = buildClient(currentTokens.accessToken);
    }
  }

  return {
    get tokens() {
      return currentTokens;
    },
    get client() {
      return currentClient;
    },
    async warmup() {
      await ensureFresh();
    },
    ensureFresh
  };
}

// --- PKCE OAuth setup utilities ---

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizeUrl(): { url: string; verifier: string } {
  const { verifier, challenge } = generatePKCE();
  const url = new URL(CLAUDE_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLAUDE_OAUTH_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", CLAUDE_OAUTH_REDIRECT_URI);
  url.searchParams.set("scope", CLAUDE_OAUTH_SCOPES);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", verifier);
  return { url: url.toString(), verifier };
}

export async function exchangeCodeForTokens(
  code: string,
  verifier: string
): Promise<ClaudeOAuthTokens> {
  const splits = code.split("#");
  const response = await fetch(CLAUDE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: splits[0],
      state: splits[1],
      grant_type: "authorization_code",
      client_id: CLAUDE_OAUTH_CLIENT_ID,
      redirect_uri: CLAUDE_OAUTH_REDIRECT_URI,
      code_verifier: verifier
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Claude OAuth code exchange failed (${response.status}): ${body.slice(0, 200)}`);
  }

  const json = await response.json() as {
    refresh_token: string;
    access_token: string;
    expires_in: number;
  };

  const oauthTokens: ClaudeOAuthTokens = {
    refreshToken: json.refresh_token,
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000
  };
  saveTokens(oauthTokens);
  return oauthTokens;
}
