import { test } from "bun:test";
import assert from "node:assert/strict";
import { VoiceSubprocessClient } from "./voiceSubprocessClient.ts";

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

test("VoiceSubprocessClient destroy waits for child exit", async () => {
  const client = new VoiceSubprocessClient("guild-1", "channel-1", null);
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

test("VoiceSubprocessClient destroy sends gateway leave before subprocess exit", async () => {
  const sentPayloads: GatewayPayload[] = [];
  const guild = {
    shard: {
      send(payload: GatewayPayload) {
        sentPayloads.push(payload);
      }
    }
  };
  const client = new VoiceSubprocessClient("guild-1", "channel-1", guild);
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
