import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import OpenAI from "openai";
import type { Fetch as OpenAiFetch } from "openai/core";
import { isGpt5FamilyModel } from "./llmHelpers.ts";

const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_OAUTH_ISSUER = "https://auth.openai.com";
const CODEX_OAUTH_AUTHORIZE_URL = `${CODEX_OAUTH_ISSUER}/oauth/authorize`;
const CODEX_OAUTH_TOKEN_URL = `${CODEX_OAUTH_ISSUER}/oauth/token`;
const CODEX_OAUTH_DEFAULT_CALLBACK_PORT = 1455;
const CODEX_OAUTH_DEFAULT_REDIRECT_URI = `http://localhost:${CODEX_OAUTH_DEFAULT_CALLBACK_PORT}/auth/callback`;
const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const CODEX_OAUTH_SCOPES = "openid profile email offline_access";
const CODEX_AUTH_FILE_NAME = "auth.json";
const OPENAI_OAUTH_TOKEN_FILE_PATH = join("data", "openai-oauth-tokens.json");
const LEGACY_CODEX_OAUTH_TOKEN_FILE_PATH = join("data", "codex-oauth-tokens.json");
const REQUEST_ORIGINATOR = "clanky";
const REQUEST_USER_AGENT = "clanky/1.0";
const OPENAI_BETA_RESPONSES = "responses=experimental";

export type CodexOAuthTokens = {
  refreshToken: string;
  accessToken: string;
  idToken: string;
  expiresAt: number;
  accountId: string;
};

type CodexAuthFileTokens = {
  id_token?: unknown;
  access_token?: unknown;
  refresh_token?: unknown;
  account_id?: unknown;
};

type CodexAuthFile = {
  tokens?: CodexAuthFileTokens;
};

type CodexOAuthTokenResponse = {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_in?: number;
};

type CodexOAuthClaims = {
  exp?: number;
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
    const refreshToken = typeof parsed.refreshToken === "string"
      ? parsed.refreshToken.trim()
      : "";
    const accessToken = typeof parsed.accessToken === "string"
      ? parsed.accessToken.trim()
      : "";
    if (!refreshToken && !accessToken) {
      return null;
    }
    return {
      refreshToken,
      accessToken,
      idToken: typeof parsed.idToken === "string" ? parsed.idToken.trim() : "",
      expiresAt: Number(parsed.expiresAt || 0) || extractTokenExpiryMs(accessToken),
      accountId: typeof parsed.accountId === "string" ? parsed.accountId.trim() : ""
    };
  } catch {
    return null;
  }
}

function resolveCodexAuthFileCandidates(): string[] {
  const candidates = [
    process.env.CHATGPT_LOCAL_HOME ? join(process.env.CHATGPT_LOCAL_HOME, CODEX_AUTH_FILE_NAME) : "",
    process.env.CODEX_HOME ? join(process.env.CODEX_HOME, CODEX_AUTH_FILE_NAME) : "",
    join(homedir(), ".chatgpt-local", CODEX_AUTH_FILE_NAME),
    join(homedir(), ".codex", CODEX_AUTH_FILE_NAME)
  ];
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const candidate of candidates) {
    const normalized = String(candidate || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

function extractTokenExpiryMs(accessToken: string): number {
  const claims = parseJwtClaims(accessToken);
  const exp = Number(claims?.exp || 0);
  if (!Number.isFinite(exp) || exp <= 0) return 0;
  return exp * 1000;
}

function readCodexAuthTokensFromFile(filePath: string): CodexOAuthTokens | null {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as CodexAuthFile;
    const tokens = parsed?.tokens || {};
    const accessToken = String(tokens.access_token || "").trim();
    const refreshToken = String(tokens.refresh_token || "").trim();
    const idToken = String(tokens.id_token || "").trim();
    const accountId = String(tokens.account_id || "").trim() || extractAccountIdFromTokens({ accessToken, idToken });
    if (!accessToken && !refreshToken) {
      return null;
    }
    return {
      refreshToken,
      accessToken,
      idToken,
      expiresAt: extractTokenExpiryMs(accessToken),
      accountId
    };
  } catch {
    return null;
  }
}

function loadTokensFromCodexAuthFiles(): CodexOAuthTokens | null {
  const candidates = resolveCodexAuthFileCandidates();
  for (const candidate of candidates) {
    const tokens = readCodexAuthTokensFromFile(candidate);
    if (tokens) {
      return tokens;
    }
  }
  return null;
}

function loadTokens(): CodexOAuthTokens | null {
  return readTokensFile(OPENAI_OAUTH_TOKEN_FILE_PATH)
    || readTokensFile(LEGACY_CODEX_OAUTH_TOKEN_FILE_PATH)
    || loadTokensFromCodexAuthFiles();
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
  if (existing) {
    if (!existing.refreshToken) {
      const withEnvRefreshToken = {
        ...existing,
        refreshToken: envRefreshToken
      };
      saveTokens(withEnvRefreshToken);
      return withEnvRefreshToken;
    }
    return existing;
  }
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

async function refreshAccessToken(tokens: CodexOAuthTokens, fetchImpl: typeof fetch = fetch): Promise<CodexOAuthTokens> {
  if (!String(tokens.refreshToken || "").trim()) {
    throw new Error("OpenAI OAuth refresh token is missing. Re-run OAuth login to restore token refresh.");
  }

  const response = await fetchImpl(CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: CODEX_OAUTH_CLIENT_ID,
      scope: CODEX_OAUTH_SCOPES
    })
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

type RequestParts = {
  url: string;
  method?: string;
  headers: Headers;
  body?: unknown;
  signal?: AbortSignal | null;
};

type PreparedResponsesRequestBody = {
  body: unknown;
  expectsJsonResponse: boolean;
};

type OpenAiFetchInput = Parameters<OpenAiFetch>[0];
type OpenAiFetchInit = Parameters<OpenAiFetch>[1];

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveTargetUrl(input: string): string {
  const base = new URL(CODEX_BASE_URL);
  const parsed = /^https?:\/\//u.test(input)
    ? new URL(input)
    : new URL(input, "https://codex.invalid");
  let pathname = parsed.pathname;
  const basePath = withoutTrailingSlash(base.pathname);

  if (pathname === basePath) {
    pathname = "/";
  } else if (basePath.length > 0 && pathname.startsWith(`${basePath}/`)) {
    pathname = pathname.slice(basePath.length);
  }

  if (pathname === "/v1") {
    pathname = "/";
  } else if (pathname.startsWith("/v1/")) {
    pathname = pathname.slice(3);
  }

  return `${base.origin}${basePath}${pathname}${parsed.search}`;
}

export function normalizeCodexResponsesBodyForOAuth(body: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...body };
  const instructions = typeof normalized.instructions === "string"
    ? normalized.instructions
    : "";
  normalized.instructions = instructions;
  if (normalized.store === undefined) {
    normalized.store = false;
  }
  if (isGpt5FamilyModel(normalized.model)) {
    delete normalized.temperature;
    delete normalized.top_p;

    if (isRecord(normalized.reasoning)) {
      const reasoning = { ...normalized.reasoning };
      const effort = String(reasoning.effort || "")
        .trim()
        .toLowerCase();
      if (effort === "minimal") {
        reasoning.effort = "low";
      }
      normalized.reasoning = reasoning;
    }

    const topLevelReasoningEffort = String(normalized.reasoning_effort || "")
      .trim()
      .toLowerCase();
    if (topLevelReasoningEffort === "minimal") {
      normalized.reasoning_effort = "low";
    }
  }
  delete normalized.max_output_tokens;
  return normalized;
}

async function decodeBody(body: unknown): Promise<string | undefined> {
  if (body == null) {
    return undefined;
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof URLSearchParams || body instanceof FormData || body instanceof ReadableStream) {
    return undefined;
  }
  if (body instanceof Blob) {
    return body.text();
  }
  if (body instanceof ArrayBuffer) {
    return new TextDecoder().decode(body);
  }
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(body);
  }
  return undefined;
}

async function readRequestParts(input: OpenAiFetchInput, init?: OpenAiFetchInit): Promise<RequestParts> {
  if (input instanceof Request) {
    const headers = new Headers(input.headers);
    if (init?.headers) {
       
      new Headers(init.headers as HeadersInit).forEach((value, key) => {
        headers.set(key, value);
      });
    }

    return {
      url: input.url,
      method: init?.method ?? input.method,
      headers,
      body: init?.body ?? (input.body == null ? undefined : await input.clone().text()),
      signal: init?.signal ?? input.signal
    };
  }

  return {
    url: String(input),
    method: init?.method,
     
    headers: new Headers(init?.headers as HeadersInit),
    body: init?.body,
    signal: init?.signal
  };
}

async function prepareResponsesRequestBody(
  pathname: string,
  headers: Headers,
  body: unknown
): Promise<PreparedResponsesRequestBody> {
  if (!pathname.endsWith("/responses")) {
    return { body, expectsJsonResponse: false };
  }

  const contentType = headers.get("content-type");
  if (contentType && !contentType.includes("application/json")) {
    return { body, expectsJsonResponse: false };
  }

  const bodyText = await decodeBody(body);
  if (typeof bodyText !== "string") {
    return { body, expectsJsonResponse: false };
  }

  try {
    const parsed = JSON.parse(bodyText);
    if (!isRecord(parsed)) {
      return { body, expectsJsonResponse: false };
    }

    const normalized = normalizeCodexResponsesBodyForOAuth(parsed);
    const wantsStream = normalized.stream === true;
    if (!wantsStream) {
      normalized.stream = true;
    }
    return {
      body: JSON.stringify(normalized),
      expectsJsonResponse: !wantsStream
    };
  } catch {
    return { body, expectsJsonResponse: false };
  }
}

type ServerSentEvent = {
  event?: string;
  data?: string;
};

const SSE_SEPARATOR = /\r?\n\r?\n/u;

function parseServerSentEventBlock(block: string): ServerSentEvent {
  const event: ServerSentEvent = {};
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/u)) {
    if (line.startsWith("event:")) {
      event.event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length > 0) {
    event.data = dataLines.join("\n");
  }
  return event;
}

async function* iterateServerSentEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<ServerSentEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(SSE_SEPARATOR);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        if (block.trim().length > 0) {
          yield parseServerSentEventBlock(block);
        }
      }
    }

    if (buffer.trim().length > 0) {
      yield parseServerSentEventBlock(buffer);
    }
  } finally {
    reader.releaseLock();
  }
}

async function collectCompletedResponseFromSse(stream: ReadableStream<Uint8Array>): Promise<Record<string, unknown>> {
  let latestResponse: Record<string, unknown> | undefined;
  let latestError: unknown;

  for await (const event of iterateServerSentEvents(stream)) {
    if (typeof event.data !== "string" || event.data.length === 0) {
      continue;
    }

    try {
      const parsed = JSON.parse(event.data);
      if (!isRecord(parsed)) {
        continue;
      }

      if (event.event === "error") {
        latestError = parsed;
        continue;
      }

      const response = parsed.response;
      if (isRecord(response)) {
        latestResponse = response;
      }
    } catch {
      // ignore malformed event payloads
    }
  }

  if (latestResponse) {
    return latestResponse;
  }

  throw new Error(
    `No completed response found in SSE stream.${latestError ? ` Last error: ${JSON.stringify(latestError)}` : ""}`
  );
}

type CodexOAuthFetchOptions = {
  getTokens: () => CodexOAuthTokens;
  setTokens: (tokens: CodexOAuthTokens) => void;
  fetchImpl?: typeof fetch;
};

export function createCodexOAuthFetch({
  getTokens,
  setTokens,
  fetchImpl = fetch
}: CodexOAuthFetchOptions): OpenAiFetch {
  const oauthFetch = async (input: OpenAiFetchInput, init?: OpenAiFetchInit): Promise<Response> => {
    let tokens = getTokens();
    if (!tokens.accessToken || tokens.expiresAt < Date.now()) {
      tokens = await refreshAccessToken(tokens, fetchImpl);
      setTokens(tokens);
    }

    const request = await readRequestParts(input, init);
    const targetUrl = resolveTargetUrl(request.url);
    const target = new URL(targetUrl);
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    headers.delete("Authorization");
    headers.delete("chatgpt-account-id");
    headers.delete("ChatGPT-Account-Id");
    headers.delete("openai-beta");
    headers.delete("OpenAI-Beta");
    headers.set("Authorization", `Bearer ${tokens.accessToken}`);
    if (tokens.accountId) {
      headers.set("chatgpt-account-id", tokens.accountId);
    }
    headers.set("OpenAI-Beta", OPENAI_BETA_RESPONSES);
    headers.set("originator", REQUEST_ORIGINATOR);
    if (!headers.has("user-agent")) {
      headers.set("user-agent", REQUEST_USER_AGENT);
    }

    const preparedBody = await prepareResponsesRequestBody(target.pathname, headers, request.body);

    const response = await fetchImpl(target.toString(), {
      method: request.method ?? init?.method,
      headers,
      body: preparedBody.body as RequestInit["body"],
      signal: request.signal ?? undefined
    });

    if (preparedBody.expectsJsonResponse && response.ok && response.body) {
      const completed = await collectCompletedResponseFromSse(response.body);
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set("content-type", "application/json");
      return new Response(JSON.stringify(completed), {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders
      });
    }

    if (!response.ok && target.pathname.endsWith("/responses")) {
      const detail = await response.clone().text().catch(() => "");
      console.warn(
        `[openai-oauth] upstream error status=${response.status} detail=${String(detail || "(empty)").slice(0, 240)}`
      );
    }

    return response;
  };
  // OpenAI's SDK still types its fetch hook around node-fetch shims.
  // eslint-disable-next-line no-restricted-syntax
  return oauthFetch as unknown as OpenAiFetch;
}

export type CodexOAuthState = {
  tokens: CodexOAuthTokens;
  client: OpenAI;
  /** Pre-refresh the access token at startup so the first request isn't cold. */
  warmup: () => Promise<void>;
  /** Refresh the access token if expired. Safe to call before every request. */
  ensureFresh: () => Promise<void>;
};

export function isCodexOAuthConfigured(envRefreshToken: string): boolean {
  const normalizedEnv = String(envRefreshToken || "").trim();
  if (normalizedEnv) return true;
  const existing = loadTokens();
  return Boolean(existing?.refreshToken || existing?.accessToken);
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
        "OpenAI OAuth not configured. Set OPENAI_OAUTH_REFRESH_TOKEN, create data/openai-oauth-tokens.json, run `codex login`, or provide ~/.codex/auth.json."
      );
    }
    tokens = existing;
  }

  let currentTokens = tokens;
  const oauthFetch = createCodexOAuthFetch({
    getTokens: () => currentTokens,
    setTokens: (updated) => {
      currentTokens = updated;
    }
  });
  const client = new OpenAI({
    apiKey: "openai-oauth-placeholder",
    fetch: oauthFetch
  });

  async function ensureFresh() {
    if (!currentTokens.accessToken || currentTokens.expiresAt < Date.now()) {
      currentTokens = await refreshAccessToken(currentTokens);
    }
  }

  return {
    get tokens() {
      return currentTokens;
    },
    client,
    async warmup() {
      await ensureFresh();
    },
    ensureFresh
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
