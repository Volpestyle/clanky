import { test } from "bun:test";
import assert from "node:assert/strict";

const CONFIG_ENV_KEYS = [
  "DISCORD_TOKEN",
  "DASHBOARD_PORT",
  "DASHBOARD_HOST",
  "DASHBOARD_TOKEN",
  "PUBLIC_API_TOKEN",
  "PUBLIC_HTTPS_ENABLED",
  "PUBLIC_HTTPS_TARGET_URL",
  "PUBLIC_HTTPS_CLOUDFLARED_BIN",
  "PUBLIC_SHARE_SESSION_TTL_MINUTES",
  "OPENAI_API_KEY",
  "ELEVENLABS_API_KEY",
  "GOOGLE_API_KEY",
  "ANTHROPIC_API_KEY",
  "XAI_API_KEY",
  "XAI_BASE_URL",
  "BRAVE_SEARCH_API_KEY",
  "SERPAPI_API_KEY",
  "GIPHY_API_KEY",
  "GIPHY_RATING",
  "YOUTUBE_API_KEY",
  "SOUNDCLOUD_CLIENT_ID",
  "SPOTIFY_CLIENT_ID",
  "SPOTIFY_CLIENT_SECRET",
  "SPOTIFY_REFRESH_TOKEN",
  "SPOTIFY_DEVICE_ID",
  "SPOTIFY_MARKET",
  "DEFAULT_PROVIDER",
  "DEFAULT_MODEL_OPENAI",
  "DEFAULT_MODEL_ANTHROPIC",
  "DEFAULT_MODEL_XAI",
  "DEFAULT_MODEL_CLAUDE_OAUTH",
  "DEFAULT_MODEL_CODEX_CLI",
  "DEFAULT_MEMORY_EMBEDDING_MODEL"
];

async function withConfigEnv(overrides, run) {
  const saved = new Map();
  for (const key of CONFIG_ENV_KEYS) {
    saved.set(key, process.env[key]);
    process.env[key] = "";
  }

  for (const [key, value] of Object.entries(overrides || {})) {
    process.env[key] = String(value);
  }

  try {
    await run();
  } finally {
    for (const key of CONFIG_ENV_KEYS) {
      const prior = saved.get(key);
      if (prior === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prior;
      }
    }
  }
}

async function importFreshConfig(seed) {
  const stamp = `${seed}-${Date.now()}-${Math.random()}`;
  return import(`./config.ts?${stamp}`);
}

test("config parses explicit env values", async () => {
  await withConfigEnv(
    {
      DISCORD_TOKEN: "token-1",
      DASHBOARD_PORT: "9191",
      DASHBOARD_HOST: "0.0.0.0",
      PUBLIC_HTTPS_ENABLED: "YES",
      PUBLIC_SHARE_SESSION_TTL_MINUTES: "25",
      DEFAULT_PROVIDER: "claude-oauth",
      DEFAULT_MODEL_OPENAI: "claude-haiku-4-5",
      DEFAULT_MODEL_ANTHROPIC: "claude-sonnet-4-5",
      DEFAULT_MODEL_XAI: "grok-4-latest",
      DEFAULT_MODEL_CLAUDE_OAUTH: "claude-opus-4-6",
      DEFAULT_MODEL_CODEX_CLI: "gpt-5.4",
      GIPHY_RATING: "PG",
      XAI_BASE_URL: "https://x.ai/custom",
      YOUTUBE_API_KEY: "youtube-api-key",
      SOUNDCLOUD_CLIENT_ID: "soundcloud-client-id"
    },
    async () => {
      const { appConfig, ensureRuntimeEnv } = await importFreshConfig("explicit");
      assert.equal(appConfig.discordToken, "token-1");
      assert.equal(appConfig.dashboardPort, 9191);
      assert.equal(appConfig.dashboardHost, "0.0.0.0");
      assert.equal(appConfig.publicHttpsEnabled, true);
      assert.equal(appConfig.publicShareSessionTtlMinutes, 25);
      assert.equal(appConfig.defaultProvider, "claude-oauth");
      assert.equal(appConfig.defaultOpenAiModel, "claude-haiku-4-5");
      assert.equal(appConfig.defaultAnthropicModel, "claude-sonnet-4-5");
      assert.equal(appConfig.defaultXaiModel, "grok-4-latest");
      assert.equal(appConfig.defaultClaudeOAuthModel, "claude-opus-4-6");
      assert.equal(appConfig.defaultCodexCliModel, "gpt-5.4");
      assert.equal(appConfig.giphyRating, "PG");
      assert.equal(appConfig.xaiBaseUrl, "https://x.ai/custom");
      assert.equal(appConfig.youtubeApiKey, "youtube-api-key");
      assert.equal(appConfig.soundcloudClientId, "soundcloud-client-id");
      assert.doesNotThrow(() => ensureRuntimeEnv());
    }
  );
});

test("config falls back for invalid values", async () => {
  await withConfigEnv(
    {
      DISCORD_TOKEN: "",
      DASHBOARD_PORT: "not-a-number",
      DASHBOARD_HOST: "   ",
      PUBLIC_HTTPS_ENABLED: "maybe",
      PUBLIC_SHARE_SESSION_TTL_MINUTES: "bad",
      DEFAULT_PROVIDER: "not-supported"
    },
    async () => {
      const { appConfig, ensureRuntimeEnv } = await importFreshConfig("fallbacks");
      assert.equal(appConfig.dashboardPort, 8787);
      assert.equal(appConfig.dashboardHost, "127.0.0.1");
      assert.equal(appConfig.publicHttpsEnabled, false);
      assert.equal(appConfig.publicShareSessionTtlMinutes, 12);
      assert.equal(appConfig.defaultProvider, "anthropic");
      assert.throws(() => ensureRuntimeEnv(), /Missing DISCORD_TOKEN/);
    }
  );
});

test("config falls back youtube key to GOOGLE_API_KEY", async () => {
  await withConfigEnv(
    {
      DISCORD_TOKEN: "token-youtube-fallback",
      GOOGLE_API_KEY: "google-api-key",
      YOUTUBE_API_KEY: ""
    },
    async () => {
      const { appConfig } = await importFreshConfig("youtube-key-fallback");
      assert.equal(appConfig.youtubeApiKey, "google-api-key");
    }
  );
});

test("config accepts other provider normalizations", async () => {
  await withConfigEnv(
    {
      DISCORD_TOKEN: "token-2",
      DEFAULT_PROVIDER: "anthropic"
    },
    async () => {
      const { appConfig } = await importFreshConfig("provider-anthropic");
      assert.equal(appConfig.defaultProvider, "anthropic");
    }
  );

  await withConfigEnv(
    {
      DISCORD_TOKEN: "token-3",
      DEFAULT_PROVIDER: "xai"
    },
    async () => {
      const { appConfig } = await importFreshConfig("provider-xai");
      assert.equal(appConfig.defaultProvider, "xai");
    }
  );
});
