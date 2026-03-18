import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SubAgentSessionManager } from "../agents/subAgentSession.ts";
import { appConfig } from "../config.ts";
import { LLMService } from "../llm.ts";
import { MemoryManager } from "../memory/memoryManager.ts";
import { BrowserManager } from "../services/BrowserManager.ts";
import { Store } from "../store/store.ts";
import { createTestSettings } from "../testSettings.ts";
import { BrowserTaskRegistry } from "../tools/browserTaskRuntime.ts";
import type { AgentContext } from "./botContext.ts";
import {
  buildSubAgentSessionsRuntime,
  createCodeAgentSession,
  runModelRequestedBrowserBrowse,
  runModelRequestedCodeTask
} from "./agentTasks.ts";

async function withTempAgentContext(
  optionsOrRun:
    | {
        browserManager?: BrowserManager | null;
      }
    | ((ctx: AgentContext & { browserManager: BrowserManager | null }) => Promise<void>),
  maybeRun?: (ctx: AgentContext & { browserManager: BrowserManager | null }) => Promise<void>
) {
  const options = typeof optionsOrRun === "function" ? {} : optionsOrRun;
  const run = typeof optionsOrRun === "function" ? optionsOrRun : maybeRun;
  const browserManager = options.browserManager || null;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clanker-bot-agent-tasks-test-"));
  const dbPath = path.join(dir, "clanker.db");
  const store = new Store(dbPath);
  store.init();

  const llm = new LLMService({ appConfig, store });
  const memory = new MemoryManager({
    store,
    llm,
    memoryFilePath: path.join(dir, "memory.md")
  });
  const ctx: AgentContext & { browserManager: BrowserManager | null } = {
    appConfig,
    store,
    llm,
    memory,
    client: {
      user: {
        id: "bot-1"
      },
      guilds: {
        cache: new Map()
      }
    },
    botUserId: "bot-1",
    browserManager,
    activeBrowserTasks: new BrowserTaskRegistry(),
    subAgentSessions: new SubAgentSessionManager()
  };

  try {
    if (typeof run !== "function") {
      throw new Error("missing_agent_test_runner");
    }
    await run(ctx);
  } finally {
    ctx.subAgentSessions.closeAll();
    await browserManager?.closeAll();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("runModelRequestedBrowserBrowse reports openai computer use unavailable without OpenAI client", async () => {
  await withTempAgentContext(
    {
      browserManager: new BrowserManager()
    },
    async (ctx) => {
      // Null out the OpenAI client so the guard fires
      // eslint-disable-next-line no-restricted-syntax
      (ctx.llm as any).openai = null;
      // eslint-disable-next-line no-restricted-syntax
      (ctx.llm as any).codexOAuth = null;

      const settings = createTestSettings({
        agentStack: {
          runtimeConfig: {
            browser: {
              enabled: true
            }
          }
        }
      });
      const patchedSettings = {
        ...settings,
        agentStack: {
          ...settings.agentStack,
          overrides: {
            ...settings.agentStack.overrides,
            browserRuntime: "openai_computer_use"
          }
        }
      };

      const result = await runModelRequestedBrowserBrowse(ctx, {
        settings: patchedSettings,
        browserBrowse: {
          enabled: true,
          configured: true,
          budget: {
            maxPerHour: 5,
            used: 0,
            remaining: 5,
            canBrowse: true
          }
        },
        query: "  investigate this page  ",
        guildId: "guild-1",
        channelId: "chan-1",
        userId: "user-1"
      });

      assert.equal(result.query, "investigate this page");
      assert.equal(result.error, "openai_computer_use_unavailable");
      assert.equal(result.used, false);
    }
  );
});

test("runModelRequestedBrowserBrowse uses OpenAI OAuth for hosted computer use when selected", async () => {
  const browserManager = {
    configureSession() {
      return undefined;
    },
    async open() {
      return "ok";
    },
    async screenshot() {
      return "data:image/png;base64,c2NyZWVu";
    },
    async currentUrl() {
      return "https://example.com/current";
    },
    async close() {
      return undefined;
    },
    async closeAll() {
      return undefined;
    }
  } as BrowserManager;

  await withTempAgentContext(
    {
      browserManager
    },
    async (ctx) => {
      // eslint-disable-next-line no-restricted-syntax
      (ctx.llm as any).openai = null;
      // eslint-disable-next-line no-restricted-syntax
      (ctx.llm as any).codexOAuth = {
        tokens: { refreshToken: "test", accessToken: "", idToken: "", expiresAt: 0, accountId: "acct_123" },
        client: {
          async post() {
            return {
              id: "resp_1",
              output: [],
              output_text: "Done via oauth.",
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                input_tokens_details: { cached_tokens: 0 }
              }
            };
          }
        }
      };

      const settings = createTestSettings({
        agentStack: {
          runtimeConfig: {
            browser: {
              enabled: true,
              openaiComputerUse: {
                client: "openai-oauth",
                model: "gpt-5.4"
              }
            }
          },
          overrides: {
            browserRuntime: "openai_computer_use"
          }
        }
      });

      const result = await runModelRequestedBrowserBrowse(ctx, {
        settings,
        browserBrowse: {
          enabled: true,
          configured: true,
          budget: {
            maxPerHour: 5,
            used: 0,
            remaining: 5,
            canBrowse: true
          }
        },
        query: "inspect https://example.com",
        guildId: "guild-1",
        channelId: "chan-1",
        userId: "user-1"
      });

      assert.equal(result.used, true);
      assert.equal(result.error, null);
      assert.equal(result.text, "Done via oauth.");
    }
  );
});

test("runModelRequestedCodeTask blocks users outside the dev-task allowlist", async () => {
  await withTempAgentContext(async (ctx) => {
    const settings = createTestSettings({
      permissions: {
        devTasks: {
          allowedUserIds: ["allowed-1"]
        }
      },
      agentStack: {
        runtimeConfig: {
          devTeam: {
            codexCli: {
              enabled: true
            }
          }
        }
      }
    });

    const result = await runModelRequestedCodeTask(ctx, {
      settings,
      task: "inspect repo status",
      guildId: "guild-1",
      channelId: "chan-1",
      userId: "blocked-1"
    });

    assert.equal(result.blockedByPermission, true);
    assert.equal(result.text, "");
  });
});

test("createCodeAgentSession returns a code session when dev tasks are enabled", async () => {
  await withTempAgentContext(async (ctx) => {
    const settings = createTestSettings({
      permissions: {
        devTasks: {
          allowedUserIds: ["user-1"]
        }
      },
      agentStack: {
        runtimeConfig: {
          devTeam: {
            codexCli: {
              enabled: true,
              maxParallelTasks: 2,
              maxTasksPerHour: 5
            }
          }
        }
      }
    });

    const session = createCodeAgentSession(ctx, {
      settings,
      guildId: "guild-1",
      channelId: "chan-1",
      userId: "user-1"
    });

    assert.ok(session);
    assert.equal(session?.type, "code");
    session?.close();
  });
});

test("buildSubAgentSessionsRuntime delegates browser session creation for local browser runtime", async () => {
  await withTempAgentContext(
    {
      browserManager: new BrowserManager()
    },
    async (ctx) => {
      const settings = createTestSettings({
        agentStack: {
          runtimeConfig: {
            browser: {
              enabled: true
            }
          }
        }
      });

      const runtime = buildSubAgentSessionsRuntime(ctx);
      const session = runtime.createBrowserSession({
        settings,
        guildId: "guild-1",
        channelId: "chan-1",
        userId: "user-1"
      });

      assert.equal(runtime.manager, ctx.subAgentSessions);
      assert.ok(session);
      assert.equal(session?.type, "browser");
      session?.close();
    }
  );
});

test("buildSubAgentSessionsRuntime blocks browser sessions for openai computer use runtime", async () => {
  await withTempAgentContext(
    {
      browserManager: new BrowserManager()
    },
    async (ctx) => {
      const settings = createTestSettings({
        agentStack: {
          runtimeConfig: {
            browser: {
              enabled: true
            }
          }
        }
      });
      const patchedSettings = {
        ...settings,
        agentStack: {
          ...settings.agentStack,
          overrides: {
            ...settings.agentStack.overrides,
            browserRuntime: "openai_computer_use"
          }
        }
      };

      const runtime = buildSubAgentSessionsRuntime(ctx);
      const session = runtime.createBrowserSession({
        settings: patchedSettings,
        guildId: "guild-1",
        channelId: "chan-1",
        userId: "user-1"
      });

      assert.equal(session, null);
    }
  );
});
