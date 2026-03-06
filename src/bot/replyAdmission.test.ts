import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  getReplyAddressSignal,
  shouldAttemptReplyDecision,
  shouldForceRespondForAddressSignal
} from "./replyAdmission.ts";
import { createTestSettings } from "../testSettings.ts";

const BASE_SETTINGS = createTestSettings({
  botName: "clanker conk",
  botNameAliases: ["clank"]
});

const BASE_RUNTIME = {
  botUserId: "bot-1",
  isDirectlyAddressed() {
    return false;
  }
};

function buildMessage(content = "") {
  return {
    content,
    reference: null,
    referencedMessage: null
  };
}

test("reply admission treats exact bot-name token commands as direct address", async () => {
  const signal = await getReplyAddressSignal(
    BASE_RUNTIME,
    BASE_SETTINGS,
    buildMessage("Clanker go tell the silly boys in vc to go to bed"),
    []
  );

  assert.equal(signal.direct, true);
  assert.equal(signal.triggered, true);
  assert.equal(signal.reason, "name_exact");
});

test("reply admission treats merged bot-name token commands as direct address", async () => {
  const signal = await getReplyAddressSignal(
    BASE_RUNTIME,
    BASE_SETTINGS,
    buildMessage("clankerconk can you answer this?"),
    []
  );

  assert.equal(signal.direct, true);
  assert.equal(signal.triggered, true);
  assert.equal(signal.reason, "name_exact");
});

test("reply admission treats configured alias commands as direct address", async () => {
  const signal = await getReplyAddressSignal(
    BASE_RUNTIME,
    BASE_SETTINGS,
    buildMessage("clank join vc"),
    []
  );

  assert.equal(signal.direct, true);
  assert.equal(signal.triggered, true);
  assert.equal(signal.reason, "name_alias");
});

test("reply admission ignores ambiguous soundalike tokens in generic prose", async () => {
  const signal = await getReplyAddressSignal(
    BASE_RUNTIME,
    BASE_SETTINGS,
    buildMessage("the cable made a clink sound"),
    []
  );

  assert.equal(signal.direct, false);
  assert.equal(signal.triggered, false);
  assert.equal(signal.reason, "llm_decides");
});

test("reply admission forceDecisionLoop bypasses unsolicited gating", () => {
  const shouldRun = shouldAttemptReplyDecision({
    botUserId: "bot-1",
    settings: {
      permissions: {
        allowUnsolicitedReplies: false
      }
    },
    recentMessages: [],
    addressSignal: {
      direct: false,
      inferred: false,
      triggered: false,
      reason: "llm_decides"
    },
    forceDecisionLoop: true,
    triggerMessageId: "msg-1"
  });

  assert.equal(shouldRun, true);
});

test("reply admission unsolicited turns require followup window when not directly addressed", () => {
  const settings = {
    permissions: {
      allowUnsolicitedReplies: true
    }
  };

  const withoutWindow = shouldAttemptReplyDecision({
    botUserId: "bot-1",
    settings,
    recentMessages: [],
    addressSignal: {
      direct: true,
      inferred: true,
      triggered: true,
      reason: "llm_direct_address"
    },
    triggerMessageId: "msg-1"
  });
  assert.equal(withoutWindow, false);

  const withWindow = shouldAttemptReplyDecision({
    botUserId: "bot-1",
    settings,
    recentMessages: [
      {
        message_id: "bot-ctx-1",
        author_id: "bot-1"
      }
    ],
    addressSignal: {
      direct: false,
      inferred: false,
      triggered: false,
      reason: "llm_decides"
    },
    triggerMessageId: "msg-1"
  });
  assert.equal(withWindow, true);
});

test("reply admission only force-responds for non-fuzzy address signals", () => {
  assert.equal(
    shouldForceRespondForAddressSignal({
      direct: true,
      inferred: true,
      triggered: true,
      reason: "name_variant"
    }),
    false
  );
  assert.equal(
    shouldForceRespondForAddressSignal({
      direct: true,
      inferred: false,
      triggered: true,
      reason: "name_exact"
    }),
    true
  );
});
