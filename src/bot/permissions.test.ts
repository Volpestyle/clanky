import { test } from "bun:test";
import assert from "node:assert/strict";
import { createTestSettings } from "../testSettings.ts";
import {
  isChannelAllowed,
  isReplyChannel,
  isUserBlocked
} from "./permissions.ts";

test("isChannelAllowed blocks explicit blocked channels before allow logic", () => {
  const settings = createTestSettings({
    permissions: {
      blockedChannelIds: ["blocked-1"],
      allowedChannelIds: ["blocked-1", "allowed-1"]
    }
  });

  assert.equal(isChannelAllowed(settings, "blocked-1"), false);
  assert.equal(isChannelAllowed(settings, "allowed-1"), true);
});

test("isChannelAllowed defaults open when allowlist is empty", () => {
  const settings = createTestSettings({
    permissions: {
      allowedChannelIds: [],
      blockedChannelIds: []
    }
  });

  assert.equal(isChannelAllowed(settings, "any-channel"), true);
});

test("isReplyChannel matches the unified initiative channel list", () => {
  const settings = createTestSettings({
    permissions: {
      replyChannelIds: ["reply-1"]
    }
  });

  assert.equal(isReplyChannel(settings, "reply-1"), true);
  assert.equal(isReplyChannel(settings, "other"), false);
});

test("isUserBlocked matches normalized blocked user ids", () => {
  const settings = createTestSettings({
    permissions: {
      blockedUserIds: ["user-1"]
    }
  });

  assert.equal(isUserBlocked(settings, "user-1"), true);
  assert.equal(isUserBlocked(settings, "user-2"), false);
});
