import dotenv from "dotenv";
import { normalizeLlmProvider } from "./llm/llmHelpers.ts";
import { parseBooleanFlag, parseNumberOrFallback } from "./normalization/valueParsers.ts";

dotenv.config();

export const appConfig = {
  discordToken: process.env.DISCORD_TOKEN ?? "",
  dashboardPort: parseNumberOrFallback(process.env.DASHBOARD_PORT, 8787),
  dashboardHost: normalizeDashboardHost(process.env.DASHBOARD_HOST),
  dashboardToken: process.env.DASHBOARD_TOKEN ?? "",
  publicApiToken: process.env.PUBLIC_API_TOKEN ?? "",
  publicHttpsEnabled: parseBooleanFlag(process.env.PUBLIC_HTTPS_ENABLED, false),
  publicHttpsTargetUrl: process.env.PUBLIC_HTTPS_TARGET_URL ?? "",
  publicHttpsCloudflaredBin: process.env.PUBLIC_HTTPS_CLOUDFLARED_BIN ?? "cloudflared",
  publicShareSessionTtlMinutes: parseNumberOrFallback(process.env.PUBLIC_SHARE_SESSION_TTL_MINUTES, 12),
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY ?? "",
  geminiApiKey: process.env.GOOGLE_API_KEY ?? "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  xaiApiKey: process.env.XAI_API_KEY ?? "",
  xaiBaseUrl: process.env.XAI_BASE_URL ?? "https://api.x.ai/v1",
  braveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY ?? "",
  serpApiKey: process.env.SERPAPI_API_KEY ?? "",
  giphyApiKey: process.env.GIPHY_API_KEY ?? "",
  giphyRating: process.env.GIPHY_RATING ?? "pg-13",
  youtubeApiKey: String(process.env.YOUTUBE_API_KEY || process.env.GOOGLE_API_KEY || "").trim(),
  soundcloudClientId: process.env.SOUNDCLOUD_CLIENT_ID ?? "",
  defaultProvider: normalizeLlmProvider(process.env.DEFAULT_PROVIDER, "anthropic"),
  defaultOpenAiModel: process.env.DEFAULT_MODEL_OPENAI ?? "claude-haiku-4-5",
  defaultAnthropicModel: process.env.DEFAULT_MODEL_ANTHROPIC ?? "claude-haiku-4-5",
  defaultXaiModel: process.env.DEFAULT_MODEL_XAI ?? "grok-3-mini-latest",
  defaultClaudeCodeModel: process.env.DEFAULT_MODEL_CLAUDE_CODE ?? "sonnet",
  defaultCodexCliModel: process.env.DEFAULT_MODEL_CODEX_CLI ?? "gpt-5.4",
  defaultMemoryEmbeddingModel: process.env.DEFAULT_MEMORY_EMBEDDING_MODEL ?? "text-embedding-3-small",
  voiceMcpServers: parseVoiceMcpServers(process.env.VOICE_MCP_SERVERS_JSON),
  runtimeStructuredLogsEnabled: parseBooleanFlag(process.env.RUNTIME_STRUCTURED_LOGS_ENABLED, true),
  runtimeStructuredLogsStdout: parseBooleanFlag(process.env.RUNTIME_STRUCTURED_LOGS_STDOUT, true),
  runtimeStructuredLogsFilePath:
    process.env.RUNTIME_STRUCTURED_LOGS_FILE_PATH ?? "data/logs/runtime-actions.ndjson"
};

export function ensureRuntimeEnv() {
  if (!appConfig.discordToken) {
    throw new Error("Missing DISCORD_TOKEN in environment.");
  }
}

export function normalizeDashboardHost(value) {
  const normalized = String(value || "").trim();
  return normalized || "127.0.0.1";
}

function parseVoiceMcpServers(rawValue) {
  const text = String(rawValue || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const serverName = String(entry.serverName || entry.name || "").trim().slice(0, 80);
        const baseUrl = String(entry.baseUrl || "").trim().replace(/\/+$/, "");
        if (!serverName || !baseUrl) return null;
        const tools = Array.isArray(entry.tools)
          ? entry.tools
              .map((tool) => {
                if (!tool || typeof tool !== "object") return null;
                const name = String(tool.name || "").trim().slice(0, 120);
                if (!name) return null;
                const description = String(tool.description || "").trim().slice(0, 800);
                const inputSchema =
                  tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
                    ? tool.inputSchema
                    : {
                        type: "object",
                        additionalProperties: true
                      };
                return {
                  name,
                  description,
                  inputSchema
                };
              })
              .filter(Boolean)
          : [];
        const headers =
          entry.headers && typeof entry.headers === "object" && !Array.isArray(entry.headers)
            ? Object.fromEntries(
                Object.entries(entry.headers).map(([headerName, headerValue]) => [
                  String(headerName || "").trim().slice(0, 120),
                  String(headerValue || "").trim().slice(0, 300)
                ])
              )
            : {};
        return {
          serverName,
          baseUrl,
          toolPath: String(entry.toolPath || "/tools/call").trim() || "/tools/call",
          timeoutMs: Math.max(500, Math.min(60_000, Math.round(Number(entry.timeoutMs) || 10_000))),
          headers,
          tools
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}
