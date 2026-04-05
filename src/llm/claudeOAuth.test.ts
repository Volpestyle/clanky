import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

type ClaudeOAuthModule = typeof import("./claudeOAuth.ts");

const OAUTH_ENV_KEYS = [
  "CLAUDE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_OAUTH_TOKEN_FILE",
  "CLAUDE_OAUTH_OPENCODE_DATA_DIR",
  "XDG_DATA_HOME",
  "HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA"
] as const;

async function withClaudeOAuthEnv<T>(run: (ctx: { root: string; shareDir: string; tokenFilePath: string }) => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of OAUTH_ENV_KEYS) {
    saved.set(key, process.env[key]);
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clanky-claude-oauth-test-"));
  const shareDir = path.join(root, "share");
  const tokenFilePath = path.join(root, "missing-claude-oauth-tokens.json");

  process.env.CLAUDE_OAUTH_REFRESH_TOKEN = "";
  process.env.CLAUDE_OAUTH_TOKEN_FILE = tokenFilePath;
  process.env.CLAUDE_OAUTH_OPENCODE_DATA_DIR = path.join(shareDir, "opencode");
  process.env.XDG_DATA_HOME = shareDir;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.LOCALAPPDATA = path.join(root, "localappdata");
  process.env.APPDATA = path.join(root, "appdata");

  try {
    return await run({ root, shareDir, tokenFilePath });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    for (const key of OAUTH_ENV_KEYS) {
      const previous = saved.get(key);
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  }
}

async function importFreshClaudeOAuth(seed: string): Promise<ClaudeOAuthModule> {
  const stamp = `${seed}-${Date.now()}-${Math.random()}`;
  return import(`./claudeOAuth.ts?${stamp}`);
}

async function writeOpencodeAuthFiles({
  shareDir,
  auth,
  authSecret
}: {
  shareDir: string;
  auth: Record<string, unknown>;
  authSecret: Record<string, unknown>;
}): Promise<{ authPath: string; authSecretPath: string }> {
  const opencodeDir = path.join(shareDir, "opencode");
  const authPath = path.join(opencodeDir, "auth.json");
  const authSecretPath = path.join(opencodeDir, "auth-secret.json");
  await fs.mkdir(opencodeDir, { recursive: true });
  await fs.writeFile(authPath, JSON.stringify(auth, null, 2));
  await fs.writeFile(authSecretPath, JSON.stringify(authSecret, null, 2));
  return { authPath, authSecretPath };
}

function powershellBinary(): string {
  const pwsh = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
    encoding: "utf8",
    windowsHide: true
  });
  return pwsh.status === 0 ? "pwsh" : "powershell";
}

function protectForDpapi(plainText: string): string {
  const result = spawnSync(
    powershellBinary(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "ConvertTo-SecureString -String $env:OPENCODE_SECRET_TEXT -AsPlainText -Force | ConvertFrom-SecureString"
    ],
    {
      encoding: "utf8",
      env: { ...process.env, OPENCODE_SECRET_TEXT: plainText },
      windowsHide: true
    }
  );
  assert.equal(result.status, 0, result.stderr || "Failed to protect DPAPI test secret");
  return String(result.stdout || "").trim();
}

test("claude oauth bootstraps a local token cache from opencode auth storage", async () => {
  await withClaudeOAuthEnv(async ({ shareDir, tokenFilePath }) => {
    await writeOpencodeAuthFiles({
      shareDir,
      auth: {
        anthropic: {
          type: "oauth",
          expires: 1_755_357_611_955
        }
      },
      authSecret: {
        anthropic: {
          type: "oauth",
          refresh: "refresh-from-opencode",
          access: "access-from-opencode"
        }
      }
    });

    const claudeOAuth = await importFreshClaudeOAuth("opencode-discovery");
    assert.equal(claudeOAuth.isClaudeOAuthConfigured(""), true);

    const state = claudeOAuth.createClaudeOAuthClient("");
    assert.equal(state.tokens.refreshToken, "refresh-from-opencode");
    assert.equal(state.tokens.accessToken, "access-from-opencode");
    assert.equal(state.tokens.expiresAt, 1_755_357_611_955);

    const mirrored = JSON.parse(await fs.readFile(tokenFilePath, "utf8")) as {
      refreshToken?: string;
      accessToken?: string;
      expiresAt?: number;
    };
    assert.deepEqual(mirrored, {
      refreshToken: "refresh-from-opencode",
      accessToken: "access-from-opencode",
      expiresAt: 1_755_357_611_955
    });
  });
});

test("claude oauth prefers fresher opencode auth over a stale local token cache", async () => {
  await withClaudeOAuthEnv(async ({ shareDir, tokenFilePath }) => {
    await fs.writeFile(
      tokenFilePath,
      JSON.stringify(
        {
          refreshToken: "stale-local-refresh",
          accessToken: "stale-local-access",
          expiresAt: 100
        },
        null,
        2
      )
    );

    await writeOpencodeAuthFiles({
      shareDir,
      auth: {
        anthropic: {
          type: "oauth",
          expires: 200
        }
      },
      authSecret: {
        anthropic: {
          type: "oauth",
          refresh: "refresh-from-opencode",
          access: "access-from-opencode"
        }
      }
    });

    const claudeOAuth = await importFreshClaudeOAuth("opencode-preferred-over-stale-local");
    const state = claudeOAuth.createClaudeOAuthClient("");

    assert.equal(state.tokens.refreshToken, "refresh-from-opencode");
    assert.equal(state.tokens.accessToken, "access-from-opencode");
    assert.equal(state.tokens.expiresAt, 200);

    const mirrored = JSON.parse(await fs.readFile(tokenFilePath, "utf8")) as {
      refreshToken?: string;
      accessToken?: string;
      expiresAt?: number;
    };
    assert.deepEqual(mirrored, {
      refreshToken: "refresh-from-opencode",
      accessToken: "access-from-opencode",
      expiresAt: 200
    });
  });
});

test("claude oauth refresh persists to clanky's local token cache after opencode bootstrap", async () => {
  await withClaudeOAuthEnv(async ({ shareDir, tokenFilePath }) => {
    const { authPath, authSecretPath } = await writeOpencodeAuthFiles({
      shareDir,
      auth: {
        anthropic: {
          type: "oauth",
          expires: 0
        }
      },
      authSecret: {
        anthropic: {
          type: "oauth",
          refresh: "stale-refresh-token",
          access: "stale-access-token"
        }
      }
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          access_token: "fresh-access-token",
          refresh_token: "fresh-refresh-token",
          expires_in: 3600
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    }) as typeof globalThis.fetch;

    try {
      const claudeOAuth = await importFreshClaudeOAuth("opencode-refresh");
      const state = claudeOAuth.createClaudeOAuthClient("");
      await state.ensureFresh();

      assert.equal(state.tokens.refreshToken, "fresh-refresh-token");
      assert.equal(state.tokens.accessToken, "fresh-access-token");
      assert.ok(state.tokens.expiresAt > Date.now());

      const localTokens = JSON.parse(await fs.readFile(tokenFilePath, "utf8")) as {
        refreshToken?: string;
        accessToken?: string;
        expiresAt?: number;
      };
      const auth = JSON.parse(await fs.readFile(authPath, "utf8")) as {
        anthropic?: { type?: string; expires?: number };
      };
      const authSecret = JSON.parse(await fs.readFile(authSecretPath, "utf8")) as {
        anthropic?: { type?: string; refresh?: string; access?: string };
      };

      assert.deepEqual(localTokens, {
        refreshToken: "fresh-refresh-token",
        accessToken: "fresh-access-token",
        expiresAt: state.tokens.expiresAt
      });
      assert.deepEqual(auth.anthropic, {
        type: "oauth",
        expires: 0
      });
      assert.deepEqual(authSecret.anthropic, {
        type: "oauth",
        refresh: "stale-refresh-token",
        access: "stale-access-token"
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

if (process.platform === "win32") {
  test("claude oauth bootstraps a local token cache from DPAPI-protected opencode Anthropic tokens", async () => {
    await withClaudeOAuthEnv(async ({ shareDir, tokenFilePath }) => {
      const protectedSecret = protectForDpapi(
        JSON.stringify({
          type: "oauth",
          refresh: "dpapi-refresh-token",
          access: "dpapi-access-token"
        })
      );

      await writeOpencodeAuthFiles({
        shareDir,
        auth: {
          anthropic: {
            type: "oauth",
            expires: 1_755_357_611_955
          }
        },
        authSecret: {
          anthropic: protectedSecret
        }
      });

      const claudeOAuth = await importFreshClaudeOAuth("opencode-dpapi-discovery");
      assert.equal(claudeOAuth.isClaudeOAuthConfigured(""), true);

      const state = claudeOAuth.createClaudeOAuthClient("");
      assert.equal(state.tokens.refreshToken, "dpapi-refresh-token");
      assert.equal(state.tokens.accessToken, "dpapi-access-token");
      assert.equal(state.tokens.expiresAt, 1_755_357_611_955);

      const mirrored = JSON.parse(await fs.readFile(tokenFilePath, "utf8")) as {
        refreshToken?: string;
        accessToken?: string;
        expiresAt?: number;
      };
      assert.deepEqual(mirrored, {
        refreshToken: "dpapi-refresh-token",
        accessToken: "dpapi-access-token",
        expiresAt: 1_755_357_611_955
      });
    });
  });
}
