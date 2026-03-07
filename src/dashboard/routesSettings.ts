import type { DashboardAppConfig, DashboardBot } from "../dashboard.ts";
import type { DashboardApp } from "./shared.ts";
import type { Store } from "../store/store.ts";
import { getLlmModelCatalog } from "../llm/pricing.ts";
import { getReplyGenerationSettings } from "../settings/agentStack.ts";
import { readDashboardBody } from "./shared.ts";

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
    return c.json(store.getSettings());
  });

  app.put("/api/settings", async (c) => {
    const nextSettings = store.patchSettings(await readDashboardBody(c));
    await bot.applyRuntimeSettings(nextSettings);
    return c.json(nextSettings);
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

  app.post("/api/settings/reset", async (c) => {
    const nextSettings = store.resetSettings();
    await bot.applyRuntimeSettings(nextSettings);
    return c.json(nextSettings);
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
      return Response.json({ error: `ElevenLabs API error: ${response.status}`, detail: text }, { status: response.status });
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
      return Response.json({ error: `ElevenLabs API error: ${response.status}`, detail: text }, { status: response.status });
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
      return Response.json({ error: `ElevenLabs API error: ${response.status}`, detail: text }, { status: response.status });
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

function toRecord(value: object) {
  const record: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    record[key] = entry;
  }
  return record;
}
