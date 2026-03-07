import { deepMerge, clamp } from "../utils.ts";
import { getResearchRuntimeConfig } from "../settings/agentStack.ts";
import { normalizeInlineText } from "./voiceSessionHelpers.ts";
import type { VoiceRealtimeToolSettings, VoiceSession, VoiceToolRuntimeSessionLike } from "./voiceSessionTypes.ts";
import type { VoiceToolCallArgs, VoiceToolCallManager } from "./voiceToolCallTypes.ts";

type ToolRuntimeSession = VoiceSession | VoiceToolRuntimeSessionLike;

type VoiceWebToolOptions = {
  session?: ToolRuntimeSession | null;
  settings?: VoiceRealtimeToolSettings | null;
  args?: VoiceToolCallArgs;
};

type VoiceWebScrapeToolOptions = {
  session?: ToolRuntimeSession | null;
  args?: VoiceToolCallArgs;
};

export async function executeVoiceWebSearchTool(
  manager: VoiceToolCallManager,
  { session, settings, args }: VoiceWebToolOptions
) {
  const query = normalizeInlineText(args?.query, 240);
  if (!query) {
    return { ok: false, results: [], answer: "", error: "query_required" };
  }
  if (!manager.search || typeof manager.search.searchAndRead !== "function") {
    return { ok: false, results: [], answer: "", error: "web_search_unavailable" };
  }

  const researchConfig = getResearchRuntimeConfig(settings);
  const maxResults = clamp(Math.floor(Number(args?.max_results || 5)), 1, 8);
  const recencyDays = clamp(
    Math.floor(Number(args?.recency_days || researchConfig.localExternalSearch.recencyDaysDefault || 30)),
    1,
    3650
  );
  const toolSettings = deepMerge(deepMerge({}, settings || {}), {
    agentStack: {
      runtimeConfig: {
        research: {
          ...researchConfig,
          enabled: true,
          localExternalSearch: {
            ...researchConfig.localExternalSearch,
            maxResults,
            recencyDaysDefault: recencyDays
          }
        }
      }
    }
  });

  const searchResult = await manager.search.searchAndRead({
    settings: toolSettings,
    query,
    trace: {
      guildId: session?.guildId,
      channelId: session?.textChannelId,
      userId: session?.lastOpenAiToolCallerUserId || null,
      source: "voice_realtime_tool_web_search"
    }
  });
  const rows = (Array.isArray(searchResult?.results) ? searchResult.results : [])
    .slice(0, maxResults)
    .map((row) => ({
      title: normalizeInlineText(row?.title || row?.pageTitle, 220) || "",
      snippet: normalizeInlineText(row?.snippet || row?.pageSummary, 420) || "",
      url: normalizeInlineText(row?.url, 300) || "",
      source: normalizeInlineText(row?.provider, 60) || searchResult?.providerUsed || "web"
    }));
  const answer = [
    normalizeInlineText(searchResult?.summaryText, 1200),
    rows.slice(0, 3).map((row) => row.snippet).filter(Boolean).join(" ")
  ].filter(Boolean).join(" ").slice(0, 1200);

  return { ok: true, query, recency_days: recencyDays, results: rows, answer };
}

export async function executeVoiceWebScrapeTool(
  manager: VoiceToolCallManager,
  { session: _session, args }: VoiceWebScrapeToolOptions
) {
  void _session;
  const url = String(args?.url || "").trim().slice(0, 2000);
  if (!url) {
    return { ok: false, text: "", error: "url_required" };
  }
  if (!manager.search || typeof manager.search.readPageSummary !== "function") {
    return { ok: false, text: "", error: "web_scrape_unavailable" };
  }

  const maxChars = clamp(Math.floor(Number(args?.max_chars) || 8000), 350, 24000);
  try {
    const result = await manager.search.readPageSummary(url, maxChars);
    const title = result?.title ? String(result.title).trim() : null;
    const body = String(result?.summary || "").trim();
    if (!body) {
      return {
        ok: true,
        text: `Page at ${url} returned no readable content. Try browser_browse for JS-rendered pages.`,
        title: null,
        url
      };
    }
    return { ok: true, title, url, text: body };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      text: "",
      url,
      error: `${message}. If the page requires JavaScript or interaction, try browser_browse.`
    };
  }
}
