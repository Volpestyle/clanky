import { getLlmModelCatalog } from "../pricing.ts";
import { getReplyGenerationSettings } from "../settings/agentStack.ts";

export function attachSettingsRoutes(app: any, deps: any) {
  const { store, bot, appConfig } = deps;
  
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/settings", (_req, res) => {
    res.json(store.getSettings());
  });

  app.put("/api/settings", async (req, res, next) => {
    try {
      const nextSettings = store.patchSettings(req.body || {});
      await bot.applyRuntimeSettings(nextSettings);
      res.json(nextSettings);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/settings/refresh", async (_req, res, next) => {
    try {
      if (!bot || typeof bot.applyRuntimeSettings !== "function") {
        return res.status(503).json({
          ok: false,
          reason: "settings_refresh_unavailable"
        });
      }

      const settings = store.getSettings();
      await bot.applyRuntimeSettings(settings);
      const runtimeState =
        typeof bot.getRuntimeState === "function"
          ? bot.getRuntimeState()
          : null;
      const activeVoiceSessions = Number(runtimeState?.voice?.activeCount) || 0;

      return res.json({
        ok: true,
        reason: "settings_refreshed",
        activeVoiceSessions
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/settings/reset", async (_req, res, next) => {
    try {
      const nextSettings = store.resetSettings();
      await bot.applyRuntimeSettings(nextSettings);
      res.json(nextSettings);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/llm/models", (_req, res) => {
    const settings = store.getSettings();
    res.json(getLlmModelCatalog(getReplyGenerationSettings(settings).pricing));
  });

  app.get("/api/elevenlabs/voices", async (_req, res, next) => {
    try {
      const apiKey = appConfig.elevenLabsApiKey;
      if (!apiKey) {
        return res.status(503).json({ error: "ELEVENLABS_API_KEY not configured" });
      }
      const response = await fetch("https://api.elevenlabs.io/v1/voices?show_legacy=false", {
        headers: { "xi-api-key": apiKey }
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return res.status(response.status).json({ error: `ElevenLabs API error: ${response.status}`, detail: text });
      }
      const data = await response.json();
      return res.json(data);
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/elevenlabs/voices", async (req, res, next) => {
    try {
      const apiKey = appConfig.elevenLabsApiKey;
      if (!apiKey) {
        return res.status(503).json({ error: "ELEVENLABS_API_KEY not configured" });
      }
      const { name, description, labels, removeBackgroundNoise, files } = req.body || {};
      if (!name || !files || !Array.isArray(files) || files.length === 0) {
        return res.status(400).json({ error: "name and files (array of {name, dataBase64, mimeType}) are required" });
      }
      const formData = new FormData();
      formData.append("name", String(name));
      if (description) formData.append("description", String(description));
      if (labels) formData.append("labels", typeof labels === "string" ? labels : JSON.stringify(labels));
      if (removeBackgroundNoise) formData.append("remove_background_noise", "true");
      for (const file of files) {
        const buffer = Buffer.from(String(file.dataBase64 || ""), "base64");
        const blob = new Blob([buffer], { type: String(file.mimeType || "audio/mpeg") });
        formData.append("files", blob, String(file.name || "sample.mp3"));
      }
      const response = await fetch("https://api.elevenlabs.io/v1/voices/add", {
        method: "POST",
        headers: { "xi-api-key": apiKey },
        body: formData
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return res.status(response.status).json({ error: `ElevenLabs API error: ${response.status}`, detail: text });
      }
      const data = await response.json();
      return res.json(data);
    } catch (error) {
      return next(error);
    }
  });

  app.delete("/api/elevenlabs/voices/:voiceId", async (req, res, next) => {
    try {
      const apiKey = appConfig.elevenLabsApiKey;
      if (!apiKey) {
        return res.status(503).json({ error: "ELEVENLABS_API_KEY not configured" });
      }
      const voiceId = String(req.params?.voiceId || "").trim();
      if (!voiceId) {
        return res.status(400).json({ error: "voiceId is required" });
      }
      const response = await fetch(`https://api.elevenlabs.io/v1/voices/${encodeURIComponent(voiceId)}`, {
        method: "DELETE",
        headers: { "xi-api-key": apiKey }
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return res.status(response.status).json({ error: `ElevenLabs API error: ${response.status}`, detail: text });
      }
      return res.json({ ok: true });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/guilds", (_req, res) => {
    try {
      const guilds = bot.getGuilds();
      res.json(guilds.map((g) => ({ id: g.id, name: g.name })));
    } catch {
      res.json([]);
    }
  });

  app.get("/api/guilds/:guildId/channels", (req, res) => {
    try {
      const guildId = String(req.params?.guildId || "").trim();
      if (!guildId) return res.status(400).json({ error: "guildId is required" });
      const channels = bot.getGuildChannels(guildId);
      return res.json(channels);
    } catch {
      return res.json([]);
    }
  });
}
