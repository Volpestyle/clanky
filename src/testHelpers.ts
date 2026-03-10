import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  DashboardBot,
  DashboardMemory,
  DashboardPublicHttpsState,
  DashboardScreenShareSessionManager
} from "./dashboard.ts";
import { parseBooleanFlag, parseNumberOrFallback } from "./normalization/valueParsers.ts";
import { createDashboardServer } from "./dashboard.ts";
import { Store } from "./store/store.ts";

type ErrorLike = {
  code?: unknown;
  message?: unknown;
};

type TestDashboardServerOptions = {
  dashboardToken?: string;
  appConfigOverrides?: Record<string, unknown>;
  publicHttpsState?: DashboardPublicHttpsState | null;
  botOverrides?: Partial<DashboardBot> & Record<string, unknown>;
  memoryOverrides?: Partial<DashboardMemory> & Record<string, unknown>;
  screenShareSessionManager?: DashboardScreenShareSessionManager | null;
};

type TestDashboardServerResult = {
  baseUrl: string;
  bot: DashboardBot & { appliedSettings: unknown[] };
  memory: DashboardMemory;
  store: Store;
  ingestCalls: unknown[];
  memoryCalls: unknown[];
};

export function isListenPermissionError(error: unknown): boolean {
  const errorLike = (typeof error === "object" && error !== null ? error : {}) as ErrorLike;
  const code = String(errorLike.code || "").toUpperCase();
  const message = String(errorLike.message || "");

  return (
    code === "EPERM" ||
    code === "EACCES" ||
    (code === "EADDRINUSE" && /port\s+0\s+in\s+use/i.test(message)) ||
    /listen\s+EPERM|listen\s+EACCES/i.test(message)
  );
}

export function envFlag(name: string, fallback = false): boolean {
  return parseBooleanFlag(process.env[name], fallback);
}

export function envNumber(name: string, fallback: number): number {
  return parseNumberOrFallback(process.env[name], fallback);
}

export async function withDashboardServer<T>(
  {
    dashboardToken = "",
    appConfigOverrides = {},
    publicHttpsState = null,
    botOverrides = {},
    memoryOverrides = {},
    screenShareSessionManager = null
  }: TestDashboardServerOptions = {},
  run: (context: TestDashboardServerResult) => Promise<T>
): Promise<{ skipped: boolean; reason?: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-dashboard-test-"));
  const dbPath = path.join(dir, "clanker.db");
  const store = new Store(dbPath);
  store.init();

  const ingestCalls = [];
  const memoryCalls = [];

  const appliedSettings: unknown[] = [];
  const bot: DashboardBot & { appliedSettings: unknown[] } = {
    appliedSettings,
    async applyRuntimeSettings(nextSettings) {
      appliedSettings.push(nextSettings);
      return nextSettings;
    },
    getRuntimeState() {
      return {
        connected: true,
        replyQueuePending: 0
      };
    },
    getGuilds() {
      return [];
    },
    getGuildChannels() {
      return [];
    },
    async ingestVoiceStreamFrame(payload) {
      ingestCalls.push(payload);
      return {
        accepted: true,
        reason: "ok"
      };
    },
    ...botOverrides
  };

  const memory: DashboardMemory = {
    async readMemoryMarkdown() {
      return "# memory";
    },
    async refreshMemoryMarkdown() {
      return true;
    },
    loadFactProfile() {
      return {
        participantProfiles: [],
        selfFacts: [],
        loreFacts: [],
        userFacts: [],
        relevantFacts: [],
        guidanceFacts: []
      };
    },
    loadUserFactProfile() {
      return {
        userFacts: []
      };
    },
    loadGuildFactProfile() {
      return {
        selfFacts: [],
        loreFacts: []
      };
    },
    async loadBehavioralFactsForPrompt() {
      return [];
    },
    async searchDurableFacts(payload) {
      memoryCalls.push(payload);
      return [{ fact: "remember this" }];
    },
    ...memoryOverrides
  };

  const appConfig = {
    dashboardHost: "127.0.0.1",
    dashboardPort: 0,
    dashboardToken,
    publicApiToken: "",
    ...appConfigOverrides
  };

  const publicHttpsEntrypoint = publicHttpsState
    ? {
        getState() {
          return publicHttpsState;
        }
      }
    : null;

  let dashboard = null;
  try {
    dashboard = createDashboardServer({
      appConfig,
      store,
      bot,
      memory,
      publicHttpsEntrypoint,
      screenShareSessionManager
    });

    const address = dashboard.server.address();
    const port = typeof address === "object" && address ? address.port : null;
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error("dashboard test server did not provide a valid port");
    }

    await run({
      baseUrl: `http://127.0.0.1:${port}`,
      bot,
      memory,
      store,
      ingestCalls,
      memoryCalls
    });
  } catch (error) {
    if (isListenPermissionError(error)) {
      return { skipped: true, reason: "listen_permission_denied" };
    }
    throw error;
  } finally {
    if (dashboard?.server) {
      await new Promise<void>((resolve) => {
        dashboard.server.close(() => {
          resolve();
        });
      });
    }
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }

  return { skipped: false };
}
