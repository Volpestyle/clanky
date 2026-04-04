import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_OAUTH_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const CLAUDE_OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const CLAUDE_OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const CLAUDE_OAUTH_SCOPES = "org:create_api_key user:profile user:inference";
const CLAUDE_OAUTH_ACCESS_TOKEN_BUFFER_MS = 5 * 60_000;

const REQUIRED_BETA_HEADERS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14"
];

const DEFAULT_TOKEN_FILE_PATH = join("data", "claude-oauth-tokens.json");
const OPENCODE_AUTH_DIR_NAME = "opencode";
const OPENCODE_AUTH_FILE_NAME = "auth.json";
const OPENCODE_AUTH_SECRET_FILE_NAME = "auth-secret.json";

let cachedPowerShellBinary: string | null = null;

type ClaudeOAuthTokens = {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
};

type ClaudeOAuthTokenStore = {
  tokens: ClaudeOAuthTokens;
  save: (tokens: ClaudeOAuthTokens) => void;
};

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNumber(value: unknown): number {
  const normalized = Number(value || 0);
  return Number.isFinite(normalized) ? normalized : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function readJsonFile(filePath: string): unknown | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function parseLegacyTokens(value: unknown): ClaudeOAuthTokens | null {
  if (!isRecord(value)) return null;
  const anthropic = isRecord(value.anthropic) ? value.anthropic : null;
  const refreshToken = normalizeString(value.refreshToken) || normalizeString(anthropic?.refresh);
  const accessToken = normalizeString(value.accessToken) || normalizeString(anthropic?.access);
  const expiresAt = normalizeNumber(value.expiresAt) || normalizeNumber(anthropic?.expires);

  if (!refreshToken && !accessToken) return null;
  return { refreshToken, accessToken, expiresAt };
}

function saveLegacyTokens(filePath: string, tokens: ClaudeOAuthTokens): void {
  try {
    writeJsonFile(filePath, tokens);
  } catch (error) {
    console.error("[claude-oauth] Failed to save tokens:", error);
  }
}

function resolvePreferredLegacyTokenFilePath(): string {
  return normalizeString(process.env.CLAUDE_OAUTH_TOKEN_FILE) || DEFAULT_TOKEN_FILE_PATH;
}

function resolveLegacyTokenFileCandidates(): string[] {
  const explicitPath = normalizeString(process.env.CLAUDE_OAUTH_TOKEN_FILE);
  if (explicitPath) return [explicitPath];
  return [DEFAULT_TOKEN_FILE_PATH];
}

function createLegacyTokenStore(tokens: ClaudeOAuthTokens, filePath = resolvePreferredLegacyTokenFilePath()): ClaudeOAuthTokenStore {
  saveLegacyTokens(filePath, tokens);
  return {
    tokens,
    save(nextTokens) {
      saveLegacyTokens(filePath, nextTokens);
    }
  };
}

function loadTokensFromLegacyFiles(): ClaudeOAuthTokenStore | null {
  for (const filePath of resolveLegacyTokenFileCandidates()) {
    const tokens = parseLegacyTokens(readJsonFile(filePath));
    if (!tokens) continue;
    return {
      tokens,
      save(nextTokens) {
        saveLegacyTokens(filePath, nextTokens);
      }
    };
  }

  return null;
}

function resolveOpencodeDataDirCandidates(): string[] {
  const home = normalizeString(process.env.HOME) || normalizeString(process.env.USERPROFILE) || homedir();
  return uniqueStrings([
    normalizeString(process.env.CLAUDE_OAUTH_OPENCODE_DATA_DIR),
    normalizeString(process.env.XDG_DATA_HOME) ? join(normalizeString(process.env.XDG_DATA_HOME), OPENCODE_AUTH_DIR_NAME) : "",
    normalizeString(process.env.LOCALAPPDATA) ? join(normalizeString(process.env.LOCALAPPDATA), OPENCODE_AUTH_DIR_NAME) : "",
    normalizeString(process.env.APPDATA) ? join(normalizeString(process.env.APPDATA), OPENCODE_AUTH_DIR_NAME) : "",
    home ? join(home, ".local", "share", OPENCODE_AUTH_DIR_NAME) : ""
  ]);
}

function parseOpencodeInlineTokens(value: Record<string, unknown>): ClaudeOAuthTokens | null {
  if (normalizeString(value.type) !== "oauth") return null;
  const refreshToken = normalizeString(value.refresh);
  const accessToken = normalizeString(value.access);
  if (!refreshToken && !accessToken) return null;
  return {
    refreshToken,
    accessToken,
    expiresAt: normalizeNumber(value.expires)
  };
}

function parseOpencodeSecretTokens(value: unknown): Omit<ClaudeOAuthTokens, "expiresAt"> | null {
  if (!isRecord(value) || normalizeString(value.type) !== "oauth") return null;
  const refreshToken = normalizeString(value.refresh);
  const accessToken = normalizeString(value.access);
  if (!refreshToken && !accessToken) return null;
  return { refreshToken, accessToken };
}

function resolvePowerShellBinary(): string {
  if (cachedPowerShellBinary) return cachedPowerShellBinary;

  const pwsh = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
    encoding: "utf8",
    windowsHide: true
  });

  cachedPowerShellBinary = pwsh.status === 0 ? "pwsh" : "powershell";
  return cachedPowerShellBinary;
}

function runPowerShellSecretCommand(command: string, secretText: string): string {
  const result = spawnSync(resolvePowerShellBinary(), ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    env: { ...process.env, OPENCODE_SECRET_TEXT: secretText },
    windowsHide: true
  });

  if (result.status !== 0) {
    throw new Error(String(result.stderr || "").trim() || "PowerShell secret command failed.");
  }

  return String(result.stdout || "").trim();
}

function unprotectOpencodeSecret(secretText: string): string | null {
  if (process.platform !== "win32") return null;
  try {
    return runPowerShellSecretCommand(
      "$value = ConvertTo-SecureString $env:OPENCODE_SECRET_TEXT; $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($value); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }",
      secretText
    );
  } catch {
    return null;
  }
}

function parseOpencodeStoredSecret(value: unknown, expiresAt: number): ClaudeOAuthTokens | null {
  const direct = parseOpencodeSecretTokens(value);
  if (direct) {
    return { ...direct, expiresAt };
  }

  if (typeof value !== "string") return null;

  try {
    const inline = parseOpencodeSecretTokens(JSON.parse(value));
    if (inline) {
      return { ...inline, expiresAt };
    }
  } catch {
    // Ignore plain JSON parse failures and fall through to DPAPI.
  }

  const decrypted = unprotectOpencodeSecret(value);
  if (!decrypted) return null;

  try {
    const parsed = parseOpencodeSecretTokens(JSON.parse(decrypted));
    if (!parsed) return null;
    return { ...parsed, expiresAt };
  } catch {
    return null;
  }
}

function loadTokensFromOpencodeAuth(): ClaudeOAuthTokens | null {
  for (const dataDir of resolveOpencodeDataDirCandidates()) {
    const authPath = join(dataDir, OPENCODE_AUTH_FILE_NAME);
    const authFile = readJsonFile(authPath);
    if (!isRecord(authFile)) continue;

    const anthropic = isRecord(authFile.anthropic) ? authFile.anthropic : null;
    if (!anthropic || normalizeString(anthropic.type) !== "oauth") continue;

    const inlineTokens = parseOpencodeInlineTokens(anthropic);
    if (inlineTokens) {
      return inlineTokens;
    }

    const authSecretPath = join(dataDir, OPENCODE_AUTH_SECRET_FILE_NAME);
    const authSecretFile = readJsonFile(authSecretPath);
    if (!isRecord(authSecretFile)) continue;

    const storedSecret = parseOpencodeStoredSecret(authSecretFile.anthropic, normalizeNumber(anthropic.expires));
    if (storedSecret) return storedSecret;
  }

  return null;
}

function bootstrapLocalTokensFromOpencode(): ClaudeOAuthTokenStore | null {
  const opencodeTokens = loadTokensFromOpencodeAuth();
  if (!opencodeTokens) return null;
  return createLegacyTokenStore(opencodeTokens);
}

function initTokensFromEnv(envRefreshToken: string): ClaudeOAuthTokenStore {
  const existing = loadTokensFromLegacyFiles();
  if (existing) {
    if (!existing.tokens.refreshToken) {
      const updated = {
        ...existing.tokens,
        refreshToken: envRefreshToken
      };
      existing.save(updated);
      return {
        ...existing,
        tokens: updated
      };
    }
    return existing;
  }

  const tokens: ClaudeOAuthTokens = {
    refreshToken: envRefreshToken,
    accessToken: "",
    expiresAt: 0
  };
  return createLegacyTokenStore(tokens);
}

async function refreshAccessToken(
  tokens: ClaudeOAuthTokens,
  save: (tokens: ClaudeOAuthTokens) => void
): Promise<ClaudeOAuthTokens> {
  if (!normalizeString(tokens.refreshToken)) {
    throw new Error("Claude OAuth refresh token is missing. Re-authenticate or restore token storage.");
  }

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
    refreshToken: normalizeString(json.refresh_token) || tokens.refreshToken,
    accessToken: normalizeString(json.access_token),
    expiresAt: Date.now() + Math.max(1, normalizeNumber(json.expires_in) || 3600) * 1000
  };
  save(updated);
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
  const existing = loadTokensFromLegacyFiles();
  if (existing && (existing.tokens.refreshToken || existing.tokens.accessToken)) return true;
  const opencodeTokens = loadTokensFromOpencodeAuth();
  return Boolean(opencodeTokens?.refreshToken || opencodeTokens?.accessToken);
}

export function createClaudeOAuthClient(envRefreshToken: string): ClaudeOAuthState {
  const normalizedEnv = String(envRefreshToken || "").trim();
  const source = normalizedEnv
    ? initTokensFromEnv(normalizedEnv)
    : loadTokensFromLegacyFiles() || bootstrapLocalTokensFromOpencode();
  if (!source) {
    throw new Error(
      "Claude OAuth not configured. Set CLAUDE_OAUTH_REFRESH_TOKEN, create data/claude-oauth-tokens.json, or sign in via opencode so clanky can bootstrap its own local OAuth token cache."
    );
  }

  let currentTokens = source.tokens;
  let currentClient = buildClient(currentTokens.accessToken);

  async function ensureFresh() {
    if (!currentTokens.accessToken || currentTokens.expiresAt <= Date.now() + CLAUDE_OAUTH_ACCESS_TOKEN_BUFFER_MS) {
      currentTokens = await refreshAccessToken(currentTokens, source.save);
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
    refreshToken: normalizeString(json.refresh_token),
    accessToken: normalizeString(json.access_token),
    expiresAt: Date.now() + Math.max(1, normalizeNumber(json.expires_in) || 3600) * 1000
  };
  saveLegacyTokens(resolvePreferredLegacyTokenFilePath(), oauthTokens);
  return oauthTokens;
}
