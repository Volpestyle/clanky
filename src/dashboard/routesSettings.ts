import type { DashboardAppConfig, DashboardBot } from "../dashboard.ts";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { DashboardApp } from "./shared.ts";
import type { Store } from "../store/store.ts";
import { getLlmModelCatalog } from "../llm/pricing.ts";
import { isClaudeOAuthConfigured } from "../llm/claudeOAuth.ts";
import { isCodexOAuthConfigured } from "../llm/codexOAuth.ts";
import {
  getReplyGenerationSettings
} from "../settings/agentStack.ts";
import {
  buildDashboardSettingsEnvelope,
  type DashboardProviderAuthBindings
} from "../settings/dashboardSettingsState.ts";
import { normalizeSettings } from "../store/settingsNormalization.ts";
import { readDashboardBody, toRecord } from "./shared.ts";

interface SettingsRouteDeps {
  store: Store;
  bot: DashboardBot;
  appConfig: DashboardAppConfig;
}

export function attachSettingsRoutes(app: DashboardApp, deps: SettingsRouteDeps) {
  const { store, bot, appConfig } = deps;
  // Resolve per-request so freshly-saved OAuth tokens are reflected immediately.
  const getProviderAuth = () => resolveProviderAuth(appConfig);
  const applyNoStore = (c: { header(name: string, value: string): void }) => {
    c.header("Cache-Control", "no-store");
  };

  app.get("/api/health", (c) => {
    return c.json({ ok: true });
  });

  app.get("/api/settings", (c) => {
    applyNoStore(c);
    const current = store.getSettingsRecord();
    return c.json(buildSettingsResponse({
      intent: current.intent,
      effective: current.settings,
      providerAuth: getProviderAuth(),
      updatedAt: current.updatedAt
    }));
  });

  app.put("/api/settings", async (c) => {
    applyNoStore(c);
    const body = await readDashboardBody(c);
    const meta = toRecord(body._meta);
    const expectedUpdatedAt = String(meta.expectedUpdatedAt || "").trim();
    delete body._meta;

    const current = store.getSettingsRecord();
    if (!expectedUpdatedAt) {
      store.logAction({kind: "dashboard", content: "settings_save_rejected_no_version", metadata: { currentUpdatedAt: current.updatedAt }});
      return c.json(
        {
          error: "settings_version_required",
          detail: "Refresh the dashboard before saving. This tab is using an outdated settings form.",
          ...buildSettingsResponse({
            intent: current.intent,
            effective: current.settings,
            providerAuth: getProviderAuth(),
            updatedAt: current.updatedAt
          })
        },
        409
      );
    }

    if (current.updatedAt && expectedUpdatedAt !== current.updatedAt) {
      store.logAction({kind: "dashboard", content: "settings_save_rejected_stale", metadata: { expectedUpdatedAt, currentUpdatedAt: current.updatedAt }});
      return c.json(
        {
          error: "settings_conflict",
          detail: "Settings changed since this form was loaded. Reload the latest settings and try again.",
          ...buildSettingsResponse({
            intent: current.intent,
            effective: current.settings,
            providerAuth: getProviderAuth(),
            updatedAt: current.updatedAt
          })
        },
        409
      );
    }

    const saved = store.replaceSettingsWithVersion(body, expectedUpdatedAt);
    if (!saved.ok) {
      store.logAction({kind: "dashboard", content: "settings_save_rejected_cas_conflict", metadata: { expectedUpdatedAt, currentUpdatedAt: saved.updatedAt }});
      return c.json(
        {
          error: "settings_conflict",
          detail: "Settings changed while this save was being applied. Reload the latest settings and try again.",
          ...buildSettingsResponse({
            intent: saved.intent,
            effective: saved.settings,
            providerAuth: getProviderAuth(),
            updatedAt: saved.updatedAt
          })
        },
        409
      );
    }

    if (appConfig.dashboardSettingsSaveDebug) {
      store.logAction({kind: "dashboard", content: "settings_save_success", metadata: { previousUpdatedAt: current.updatedAt, updatedAt: saved.updatedAt }});
    }

    let saveAppliedToRuntime = true;
    let saveApplyError = "";
    let activeVoiceSessions = 0;
    try {
      await bot.applyRuntimeSettings(saved.settings);
      const runtimeState = typeof bot.getRuntimeState === "function" ? bot.getRuntimeState() : null;
      activeVoiceSessions = Math.max(0, Number(runtimeState?.voice?.activeCount) || 0);
      store.logAction({
        kind: "dashboard",
        content: "settings_runtime_applied",
        metadata: {
          source: "save",
          activeVoiceSessions,
          updatedAt: saved.updatedAt
        }
      });
    } catch (error) {
      saveAppliedToRuntime = false;
      saveApplyError = error instanceof Error ? error.message : String(error);
      store.logAction({kind: "dashboard", level: "error", content: "settings_save_runtime_apply_failed", metadata: { error: String(error?.message || error) }});
    }

    return c.json(
      buildSettingsResponse({
        intent: saved.intent,
        effective: saved.settings,
        providerAuth: getProviderAuth(),
        updatedAt: saved.updatedAt,
        saveAppliedToRuntime,
        ...(saveApplyError ? { saveApplyError } : {})
      })
    );
  });

  app.post("/api/settings/preset-defaults", async (c) => {
    applyNoStore(c);
    const body = await readDashboardBody(c);
    const preset = String(body.preset || "claude_oauth").trim();
    // Full reset for the selected preset.
    // Resolve from canonical normalization so preset-specific defaults
    // (like brain-path voice generation bindings) come from the preset itself,
    // not from whichever preset happens to back the raw schema defaults.
    // Preserve only server-specific routing configuration the operator set up.
    const current = store.getSettings();
    const settings = normalizeSettings({
      agentStack: { preset },
      permissions: current.permissions,
      voice: {
        channelPolicy: current.voice?.channelPolicy
      }
    });
    return c.json(buildSettingsResponse({
      intent: settings,
      effective: settings,
      providerAuth: getProviderAuth()
    }));
  });

  app.post("/api/settings/refresh", async (c) => {
    applyNoStore(c);
    if (!bot || typeof bot.applyRuntimeSettings !== "function") {
      return c.json(
        {
          ok: false,
          reason: "settings_refresh_unavailable"
        },
        503
      );
    }

    const settings = store.getSettings();
    await bot.applyRuntimeSettings(settings);
    const runtimeState = typeof bot.getRuntimeState === "function" ? bot.getRuntimeState() : null;
    const activeVoiceSessions = Number(runtimeState?.voice?.activeCount) || 0;
    store.logAction({
      kind: "dashboard",
      content: "settings_runtime_applied",
      metadata: {
        source: "refresh",
        activeVoiceSessions
      }
    });

    return c.json({
      ok: true,
      reason: "settings_refreshed",
      activeVoiceSessions
    });
  });

  // Legacy reset endpoint — same as preset-defaults with the default preset.
  // Preserves channel permissions, same as preset-defaults.
  app.post("/api/settings/reset", async (c) => {
    applyNoStore(c);
    const current = store.getSettings();
    const settings = normalizeSettings({
      permissions: current.permissions,
      voice: {
        channelPolicy: current.voice?.channelPolicy
      }
    });
    return c.json(buildSettingsResponse({
      intent: settings,
      effective: settings,
      providerAuth: getProviderAuth()
    }));
  });

  app.get("/api/llm/models", (c) => {
    const settings = store.getSettings();
    return c.json(getLlmModelCatalog(getReplyGenerationSettings(settings).pricing));
  });

  app.get("/api/elevenlabs/voices", async (c) => {
    const apiKey = appConfig.elevenLabsApiKey;
    if (!apiKey) {
      return c.json({ error: "ELEVENLABS_API_KEY not configured" }, 503);
    }

    const response = await fetch("https://api.elevenlabs.io/v1/voices?show_legacy=false", {
      headers: { "xi-api-key": apiKey }
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return c.json({ error: `ElevenLabs API error: ${response.status}`, detail: text }, toContentfulStatusCode(response.status));
    }
    return c.json(await response.json());
  });

  app.post("/api/elevenlabs/voices", async (c) => {
    const apiKey = appConfig.elevenLabsApiKey;
    if (!apiKey) {
      return c.json({ error: "ELEVENLABS_API_KEY not configured" }, 503);
    }

    const body = await readDashboardBody(c);
    const name = body.name;
    const description = body.description;
    const labels = body.labels;
    const removeBackgroundNoise = body.removeBackgroundNoise;
    const filesValue = body.files;

    if (!name || !Array.isArray(filesValue) || filesValue.length === 0) {
      return c.json({ error: "name and files (array of {name, dataBase64, mimeType}) are required" }, 400);
    }

    const formData = new FormData();
    formData.append("name", String(name));
    if (description) formData.append("description", String(description));
    if (labels) formData.append("labels", typeof labels === "string" ? labels : JSON.stringify(labels));
    if (removeBackgroundNoise) formData.append("remove_background_noise", "true");
    for (const file of filesValue) {
      if (!file || typeof file !== "object" || Array.isArray(file)) {
        continue;
      }
      const fileRecord = toRecord(file);
      const buffer = Buffer.from(String(fileRecord.dataBase64 || ""), "base64");
      const blob = new Blob([buffer], { type: String(fileRecord.mimeType || "audio/mpeg") });
      formData.append("files", blob, String(fileRecord.name || "sample.mp3"));
    }

    const response = await fetch("https://api.elevenlabs.io/v1/voices/add", {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: formData
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return c.json({ error: `ElevenLabs API error: ${response.status}`, detail: text }, toContentfulStatusCode(response.status));
    }
    return c.json(await response.json());
  });

  app.delete("/api/elevenlabs/voices/:voiceId", async (c) => {
    const apiKey = appConfig.elevenLabsApiKey;
    if (!apiKey) {
      return c.json({ error: "ELEVENLABS_API_KEY not configured" }, 503);
    }

    const voiceId = String(c.req.param("voiceId") || "").trim();
    if (!voiceId) {
      return c.json({ error: "voiceId is required" }, 400);
    }

    const response = await fetch(`https://api.elevenlabs.io/v1/voices/${encodeURIComponent(voiceId)}`, {
      method: "DELETE",
      headers: { "xi-api-key": apiKey }
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return c.json({ error: `ElevenLabs API error: ${response.status}`, detail: text }, toContentfulStatusCode(response.status));
    }
    return c.json({ ok: true });
  });

  app.get("/api/guilds", (c) => {
    try {
      const guilds = bot.getGuilds();
      return c.json(guilds.map((guild) => ({ id: guild.id, name: guild.name })));
    } catch {
      return c.json([]);
    }
  });

  app.get("/api/guilds/:guildId/channels", (c) => {
    try {
      const guildId = String(c.req.param("guildId") || "").trim();
      if (!guildId) {
        return c.json({ error: "guildId is required" }, 400);
      }
      return c.json(bot.getGuildChannels(guildId));
    } catch {
      return c.json([]);
    }
  });
}

function buildSettingsResponse({
  intent,
  effective,
  providerAuth,
  updatedAt = "",
  ...meta
}: {
  intent: unknown;
  effective?: unknown;
  providerAuth: DashboardProviderAuthBindings;
  updatedAt?: string;
  [key: string]: unknown;
}) {
  return buildDashboardSettingsEnvelope({
    intent,
    effective,
    providerAuth,
    meta: {
      updatedAt: String(updatedAt || ""),
      ...meta
    }
  });
}

function resolveProviderAuth(appConfig: DashboardAppConfig): DashboardProviderAuthBindings {
  return {
    claude_code:
      Boolean(appConfig.anthropicApiKey) ||
      isClaudeOAuthConfigured(appConfig.claudeOAuthRefreshToken || ""),
    codex_cli:
      Boolean(appConfig.openaiApiKey) ||
      isCodexOAuthConfigured(appConfig.openaiOAuthRefreshToken || ""),
    anthropic: Boolean(appConfig.anthropicApiKey),
    openai: Boolean(appConfig.openaiApiKey),
    claude_oauth: isClaudeOAuthConfigured(appConfig.claudeOAuthRefreshToken || ""),
    openai_oauth: isCodexOAuthConfigured(appConfig.openaiOAuthRefreshToken || ""),
    xai: Boolean(appConfig.xaiApiKey)
  };
}

function toContentfulStatusCode(status: number): ContentfulStatusCode {
  if (status === 101 || status === 204 || status === 205 || status === 304) {
    return 500;
  }

  return status as ContentfulStatusCode;
}
