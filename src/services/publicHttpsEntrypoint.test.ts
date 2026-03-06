import { test } from "bun:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import {
  PublicHttpsEntrypoint,
  extractCloudflaredPublicUrl,
  resolvePublicHttpsTargetUrl
} from "./publicHttpsEntrypoint.ts";

test("extractCloudflaredPublicUrl returns trycloudflare URL from line", () => {
  const line =
    "INF +--------------------------------------------------------------------------------------------+ https://fancy-cat-bot.trycloudflare.com";
  const extracted = extractCloudflaredPublicUrl(line);
  assert.equal(extracted, "https://fancy-cat-bot.trycloudflare.com");
});

test("extractCloudflaredPublicUrl returns empty string when line has no URL", () => {
  const extracted = extractCloudflaredPublicUrl("cloudflared connected to edge");
  assert.equal(extracted, "");
});

test("resolvePublicHttpsTargetUrl falls back to localhost dashboard", () => {
  assert.equal(resolvePublicHttpsTargetUrl("", 8787), "http://127.0.0.1:8787");
});

test("resolvePublicHttpsTargetUrl normalizes valid input URL", () => {
  assert.equal(
    resolvePublicHttpsTargetUrl("https://localhost:8787/path/?x=1#abc", 9999),
    "https://localhost:8787/path"
  );
});

test("resolvePublicHttpsTargetUrl rejects non-http protocols", () => {
  assert.equal(resolvePublicHttpsTargetUrl("file:///tmp/dashboard", 8787), "http://127.0.0.1:8787");
});

function createEntrypoint(appConfig = {}) {
  const actions = [];
  const entrypoint = new PublicHttpsEntrypoint({
    appConfig,
    store: {
      logAction(action) {
        actions.push(action);
      }
    }
  });
  return { entrypoint, actions };
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("wait_for_timeout");
    }
    await sleep(10);
  }
}

test("PublicHttpsEntrypoint start handles disabled and enabled states", async () => {
  const disabled = createEntrypoint({
    publicHttpsEnabled: false
  });
  const disabledState = await disabled.entrypoint.start();
  assert.equal(disabledState.status, "disabled");

  const enabled = createEntrypoint({
    publicHttpsEnabled: true,
    publicHttpsCloudflaredBin: "cloudflared"
  });
  let calls = 0;
  enabled.entrypoint.startCloudflared = () => {
    enabled.entrypoint.state.status = "starting";
    calls += 1;
  };
  const enabledState = await enabled.entrypoint.start();
  assert.equal(enabledState.status, "starting");
  assert.equal(calls, 1);
});

test("PublicHttpsEntrypoint start returns early when child exists and otherwise delegates to startCloudflared", async () => {
  const { entrypoint } = createEntrypoint({
    publicHttpsEnabled: true
  });
  entrypoint.child = { pid: 111 };

  let calls = 0;
  entrypoint.startCloudflared = () => {
    calls += 1;
  };
  await entrypoint.start();
  assert.equal(calls, 0);

  entrypoint.child = null;
  await entrypoint.start();
  assert.equal(calls, 1);
});

test("PublicHttpsEntrypoint stop resolves without child and tears down active child handles", async () => {
  const { entrypoint } = createEntrypoint({
    publicHttpsEnabled: true
  });
  const noChildState = await entrypoint.stop();
  assert.equal(noChildState.status, "stopped");

  const signals = [];
  const listeners = {};
  const fakeChild = {
    once(event, handler) {
      listeners[event] = handler;
    },
    kill(signal) {
      signals.push(signal);
      if (signal === "SIGTERM" && typeof listeners.close === "function") {
        listeners.close(0, "SIGTERM");
      }
    }
  };
  let stdoutClosed = 0;
  let stderrClosed = 0;
  entrypoint.child = fakeChild;
  entrypoint.state.pid = 4242;
  entrypoint.stdoutReader = {
    removeAllListeners() {},
    close() {
      stdoutClosed += 1;
    }
  };
  entrypoint.stderrReader = {
    removeAllListeners() {},
    close() {
      stderrClosed += 1;
    }
  };

  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => {
    fn();
    return { id: "timer" };
  };
  try {
    const stopped = await entrypoint.stop();
    assert.equal(stopped.status, "stopped");
    assert.deepEqual(signals, ["SIGTERM"]);
    assert.equal(stdoutClosed, 1);
    assert.equal(stderrClosed, 1);
    assert.equal(entrypoint.child, null);
    assert.equal(entrypoint.state.pid, null);
    assert.equal(entrypoint.state.startedAt, null);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("PublicHttpsEntrypoint handleCloudflaredLine updates ready, starting, and error states", () => {
  const { entrypoint, actions } = createEntrypoint({
    publicHttpsEnabled: true
  });
  entrypoint.handleCloudflaredLine("registered tunnel connection");
  assert.equal(entrypoint.state.status, "starting");

  entrypoint.handleCloudflaredLine(
    "INF +--------------------------------------------------------------------------------------------+ https://fancy-cat-bot.trycloudflare.com"
  );
  assert.equal(entrypoint.state.status, "ready");
  assert.equal(entrypoint.state.publicUrl, "https://fancy-cat-bot.trycloudflare.com");
  assert.equal(typeof entrypoint.state.startedAt, "string");
  assert.equal(
    actions.some((entry) => String(entry.content).includes("public_https_entrypoint_ready")),
    true
  );

  const noisy = `error ${"x".repeat(600)}`;
  entrypoint.handleCloudflaredLine(noisy, "stderr");
  assert.equal(entrypoint.state.status, "error");
  assert.equal(entrypoint.state.lastError.length <= 300, true);
  assert.equal(
    actions.some((entry) => String(entry.content).includes("public_https_entrypoint_log_stderr")),
    true
  );
});

test("PublicHttpsEntrypoint logAction sanitizes output and tolerates missing store logger", () => {
  const { entrypoint, actions } = createEntrypoint({
    publicHttpsEnabled: true
  });
  entrypoint.logAction({
    kind: "bot_runtime",
    content: "x".repeat(800),
    metadata: "not-object"
  });
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.content.length, 400);
  assert.equal(actions[0]?.metadata, undefined);

  const noStore = new PublicHttpsEntrypoint({
    appConfig: {},
    store: null
  });
  noStore.logAction({
    kind: "bot_runtime",
    content: "ok"
  });
});

test("PublicHttpsEntrypoint startCloudflared captures ENOENT and blocks retries", async () => {
  const { entrypoint, actions } = createEntrypoint({
    publicHttpsEnabled: true,
    publicHttpsCloudflaredBin: "__definitely_missing_cloudflared_binary__"
  });

  entrypoint.startCloudflared();
  await waitFor(() => entrypoint.state.status === "error");

  assert.equal(entrypoint.preventAutoRetry, true);
  assert.equal(actions.some((entry) => String(entry.content).includes("spawn_failed")), true);
  assert.equal(actions.some((entry) => String(entry.content).includes("entrypoint_exited")), true);
});

test("PublicHttpsEntrypoint startCloudflared schedules retry after unexpected close", async () => {
  const { entrypoint, actions } = createEntrypoint({
    publicHttpsEnabled: true,
    publicHttpsCloudflaredBin: process.execPath
  });

  const originalSetTimeout = globalThis.setTimeout;
  const scheduled = [];
  globalThis.setTimeout = (fn, delay) => {
    scheduled.push(delay);
    return { id: "retry", fn };
  };
  try {
    entrypoint.startCloudflared();
    await waitFor(() =>
      actions.some((entry) => String(entry.content).includes("public_https_entrypoint_exited"))
    );
    assert.equal(entrypoint.preventAutoRetry, false);
    assert.equal(scheduled.includes(5_000), true);
    assert.equal(entrypoint.retryTimer !== null, true);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});
