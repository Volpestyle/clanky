import { test } from "bun:test";
import assert from "node:assert/strict";
import { ClankvoxClient } from "./clankvoxClient.ts";

class FakeSubprocess {
  exitCode: number | null = null;
  signalCode: number | null = null;
  killed = false;
  stdin = {
    end: () => undefined,
    write: () => true,
    flush: () => undefined,
  };
  stdout = {
    getReader: () => ({
      read: () => new Promise<{ done: true; value: undefined }>((resolve) => {
        // Never resolves until cancelled — simulates an idle stream
        this._cancelStdoutReader = () => resolve({ done: true, value: undefined });
      }),
      releaseLock: () => undefined,
    }),
  };

  private _resolveExitWaiter: (() => void) | null = null;
  private _cancelStdoutReader: (() => void) | null = null;

  _injectExitWaiter(resolve: () => void) {
    this._resolveExitWaiter = resolve;
  }

  kill(signal: NodeJS.Signals): void {
    this.killed = true;
    this.signalCode = signal;
    // Simulate async exit notification
    queueMicrotask(() => {
      this._cancelStdoutReader?.();
      this._resolveExitWaiter?.();
    });
  }
}

type GatewayPayload = {
  op: number;
  d: {
    guild_id: string;
    channel_id: string | null;
    self_mute: boolean;
    self_deaf: boolean;
  };
};

test("ClankvoxClient destroy waits for child exit", async () => {
  const client = new ClankvoxClient("guild-1", "channel-1", null);
  const child = new FakeSubprocess();

  // Wire up the exit-waiter that _handleExit would normally resolve
  let resolveExitWaiter!: () => void;
  const exitWaiterPromise = new Promise<void>((resolve) => {
    resolveExitWaiter = resolve;
  });
  child._injectExitWaiter(resolveExitWaiter);

  Reflect.set(client, "child", child);
  Reflect.set(client, "_resolveExitWaiter", resolveExitWaiter);
  Reflect.set(client, "_exitWaiterPromise", exitWaiterPromise);

  const startedAt = Date.now();
  await client.destroy();
  const elapsedMs = Date.now() - startedAt;

  assert.equal(client.isAlive, false);
  assert.equal(child.signalCode, "SIGTERM");
  assert.equal(child.killed, true);
  assert.equal(elapsedMs >= 200, true);
  assert.equal(elapsedMs < 5_000, true);
});

test("ClankvoxClient destroy sends gateway leave before exit", async () => {
  const sentPayloads: GatewayPayload[] = [];
  const guild = {
    shard: {
      send(payload: GatewayPayload) {
        sentPayloads.push(payload);
      }
    }
  };
  const client = new ClankvoxClient("guild-1", "channel-1", guild);
  const child = new FakeSubprocess();

  let resolveExitWaiter!: () => void;
  const exitWaiterPromise = new Promise<void>((resolve) => {
    resolveExitWaiter = resolve;
  });
  child._injectExitWaiter(resolveExitWaiter);

  Reflect.set(client, "child", child);
  Reflect.set(client, "_resolveExitWaiter", resolveExitWaiter);
  Reflect.set(client, "_exitWaiterPromise", exitWaiterPromise);

  await client.destroy();

  assert.deepEqual(sentPayloads, [
    {
      op: 4,
      d: {
        guild_id: "guild-1",
        channel_id: null,
        self_mute: false,
        self_deaf: false
      }
    }
  ]);
});

test("ClankvoxClient buffer depth telemetry clears buffered playback state at zero depth", () => {
  const client = new ClankvoxClient("guild-1", "channel-1", null);
  const handleMessage = Reflect.get(client, "_handleMessage").bind(client);

  handleMessage({
    type: "buffer_depth",
    ttsSamples: 24_000,
    musicSamples: 0
  });

  const firstUpdatedAt = client.getTtsTelemetryUpdatedAt();
  assert.equal(client.getTtsBufferDepthSamples(), 24_000);
  assert.equal(client.getTtsPlaybackState(), "buffered");
  assert.equal(firstUpdatedAt > 0, true);

  handleMessage({
    type: "buffer_depth",
    ttsSamples: 0,
    musicSamples: 0
  });

  assert.equal(client.getTtsBufferDepthSamples(), 0);
  assert.equal(client.getTtsPlaybackState(), "idle");
  assert.equal(client.getTtsTelemetryUpdatedAt() >= firstUpdatedAt, true);
});

test("ClankvoxClient emits structured IPC errors while preserving error message listeners", () => {
  const client = new ClankvoxClient("guild-1", "channel-1", null);
  const handleMessage = Reflect.get(client, "_handleMessage").bind(client);
  const errorEvents: Array<{ message: string; code: string | undefined }> = [];
  const ipcErrors: Array<{ message: string; code: string | null }> = [];

  client.on("error", (message: string, code?: string) => {
    errorEvents.push({ message, code });
  });
  client.on("ipcError", (error: { message: string; code: string | null }) => {
    ipcErrors.push(error);
  });

  handleMessage({
    type: "error",
    code: "voice_connect_failed",
    message: "Voice connect failed: websocket closed"
  });

  assert.deepEqual(errorEvents, [
    {
      message: "Voice connect failed: websocket closed",
      code: "voice_connect_failed"
    }
  ]);
  assert.deepEqual(ipcErrors, [
    {
      message: "Voice connect failed: websocket closed",
      code: "voice_connect_failed"
    }
  ]);
});
