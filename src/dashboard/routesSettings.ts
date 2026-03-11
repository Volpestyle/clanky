import type { DashboardAppConfig, DashboardBot } from "../dashboard.ts";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { DashboardApp } from "./shared.ts";
import type { Store } from "../store/store.ts";
import { getLlmModelCatalog } from "../llm/pricing.ts";
import { isClaudeOAuthConfigured } from "../llm/claudeOAuth.ts";
import { isCodexOAuthConfigured } from "../llm/codexOAuth.ts";
import {
  getReplyGenerationSettings,
  getResolvedOrchestratorBinding,
  getResolvedFollowupBinding,
  getResolvedMemoryBinding,
  getResolvedTextInitiativeBinding,
  getResolvedVisionBinding,
  getResolvedVoiceInitiativeBinding,
  getResolvedVoiceAdmissionClassifierBinding,
  getResolvedVoiceInterruptClassifierBinding,
  getResolvedVoiceMusicBrainBinding,
  getResolvedVoiceGenerationBinding,
  getVoiceRuntimeConfig,
  resolveAgentStack
} from "../settings/agentStack.ts";
import {
  resolveVoiceRuntimeSelectionFromMode
} from "../settings/voiceDashboardMappings.ts";
import { normalizeSettings } from "../store/settingsNormalization.ts";
import { readDashboardBody, toRecord } from "./shared.ts";

export interface SettingsRouteDeps {
  store: Store;
  bot: DashboardBot;
  appConfig: DashboardAppConfig;
}

export function attachSettingsRoutes(app: DashboardApp, deps: SettingsRouteDeps) {
  const { store, bot, appConfig } = deps;

  app.get("/api/health", (c) => {
    return c.json({ ok: true });
  });

  app.get("/api/settings", (c) => {
    const current = store.getSettingsRecord();
    return c.json(buildSettingsResponse(current.settings, appConfig, current.updatedAt));
  });

  app.put("/api/settings", async (c) => {
    const body = await readDashboardBody(c);
    const meta = toRecord(body._meta);
    const expectedUpdatedAt = String(meta.expectedUpdatedAt || "").trim();
    delete body._meta;

    const current = store.getSettingsRecord();
    if (!expectedUpdatedAt) {
      return c.json(
        {
          error: "settings_version_required",
          detail: "Refresh the dashboard before saving. This tab is using an outdated settings form.",
          ...buildSettingsResponse(current.settings, appConfig, current.updatedAt)
        },
        409
      );
    }

    if (current.updatedAt && expectedUpdatedAt !== current.updatedAt) {
      return c.json(
        {
          error: "settings_conflict",
          detail: "Settings changed since this form was loaded. Reload the latest settings and try again.",
          ...buildSettingsResponse(current.settings, appConfig, current.updatedAt)
        },
        409
      );
    }

    const saved = store.patchSettingsWithVersion(body, expectedUpdatedAt);
    if (!saved.ok) {
      return c.json(
        {
          error: "settings_conflict",
          detail: "Settings changed while this save was being applied. Reload the latest settings and try again.",
          ...buildSettingsResponse(saved.settings, appConfig, saved.updatedAt)
        },
        409
      );
    }

    let saveAppliedToRuntime = true;
    let saveApplyError = "";
    try {
      await bot.applyRuntimeSettings(saved.settings);
    } catch (error) {
      saveAppliedToRuntime = false;
      saveApplyError = error instanceof Error ? error.message : String(error);
      console.error("Saved settings, but failed to apply them to the live runtime:", error);
    }

    return c.json(
      buildSettingsResponse(saved.settings, appConfig, saved.updatedAt, {
        saveAppliedToRuntime,
        ...(saveApplyError ? { saveApplyError } : {})
      })
    );
  });

  app.post("/api/settings/preset-defaults", async (c) => {
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
    return c.json({ ...settings, _resolved: resolveSettingsBindings(settings, appConfig) });
  });

  app.post("/api/settings/refresh", async (c) => {
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

    return c.json({
      ok: true,
      reason: "settings_refreshed",
      activeVoiceSessions
    });
  });

  // Legacy reset endpoint — same as preset-defaults with the default preset.
  // Preserves channel permissions, same as preset-defaults.
  app.post("/api/settings/reset", async (c) => {
    const current = store.getSettings();
    const settings = normalizeSettings({
      permissions: current.permissions,
      voice: {
        channelPolicy: current.voice?.channelPolicy
      }
    });
    return c.json({ ...settings, _resolved: resolveSettingsBindings(settings, appConfig) });
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

function buildSettingsResponse(
  settings: unknown,
  appConfig: DashboardAppConfig,
  updatedAt: string,
  extraMeta: Record<string, unknown> = {}
) {
  const settingsRecord = toRecord(settings);
  return {
    ...settingsRecord,
    _resolved: resolveSettingsBindings(settings, appConfig),
    _meta: {
      updatedAt: String(updatedAt || ""),
      ...extraMeta
    }
  };
}

function resolveSettingsBindings(settings: unknown, appConfig: DashboardAppConfig) {
  return {
    agentStack: resolveAgentStack(settings),
    orchestrator: getResolvedOrchestratorBinding(settings),
    followupBinding: getResolvedFollowupBinding(settings),
    memoryBinding: getResolvedMemoryBinding(settings),
    textInitiativeBinding: getResolvedTextInitiativeBinding(settings),
    visionBinding: getResolvedVisionBinding(settings),
    voiceProvider: resolveVoiceRuntimeSelectionFromMode(getVoiceRuntimeConfig(settings).runtimeMode),
    voiceInitiativeBinding: getResolvedVoiceInitiativeBinding(settings),
    voiceAdmissionClassifierBinding: getResolvedVoiceAdmissionClassifierBinding(settings),
    voiceInterruptClassifierBinding: getResolvedVoiceInterruptClassifierBinding(settings),
    voiceMusicBrainBinding: getResolvedVoiceMusicBrainBinding(settings),
    voiceGenerationBinding: getResolvedVoiceGenerationBinding(settings),
    providerAuth: {
      claude_code:
        Boolean(appConfig.anthropicApiKey) ||
        isClaudeOAuthConfigured(appConfig.claudeOAuthRefreshToken || ""),
      codex_cli:
        Boolean(appConfig.openaiApiKey) ||
        isCodexOAuthConfigured(appConfig.openaiOAuthRefreshToken || ""),
      codex:
        Boolean(appConfig.openaiApiKey) ||
        isCodexOAuthConfigured(appConfig.openaiOAuthRefreshToken || "")
    }
  };
}

function toContentfulStatusCode(status: number): ContentfulStatusCode {
  if (status === 101 || status === 204 || status === 205 || status === 304) {
    return 500;
  }

  return status as ContentfulStatusCode;
}
