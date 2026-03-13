import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import OpenAI from "openai";
import type { Fetch as OpenAiFetch } from "openai/core";

const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_OAUTH_ISSUER = "https://auth.openai.com";
const CODEX_OAUTH_AUTHORIZE_URL = `${CODEX_OAUTH_ISSUER}/oauth/authorize`;
const CODEX_OAUTH_TOKEN_URL = `${CODEX_OAUTH_ISSUER}/oauth/token`;
const CODEX_OAUTH_DEFAULT_CALLBACK_PORT = 1455;
const CODEX_OAUTH_DEFAULT_REDIRECT_URI = `http://localhost:${CODEX_OAUTH_DEFAULT_CALLBACK_PORT}/auth/callback`;
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_OAUTH_SCOPES = "openid profile email offline_access";
const OPENAI_OAUTH_TOKEN_FILE_PATH = join("data", "openai-oauth-tokens.json");
const LEGACY_CODEX_OAUTH_TOKEN_FILE_PATH = join("data", "codex-oauth-tokens.json");
const REQUEST_ORIGINATOR = "clanky";
const REQUEST_USER_AGENT = "clanky/1.0";

type CodexOAuthTokens = {
  refreshToken: string;
  accessToken: string;
  idToken: string;
  expiresAt: number;
  accountId: string;
};

type CodexOAuthTokenResponse = {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_in?: number;
};

type CodexOAuthClaims = {
  chatgpt_account_id?: string;
  organizations?: Array<{ id?: string }>;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
  };
};

type PkceChallenge = {
  verifier: string;
  challenge: string;
};

function readTokensFile(filePath: string): CodexOAuthTokens | null {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<{
      refreshToken: unknown;
      accessToken: unknown;
      idToken: unknown;
      expiresAt: unknown;
      accountId: unknown;
    }>;
    if (typeof parsed.refreshToken !== "string" || !parsed.refreshToken.trim()) {
      return null;
    }
    return {
      refreshToken: parsed.refreshToken.trim(),
      accessToken: typeof parsed.accessToken === "string" ? parsed.accessToken.trim() : "",
      idToken: typeof parsed.idToken === "string" ? parsed.idToken.trim() : "",
      expiresAt: Number(parsed.expiresAt || 0),
      accountId: typeof parsed.accountId === "string" ? parsed.accountId.trim() : ""
    };
  } catch {
    return null;
  }
}

function loadTokens(): CodexOAuthTokens | null {
  return readTokensFile(OPENAI_OAUTH_TOKEN_FILE_PATH) || readTokensFile(LEGACY_CODEX_OAUTH_TOKEN_FILE_PATH);
}

function saveTokens(tokens: CodexOAuthTokens): void {
  try {
    mkdirSync(dirname(OPENAI_OAUTH_TOKEN_FILE_PATH), { recursive: true });
    writeFileSync(OPENAI_OAUTH_TOKEN_FILE_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  } catch (error) {
    console.error("[openai-oauth] Failed to save tokens:", error);
  }
}

function initTokensFromEnv(envRefreshToken: string): CodexOAuthTokens {
  const existing = loadTokens();
  if (existing) return existing;
  const tokens: CodexOAuthTokens = {
    refreshToken: envRefreshToken,
    accessToken: "",
    idToken: "",
    expiresAt: 0,
    accountId: ""
  };
  saveTokens(tokens);
  return tokens;
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function generatePKCE(): PkceChallenge {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function generateState(): string {
  return base64UrlEncode(randomBytes(32));
}

function parseJwtClaims(token: string): CodexOAuthClaims | null {
  const parts = String(token || "").trim().split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as CodexOAuthClaims;
  } catch {
    return null;
  }
}

function extractAccountIdFromClaims(claims: CodexOAuthClaims | null): string {
  if (!claims) return "";
  const direct = String(claims.chatgpt_account_id || "").trim();
  if (direct) return direct;
  const scoped = String(claims["https://api.openai.com/auth"]?.chatgpt_account_id || "").trim();
  if (scoped) return scoped;
  const organizationId = String(claims.organizations?.[0]?.id || "").trim();
  return organizationId;
}

function extractAccountIdFromTokens({
  accessToken,
  idToken
}: {
  accessToken: string;
  idToken: string;
}): string {
  const fromIdToken = extractAccountIdFromClaims(parseJwtClaims(idToken));
  if (fromIdToken) return fromIdToken;
  return extractAccountIdFromClaims(parseJwtClaims(accessToken));
}

function toStoredTokens(
  previousTokens: CodexOAuthTokens,
  tokenResponse: CodexOAuthTokenResponse
): CodexOAuthTokens {
  const accessToken = String(tokenResponse.access_token || "").trim();
  const refreshToken = String(tokenResponse.refresh_token || "").trim() || previousTokens.refreshToken;
  const idToken = String(tokenResponse.id_token || "").trim() || previousTokens.idToken;
  const accountId =
    extractAccountIdFromTokens({ accessToken, idToken }) || previousTokens.accountId;

  return {
    refreshToken,
    accessToken,
    idToken,
    expiresAt: Date.now() + Math.max(1, Number(tokenResponse.expires_in || 3600)) * 1000,
    accountId
  };
}

async function refreshAccessToken(tokens: CodexOAuthTokens): Promise<CodexOAuthTokens> {
  const response = await fetch(CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: CODEX_OAUTH_CLIENT_ID
    }).toString()
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenAI OAuth token refresh failed (${response.status}): ${body.slice(0, 200)}`);
  }

  const json = await response.json() as CodexOAuthTokenResponse;
  const updated = toStoredTokens(tokens, json);
  saveTokens(updated);
  return updated;
}

function mergeRequestHeaders(input: unknown, init?: RequestInit): Headers {
  const requestHeaders = new Headers();

  if (input instanceof Request) {
    input.headers.forEach((value, key) => {
      requestHeaders.set(key, value);
    });
  }

  if (!init?.headers) return requestHeaders;

  if (init.headers instanceof Headers) {
    init.headers.forEach((value, key) => {
      requestHeaders.set(key, value);
    });
    return requestHeaders;
  }

  if (Array.isArray(init.headers)) {
    for (const [key, value] of init.headers) {
      if (typeof value !== "undefined") {
        requestHeaders.set(key, String(value));
      }
    }
    return requestHeaders;
  }

  for (const [key, value] of Object.entries(init.headers)) {
    if (typeof value !== "undefined") {
      requestHeaders.set(key, String(value));
    }
  }
  return requestHeaders;
}

function rewriteCodexUrl(rawUrl: URL): URL {
  const url = new URL(rawUrl.toString());
  const normalizedPath = url.pathname.replace(/\/+$/, "");

  if (/^\/v1\/responses(?:\/.*)?$/.test(normalizedPath)) {
    url.protocol = "https:";
    url.host = "chatgpt.com";
    url.pathname = normalizedPath.replace(/^\/v1\/responses/, "/backend-api/codex/responses");
    return url;
  }

  if (/^\/responses(?:\/.*)?$/.test(normalizedPath)) {
    url.protocol = "https:";
    url.host = "chatgpt.com";
    url.pathname = normalizedPath.replace(/^\/responses/, "/backend-api/codex/responses");
    return url;
  }

  if (/^\/v1\/chat\/completions(?:\/.*)?$/.test(normalizedPath) || /^\/chat\/completions(?:\/.*)?$/.test(normalizedPath)) {
    return new URL(CODEX_RESPONSES_URL);
  }

  return url;
}

function resolveRequestUrl(input: unknown): URL | null {
  try {
    if (typeof input === "string") {
      return new URL(input.toString());
    }
    if (input instanceof Request) {
      return new URL(input.url);
    }
    if (input && typeof input === "object" && "url" in input) {
      const url = Reflect.get(input, "url");
      if (typeof url === "string" && url.trim()) {
        return new URL(url);
      }
    }
  } catch {
    return null;
  }
  return null;
}

function createOAuthFetch(
  getTokens: () => CodexOAuthTokens,
  setTokens: (tokens: CodexOAuthTokens) => void
): OpenAiFetch {
  const oauthFetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
    let tokens = getTokens();
    if (!tokens.accessToken || tokens.expiresAt < Date.now()) {
      tokens = await refreshAccessToken(tokens);
      setTokens(tokens);
    }

    const headers = mergeRequestHeaders(input, init);
    headers.delete("authorization");
    headers.delete("Authorization");
    headers.set("authorization", `Bearer ${tokens.accessToken}`);
    if (tokens.accountId) {
      headers.set("ChatGPT-Account-Id", tokens.accountId);
    }
    headers.set("originator", REQUEST_ORIGINATOR);
    if (!headers.has("user-agent")) {
      headers.set("user-agent", REQUEST_USER_AGENT);
    }

    const requestUrl = resolveRequestUrl(input);
    const rewrittenUrl = requestUrl ? rewriteCodexUrl(requestUrl) : null;
    const requestInput: string | URL | Request =
      rewrittenUrl && input instanceof Request
        ? new Request(rewrittenUrl.toString(), input)
        : rewrittenUrl
          ? rewrittenUrl.toString()
          : typeof input === "string" || input instanceof URL || input instanceof Request
            ? input
            : requestUrl?.toString() || "";

    return fetch(requestInput, {
      ...init,
      headers
    });
  };
  // OpenAI's SDK still types its fetch hook around node-fetch shims.
  // eslint-disable-next-line no-restricted-syntax
  return oauthFetch as unknown as OpenAiFetch;
}

export type CodexOAuthState = {
  tokens: CodexOAuthTokens;
  client: OpenAI;
};

export function isCodexOAuthConfigured(envRefreshToken: string): boolean {
  const normalizedEnv = String(envRefreshToken || "").trim();
  if (normalizedEnv) return true;
  const existing = loadTokens();
  return Boolean(existing?.refreshToken);
}

export function createCodexOAuthClient(envRefreshToken: string): CodexOAuthState {
  const normalizedEnv = String(envRefreshToken || "").trim();
  let tokens: CodexOAuthTokens;

  if (normalizedEnv) {
    tokens = initTokensFromEnv(normalizedEnv);
  } else {
    const existing = loadTokens();
    if (!existing) {
      throw new Error(
        "OpenAI OAuth not configured. Set OPENAI_OAUTH_REFRESH_TOKEN or create data/openai-oauth-tokens.json."
      );
    }
    tokens = existing;
  }

  let currentTokens = tokens;
  const oauthFetch = createOAuthFetch(
    () => currentTokens,
    (updated) => {
      currentTokens = updated;
    }
  );
  const client = new OpenAI({
    apiKey: "openai-oauth-placeholder",
    fetch: oauthFetch
  });
  return {
    get tokens() {
      return currentTokens;
    },
    client
  };
}

export function buildAuthorizeUrl({
  redirectUri = CODEX_OAUTH_DEFAULT_REDIRECT_URI
}: {
  redirectUri?: string;
} = {}): { url: string; verifier: string; state: string } {
  const { verifier, challenge } = generatePKCE();
  const state = generateState();
  const url = new URL(CODEX_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CODEX_OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", CODEX_OAUTH_SCOPES);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", REQUEST_ORIGINATOR);
  url.searchParams.set("state", state);
  return {
    url: url.toString(),
    verifier,
    state
  };
}

export async function exchangeCodeForTokens({
  code,
  redirectUri = CODEX_OAUTH_DEFAULT_REDIRECT_URI,
  verifier
}: {
  code: string;
  redirectUri?: string;
  verifier: string;
}): Promise<CodexOAuthTokens> {
  const response = await fetch(CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: String(code || "").trim(),
      redirect_uri: redirectUri,
      client_id: CODEX_OAUTH_CLIENT_ID,
      code_verifier: verifier
    }).toString()
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenAI OAuth code exchange failed (${response.status}): ${body.slice(0, 200)}`);
  }

  const json = await response.json() as CodexOAuthTokenResponse;
  const tokens = toStoredTokens(
    {
      refreshToken: "",
      accessToken: "",
      idToken: "",
      expiresAt: 0,
      accountId: ""
    },
    json
  );
  saveTokens(tokens);
  return tokens;
}

export const codexOAuthConstants = {
  defaultCallbackPort: CODEX_OAUTH_DEFAULT_CALLBACK_PORT,
  defaultRedirectUri: CODEX_OAUTH_DEFAULT_REDIRECT_URI
};
