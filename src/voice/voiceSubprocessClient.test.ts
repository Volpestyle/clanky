import { test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { VoiceSubprocessClient } from "./voiceSubprocessClient.ts";

class FakeChildProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  stdin = {
    end: () => undefined,
    write: () => true
  };

  kill(signal: NodeJS.Signals): boolean {
    this.killed = true;
    this.signalCode = signal;
    queueMicrotask(() => {
      this.emit("exit", null, signal);
    });
    return true;
  }
}

test("VoiceSubprocessClient destroy waits for child exit", async () => {
  const client = new VoiceSubprocessClient("guild-1", "channel-1", null);
  const child = new FakeChildProcess();

  Reflect.set(client, "child", child);

  const startedAt = Date.now();
  await client.destroy();
  const elapsedMs = Date.now() - startedAt;

  assert.equal(client.isAlive, false);
  assert.equal(child.signalCode, "SIGTERM");
  assert.equal(child.killed, true);
  assert.equal(elapsedMs >= 200, true);
  assert.equal(elapsedMs < 5_000, true);
});
