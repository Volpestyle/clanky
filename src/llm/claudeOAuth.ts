import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";

const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_OAUTH_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const CLAUDE_OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const CLAUDE_OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const CLAUDE_OAUTH_SCOPES = "org:create_api_key user:profile user:inference";
const CLAUDE_CLI_USER_AGENT = "claude-cli/2.1.2 (external, cli)";
const TOOL_PREFIX = "mcp_";
const REQUIRED_BETA_HEADERS = ["oauth-2025-04-20", "interleaved-thinking-2025-05-14"];

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

function prefixToolNames(body: string): string {
  try {
    const parsed = JSON.parse(body);

    if (parsed.tools && Array.isArray(parsed.tools)) {
      parsed.tools = parsed.tools.map((tool: Record<string, unknown>) => ({
        ...tool,
        name: tool.name ? `${TOOL_PREFIX}${tool.name}` : tool.name
      }));
    }

    if (parsed.messages && Array.isArray(parsed.messages)) {
      parsed.messages = parsed.messages.map((msg: Record<string, unknown>) => {
        if (msg.content && Array.isArray(msg.content)) {
          msg.content = (msg.content as Array<Record<string, unknown>>).map((block) => {
            if (block.type === "tool_use" && block.name) {
              return { ...block, name: `${TOOL_PREFIX}${block.name}` };
            }
            return block;
          });
        }
        return msg;
      });
    }

    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

function stripToolPrefix(text: string): string {
  return text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"');
}

function createOAuthFetch(getTokens: () => ClaudeOAuthTokens, setTokens: (t: ClaudeOAuthTokens) => void) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let tokens = getTokens();

    if (!tokens.accessToken || tokens.expiresAt < Date.now()) {
      tokens = await refreshAccessToken(tokens);
      setTokens(tokens);
    }

    const requestHeaders = new Headers();

    if (input instanceof Request) {
      input.headers.forEach((value, key) => {
        requestHeaders.set(key, value);
      });
    }

    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((value, key) => {
          requestHeaders.set(key, value);
        });
      } else if (Array.isArray(init.headers)) {
        for (const [key, value] of init.headers) {
          if (typeof value !== "undefined") {
            requestHeaders.set(key, String(value));
          }
        }
      } else {
        for (const [key, value] of Object.entries(init.headers)) {
          if (typeof value !== "undefined") {
            requestHeaders.set(key, String(value));
          }
        }
      }
    }

    const incomingBeta = requestHeaders.get("anthropic-beta") || "";
    const incomingBetasList = incomingBeta.split(",").map((b) => b.trim()).filter(Boolean);
    const mergedBetas = [...new Set([...REQUIRED_BETA_HEADERS, ...incomingBetasList])].join(",");

    requestHeaders.set("authorization", `Bearer ${tokens.accessToken}`);
    requestHeaders.set("anthropic-beta", mergedBetas);
    requestHeaders.set("user-agent", CLAUDE_CLI_USER_AGENT);
    requestHeaders.delete("x-api-key");

    let body = init?.body;
    if (body && typeof body === "string") {
      body = prefixToolNames(body);
    }

    let requestInput = input;
    let requestUrl: URL | null = null;
    try {
      if (typeof input === "string" || input instanceof URL) {
        requestUrl = new URL(input.toString());
      } else if (input instanceof Request) {
        requestUrl = new URL(input.url);
      }
    } catch {
      requestUrl = null;
    }

    if (requestUrl && requestUrl.pathname === "/v1/messages" && !requestUrl.searchParams.has("beta")) {
      requestUrl.searchParams.set("beta", "true");
      requestInput = input instanceof Request ? new Request(requestUrl.toString(), input) : requestUrl;
    }

    const response = await fetch(requestInput, {
      ...init,
      body,
      headers: requestHeaders
    });

    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();

      const stream = new ReadableStream({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          let text = decoder.decode(value, { stream: true });
          text = stripToolPrefix(text);
          controller.enqueue(encoder.encode(text));
        }
      });

      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    }

    return response;
  };
}

export type ClaudeOAuthState = {
  tokens: ClaudeOAuthTokens;
  client: Anthropic;
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

  const state: ClaudeOAuthState = {
    tokens,
    // eslint-disable-next-line no-restricted-syntax
    client: null as unknown as Anthropic
  };

  const oauthFetch = createOAuthFetch(
    () => state.tokens,
    (updated) => { state.tokens = updated; }
  );

  state.client = new Anthropic({
    apiKey: "claude-oauth-placeholder",
    fetch: oauthFetch
  });

  return state;
}

// --- PKCE OAuth setup utilities ---

export function generatePKCE(): { verifier: string; challenge: string } {
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

  const tokens: ClaudeOAuthTokens = {
    refreshToken: json.refresh_token,
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000
  };
  saveTokens(tokens);
  return tokens;
}
