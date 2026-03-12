export const CONVERSATION_SEARCH_POLICY_LINE =
  "conversation_search: recall earlier text or voice exchanges when someone asks what was said earlier or wants a prior exchange recalled.";

export const WEB_SCRAPE_POLICY_LINE =
  "web_scrape: use it when you already have a URL and mainly need readable page text, including a URL you just got from web_search.";

export const BROWSER_BROWSE_POLICY_LINE =
  "browser_browse: use it when the user explicitly wants browser use, asks what a page looks like, asks for a screenshot, when visual layout matters, or when you need JS rendering, navigation, or interaction.";

export const BROWSER_SCREENSHOT_POLICY_LINE =
  "browser_browse can capture browser screenshots and return them for visual inspection. Do not say webpage screenshots are impossible when browser_browse is available.";

export const IMMEDIATE_WEB_SEARCH_POLICY_LINE =
  "When users ask you to look something up, search for something, find prices, or need current factual information, call web_search in the same response instead of only saying you will search.";

export function buildWebSearchPolicyLine({ onePerTurn = false }: { onePerTurn?: boolean } = {}) {
  return `web_search: use it for fresh discovery or current facts when accuracy depends on live web information.${onePerTurn ? " One per turn." : ""}`;
}

export function buildWebToolRoutingPolicyLine(
  { includeBrowserBrowse = true }: { includeBrowserBrowse?: boolean } = {}
) {
  if (!includeBrowserBrowse) {
    return "Prefer the lightest sufficient web tool: use web_search for fresh discovery or current facts, and use web_scrape when you already have a URL and mainly need readable page text.";
  }
  return "Choose the web tool that best fits the task. Prefer the lightest sufficient tool, not a fixed ladder: use web_search for fresh discovery or current facts, web_scrape when you already have a URL and mainly need readable page text, and browser_browse when you need JS rendering, visual layout, screenshots, navigation, or interaction.";
}

export function buildActiveCuriosityCapabilityLine(
  {
    includeWebSearch = true,
    includeWebScrape = true,
    includeBrowserBrowse = true
  }: {
    includeWebSearch?: boolean;
    includeWebScrape?: boolean;
    includeBrowserBrowse?: boolean;
  } = {}
) {
  const capabilityLines: string[] = [];
  if (includeWebSearch) {
    capabilityLines.push("web_search for fresh discovery or current facts");
  }
  if (includeWebScrape) {
    capabilityLines.push(
      includeWebSearch
        ? "web_scrape to read a known URL, including one you just got from web_search"
        : "web_scrape to read a known URL"
    );
  }
  if (includeBrowserBrowse) {
    capabilityLines.push(
      "browser_browse to actually visit a site, inspect how a page looks, capture browser screenshots for visual inspection, or move through it interactively when layout, JS, or navigation matter"
    );
  }

  if (capabilityLines.length <= 0) {
    return "Active-curiosity web tools are unavailable right now.";
  }
  if (capabilityLines.length === 1) {
    return `You can use ${capabilityLines[0]}.`;
  }
  if (capabilityLines.length === 2) {
    return `You can use ${capabilityLines[0]}, and ${capabilityLines[1]}.`;
  }
  return `You can use ${capabilityLines.slice(0, -1).join(", ")}, or ${capabilityLines[capabilityLines.length - 1]}.`;
}
