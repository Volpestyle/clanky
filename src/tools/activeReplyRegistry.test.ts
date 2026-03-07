import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  ActiveReplyRegistry,
  buildTextReplyScopeKey,
  buildVoiceReplyScopeKey
} from "./activeReplyRegistry.ts";
import { isCancelIntent } from "./cancelDetection.ts";

test("ActiveReplyRegistry aborts all replies for a scope and marks older work stale", () => {
  const registry = new ActiveReplyRegistry();
  const scopeKey = buildTextReplyScopeKey({
    guildId: "guild-1",
    channelId: "channel-1"
  });
  const firstReply = registry.begin(scopeKey, "text-reply");
  const secondReply = registry.begin(scopeKey, "voice-tool", ["web_search"]);

  const cancelledCount = registry.abortAll(scopeKey, "User requested cancellation");
  assert.equal(cancelledCount, 2);
  assert.equal(firstReply.abortController.signal.aborted, true);
  assert.equal(secondReply.abortController.signal.aborted, true);
  assert.equal(registry.has(scopeKey), false);
  assert.equal(registry.isStale(scopeKey, firstReply.startedAt), true);

  const freshReply = registry.begin(scopeKey, "text-reply");
  assert.equal(registry.isStale(scopeKey, freshReply.startedAt), false);
  registry.clear(freshReply);
  assert.equal(registry.has(scopeKey), false);
});

test("ActiveReplyRegistry isolates voice scopes from text scopes", () => {
  const registry = new ActiveReplyRegistry();
  const textScopeKey = buildTextReplyScopeKey({
    guildId: "guild-1",
    channelId: "channel-1"
  });
  const voiceScopeKey = buildVoiceReplyScopeKey("voice-session-1");

  registry.begin(textScopeKey, "text-reply");
  registry.begin(voiceScopeKey, "voice-tool", ["code_task"]);

  assert.equal(registry.abortAll(voiceScopeKey, "cancel voice"), 1);
  assert.equal(registry.has(textScopeKey), true);
  assert.equal(registry.has(voiceScopeKey), false);
});

test("isCancelIntent matches the shared deterministic cancellation phrases", () => {
  assert.equal(isCancelIntent("stop"), true);
  assert.equal(isCancelIntent(" never mind "), true);
  assert.equal(isCancelIntent("actually nevermind"), true);
  assert.equal(isCancelIntent("ok stop"), true);
  assert.equal(isCancelIntent("just cancel it"), true);
  assert.equal(isCancelIntent("please stop"), true);
  assert.equal(isCancelIntent("yeah forget it"), true);
  assert.equal(isCancelIntent("stop that"), true);
  assert.equal(isCancelIntent("cancel please"), true);
  assert.equal(isCancelIntent("nvm"), true);
  assert.equal(isCancelIntent("quit"), true);
  assert.equal(isCancelIntent("stop that please"), false);
  assert.equal(isCancelIntent("don't stop the music"), false);
  assert.equal(isCancelIntent("stop worrying about it"), false);
  assert.equal(isCancelIntent("can you cancel my subscription"), false);
  assert.equal(isCancelIntent("continue"), false);
});
