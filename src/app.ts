// Bun's timer loop drifts so nextTime - Date.now() can go negative inside
// @discordjs/voice's audio cycle, which breaks audio playback entirely.
// Clamp all setTimeout delays to >= 0 before any voice code is imported.
// See https://github.com/oven-sh/bun/issues/11313
if (!(globalThis as Record<string, unknown>).__bunTimeoutClamp) {
  const origSetTimeout = globalThis.setTimeout.bind(globalThis);
  globalThis.setTimeout = ((handler: TimerHandler, timeout = 0, ...args: unknown[]) =>
    origSetTimeout(handler, Math.max(0, timeout), ...args)
  ) as typeof setTimeout;
  (globalThis as Record<string, unknown>).__bunTimeoutClamp = true;
}

import path from "node:path";
import { fileURLToPath } from "node:url";
import { appConfig, ensureRuntimeEnv } from "./config.ts";
import { createDashboardServer } from "./dashboard.ts";
import { ClankerBot } from "./bot.ts";
import { DiscoveryService } from "./discovery.ts";
import { GifService } from "./gif.ts";
import { LLMService } from "./llm.ts";
import { MemoryManager } from "./memory.ts";
import { WebSearchService } from "./search.ts";
import { Store } from "./store.ts";
import { VideoContextService } from "./video.ts";
import { BrowserManager } from "./services/BrowserManager.ts";
import { PublicHttpsEntrypoint } from "./publicHttpsEntrypoint.ts";
import { ScreenShareSessionManager } from "./screenShareSessionManager.ts";
import { RuntimeActionLogger } from "./runtimeActionLogger.ts";

export async function main() {
  ensureRuntimeEnv();

  const dbPath = path.resolve(process.cwd(), "data", "clanker.db");
  const memoryFilePath = path.resolve(process.cwd(), "memory", "MEMORY.md");

  const store = new Store(dbPath);
  store.init();
  const runtimeActionLogger = new RuntimeActionLogger({
    enabled: appConfig.runtimeStructuredLogsEnabled,
    writeToStdout: appConfig.runtimeStructuredLogsStdout,
    logFilePath: appConfig.runtimeStructuredLogsFilePath
  });
  runtimeActionLogger.attachToStore(store);

  const llm = new LLMService({ appConfig, store });
  const discovery = new DiscoveryService({ store });
  const gifs = new GifService({ appConfig, store });
  const search = new WebSearchService({ appConfig, store });
  const video = new VideoContextService({ store, llm });
  const memory = new MemoryManager({ store, llm, memoryFilePath });
  await memory.refreshMemoryMarkdown();
  const browserManager = new BrowserManager({ maxConcurrentSessions: 2, sessionTimeoutMs: 300_000 });

  const bot = new ClankerBot({ appConfig, store, llm, memory, discovery, search, gifs, video, browserManager });
  const publicHttpsEntrypoint = new PublicHttpsEntrypoint({ appConfig, store });
  const screenShareSessionManager = new ScreenShareSessionManager({
    appConfig,
    store,
    bot,
    publicHttpsEntrypoint
  });
  bot.attachScreenShareSessionManager(screenShareSessionManager);
  const dashboard = createDashboardServer({
    appConfig,
    store,
    bot,
    memory,
    publicHttpsEntrypoint,
    screenShareSessionManager
  });

  await bot.start();
  await publicHttpsEntrypoint.start();

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) {
      console.warn(`Received ${signal} during shutdown. Forcing immediate exit.`);
      process.exit(1);
      return;
    }
    closing = true;

    const forceTimer = setTimeout(() => {
      console.error("Shutdown timed out after 10s. Forcing exit.");
      process.exit(1);
    }, 10_000);
    forceTimer.unref();

    console.log(`Shutting down (${signal})...`);

    try {
      await bot.stop();
    } catch {
      // ignore
    }

    try {
      await publicHttpsEntrypoint.stop();
    } catch {
      // ignore
    }

    await closeHttpServerWithTimeout(dashboard.server, 4_000);
    if (typeof llm.close === "function") {
      llm.close();
    }
    runtimeActionLogger.close();
    store.close();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

export function isDirectExecution(argv = process.argv) {
  const entry = String(argv?.[1] || "").trim();
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

export async function runCli() {
  try {
    await main();
  } catch (error) {
    console.error("Fatal startup error:", error);
    process.exit(1);
  }
}

if (isDirectExecution()) {
  void runCli();
}

async function closeHttpServerWithTimeout(server, timeoutMs = 4_000) {
  if (!server || typeof server.close !== "function") return;

  await new Promise((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(undefined);
    };

    const timer = setTimeout(() => {
      try {
        if (typeof server.closeIdleConnections === "function") {
          server.closeIdleConnections();
        }
      } catch {
        // ignore
      }
      try {
        if (typeof server.closeAllConnections === "function") {
          server.closeAllConnections();
        }
      } catch {
        // ignore
      }
      finish();
    }, Math.max(100, Number(timeoutMs) || 4_000));

    try {
      server.close(() => {
        finish();
      });
    } catch {
      finish();
    }
  });
}
