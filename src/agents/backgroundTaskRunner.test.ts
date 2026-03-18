import { test } from "bun:test";
import assert from "node:assert/strict";
import { createAbortError } from "../tools/browserTaskRuntime.ts";
import {
  BackgroundTaskRunner,
  buildCodeTaskScopeKey
} from "./backgroundTaskRunner.ts";
import type { SubAgentSession, SubAgentTurnResult } from "./subAgentSession.ts";

const EMPTY_USAGE: SubAgentTurnResult["usage"] = {
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0
};

function createSession({
  id,
  runTurn
}: {
  id: string;
  runTurn: SubAgentSession["runTurn"];
}): SubAgentSession {
  return {
    id,
    type: "code",
    createdAt: Date.now(),
    ownerUserId: "user-1",
    lastUsedAt: Date.now(),
    status: "idle",
    runTurn,
    cancel() {
      this.status = "cancelled";
    },
    close() {
      this.status = "cancelled";
    }
  };
}

test("BackgroundTaskRunner dispatches and invokes completion callback", async () => {
  const removedSessions: string[] = [];
  const loggedKinds: string[] = [];
  const runner = new BackgroundTaskRunner({
    store: {
      logAction(entry) {
        loggedKinds.push(String(entry.kind || ""));
      }
    },
    sessionManager: {
      remove(sessionId) {
        removedSessions.push(String(sessionId || ""));
        return true;
      }
    },
    sweepIntervalMs: 5_000
  });

  let completionTaskStatus = "";
  const completionDone = new Promise<void>((resolve) => {
    const session = createSession({
      id: "code:task:complete",
      runTurn: async (_input, options = {}) => {
        options.onProgress?.({
          kind: "assistant_message",
          summary: "Working on it",
          elapsedMs: 50,
          timestamp: Date.now()
        });
        return {
          text: "Completed successfully.",
          costUsd: 0.01,
          isError: false,
          errorMessage: "",
          usage: { ...EMPTY_USAGE }
        };
      }
    });
    runner.dispatch({
      session,
      input: "Implement auth refactor",
      scopeKey: buildCodeTaskScopeKey({ guildId: "guild-1", channelId: "channel-1" }),
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "user-1",
      triggerMessageId: "msg-1",
      role: "implementation",
      onComplete: async (task) => {
        completionTaskStatus = task.status;
        resolve();
      }
    });
  });

  await completionDone;
  runner.close();

  assert.equal(completionTaskStatus, "completed");
  assert.deepEqual(removedSessions, ["code:task:complete"]);
  assert.equal(loggedKinds.includes("code_agent_call"), true);
});

test("BackgroundTaskRunner cancels running tasks by scope", async () => {
  const removedSessions: string[] = [];
  const runner = new BackgroundTaskRunner({
    store: {
      logAction() {}
    },
    sessionManager: {
      remove(sessionId) {
        removedSessions.push(String(sessionId || ""));
        return true;
      }
    },
    sweepIntervalMs: 5_000
  });

  let completionTaskStatus = "";
  const completionDone = new Promise<void>((resolve) => {
    const session = createSession({
      id: "code:task:cancel",
      runTurn: async (_input, options = {}) => {
        return await new Promise<SubAgentTurnResult>((resolveRun, rejectRun) => {
          if (options.signal?.aborted) {
            rejectRun(createAbortError(options.signal.reason || "cancelled"));
            return;
          }
          options.signal?.addEventListener("abort", () => {
            rejectRun(createAbortError(options.signal?.reason || "cancelled"));
          }, { once: true });
        });
      }
    });

    runner.dispatch({
      session,
      input: "Long running task",
      scopeKey: buildCodeTaskScopeKey({ guildId: "guild-1", channelId: "channel-1" }),
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "user-1",
      triggerMessageId: "msg-2",
      role: "implementation",
      onComplete: async (task) => {
        completionTaskStatus = task.status;
        resolve();
      }
    });
  });

  const cancelledCount = runner.cancelByScope(
    buildCodeTaskScopeKey({ guildId: "guild-1", channelId: "channel-1" }),
    "user_cancel"
  );
  assert.equal(cancelledCount, 1);

  await completionDone;
  runner.close();

  assert.equal(completionTaskStatus, "cancelled");
  assert.deepEqual(removedSessions, ["code:task:cancel"]);
});
