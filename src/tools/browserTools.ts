import type Anthropic from "@anthropic-ai/sdk";
import type { ImageInput } from "../llm/serviceShared.ts";
import type { BrowserManager } from "../services/BrowserManager.ts";

interface BrowserOpenParams { url: string }
interface BrowserSnapshotParams { interactive_only?: boolean }
interface BrowserClickParams { ref: string }
interface BrowserTypeParams { ref: string; text: string; pressEnter?: boolean }
interface BrowserScrollParams { direction: "up" | "down"; pixels?: number }
interface BrowserExtractParams { ref?: string }

type BrowserToolParams =
  | BrowserOpenParams
  | BrowserSnapshotParams
  | BrowserClickParams
  | BrowserTypeParams
  | BrowserScrollParams
  | BrowserExtractParams
  | Record<string, never>;

export type BrowserToolResult = {
  text: string;
  imageInputs?: ImageInput[];
  isError?: boolean;
};

function buildBrowserTextResult(text: string): BrowserToolResult {
  const normalizedText = String(text || "");
  return {
    text: normalizedText,
    isError: normalizedText.toLowerCase().startsWith("error:")
  };
}

function parseBrowserScreenshotDataUrl(dataUrl: string): ImageInput | null {
  const normalized = String(dataUrl || "").trim();
  const match = normalized.match(/^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i);
  if (!match) return null;

  const mediaType = String(match[1] || "").trim().toLowerCase();
  const dataBase64 = String(match[2] || "").trim();
  if (!mediaType || !dataBase64) return null;
  return {
    mediaType,
    dataBase64
  };
}

export const BROWSER_AGENT_TOOL_DEFINITIONS: Array<{
  name: string;
  description: string;
  input_schema: Anthropic.Tool.InputSchema;
}> = [
    {
      name: "browser_open",
      description: "Opens a URL in the headless browser and returns the initial snapshot. Always use this first before interacting with a page.",
      input_schema: {
        type: "object",
        properties: {
          url: { type: "string", description: "The fully qualified URL to open (e.g. https://example.com)" }
        },
        required: ["url"]
      }
    },
    {
      name: "browser_snapshot",
      description: "Takes a snapshot of the current page's accessibility tree, showing interactive elements with refs (e.g. @e1).",
      input_schema: {
        type: "object",
        properties: {
          interactive_only: {
            type: "boolean",
            description: "If true, only returns interactive elements. Default true."
          }
        }
      }
    },
    {
      name: "browser_click",
      description: "Clicks an element on the active page via its reference ID. Returns the new snapshot after the click.",
      input_schema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "The reference ID of the element (e.g. @e4)" }
        },
        required: ["ref"]
      }
    },
    {
      name: "browser_type",
      description: "Types text into an input element.",
      input_schema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "The reference ID of the input field (e.g. @e2)" },
          text: { type: "string", description: "The text to type" },
          pressEnter: { type: "boolean", description: "Press Enter after typing (default true)" }
        },
        required: ["ref", "text"]
      }
    },
    {
      name: "browser_scroll",
      description: "Scrolls the page up or down.",
      input_schema: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["up", "down"], description: "Scroll direction" },
          pixels: { type: "number", description: "Pixels to scroll (default 800)" }
        },
        required: ["direction"]
      }
    },
    {
      name: "browser_extract",
      description: "Extracts raw text content from the page or a specific element.",
      input_schema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Optional element reference. Omit for full page text." }
        }
      }
    },
    {
      name: "browser_screenshot",
      description: "Captures a screenshot of the current page and attaches it for visual inspection.",
      input_schema: {
        type: "object",
        properties: {}
      }
    },
    {
      name: "browser_close",
      description: "Ends the current browser session. Use this only when you are fully done browsing for this task.",
      input_schema: {
        type: "object",
        properties: {}
      }
    }
  ];

export async function executeBrowserTool(
  browserManager: BrowserManager,
  sessionKey: string,
  toolName: string,
  params: BrowserToolParams,
  stepTimeoutMs?: number,
  signal?: AbortSignal
): Promise<BrowserToolResult> {
  try {
    switch (toolName) {
      case "browser_open":
        return buildBrowserTextResult(
          await browserManager.open(sessionKey, (params as BrowserOpenParams).url, stepTimeoutMs, signal)
        );
      case "browser_snapshot":
        return buildBrowserTextResult(
          await browserManager.snapshot(
            sessionKey,
            (params as BrowserSnapshotParams).interactive_only !== false,
            stepTimeoutMs,
            signal
          )
        );
      case "browser_click":
        return buildBrowserTextResult(
          await browserManager.click(sessionKey, (params as BrowserClickParams).ref, stepTimeoutMs, signal)
        );
      case "browser_type": {
        const p = params as BrowserTypeParams;
        return buildBrowserTextResult(
          await browserManager.type(sessionKey, p.ref, p.text, p.pressEnter !== false, stepTimeoutMs, signal)
        );
      }
      case "browser_scroll": {
        const p = params as BrowserScrollParams;
        return buildBrowserTextResult(
          await browserManager.scroll(sessionKey, p.direction, p.pixels, stepTimeoutMs, signal)
        );
      }
      case "browser_extract":
        return buildBrowserTextResult(
          await browserManager.extract(sessionKey, (params as BrowserExtractParams).ref, stepTimeoutMs, signal)
        );
      case "browser_screenshot": {
        const screenshot = await browserManager.screenshot(sessionKey, stepTimeoutMs, signal);
        if (String(screenshot || "").toLowerCase().startsWith("error:")) {
          return buildBrowserTextResult(String(screenshot || ""));
        }
        const imageInput = parseBrowserScreenshotDataUrl(String(screenshot || ""));
        if (!imageInput) {
          return {
            text: "Error executing browser_screenshot: invalid screenshot payload",
            isError: true
          };
        }
        return {
          text: "Browser screenshot captured and attached for visual inspection.",
          imageInputs: [imageInput]
        };
      }
      case "browser_close":
        await browserManager.close(sessionKey);
        return { text: "Browser closed successfully." };
      default:
        throw new Error(`Unknown browser tool: ${toolName}`);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      text: `Error executing ${toolName}: ${message}`,
      isError: true
    };
  }
}
