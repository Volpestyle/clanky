import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  getReplyAddressSignal,
  resolveColdAmbientReplyProbability,
  resolveTextAttentionState,
  shouldAttemptReplyDecision
} from "./replyAdmission.ts";
import { createTestSettings } from "../testSettings.ts";

const BASE_SETTINGS = createTestSettings({
  identity: {
    botName: "clanky",
    botNameAliases: ["clank"]
  }
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

test("reply admission treats direct replies to a recent bot message as ACTIVE", () => {
  const settings = {
    permissions: {
      allowUnsolicitedReplies: true
    },
    interaction: {
      activity: {
        ambientReplyEagerness: 10,
        responseWindowEagerness: 60
      }
    }
  };

  const attention = resolveTextAttentionState({
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
    triggerMessageId: "msg-1",
    triggerAuthorId: "user-1",
    triggerReferenceMessageId: "bot-ctx-1"
  });
  assert.equal(attention.mode, "ACTIVE");
  assert.equal(attention.reason, "reply_to_bot");
  assert.equal(attention.recentReplyWindowActive, true);

  assert.equal(
    shouldAttemptReplyDecision({
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
      triggerMessageId: "msg-1",
      triggerAuthorId: "user-1",
      triggerReferenceMessageId: "bot-ctx-1"
    }),
    true
  );
});

test("reply admission treats same-author followups after a bot reply as ACTIVE", () => {
  const settings = {
    permissions: {
      allowUnsolicitedReplies: true
    },
    interaction: {
      activity: {
        ambientReplyEagerness: 10,
        responseWindowEagerness: 60
      }
    }
  };

  const attention = resolveTextAttentionState({
    botUserId: "bot-1",
    settings,
    recentMessages: [
      {
        message_id: "bot-ctx-1",
        author_id: "bot-1",
        referenced_message_id: "human-ctx-1"
      },
      {
        message_id: "human-ctx-1",
        author_id: "user-1"
      }
    ],
    addressSignal: {
      direct: false,
      inferred: false,
      triggered: false,
      reason: "llm_decides"
    },
    triggerMessageId: "msg-1",
    triggerAuthorId: "user-1"
  });
  assert.equal(attention.mode, "ACTIVE");
  assert.equal(attention.reason, "same_author_followup");
  assert.equal(attention.recentReplyWindowActive, true);
});

test("reply admission disables recent-window followups when response-window eagerness is zero", () => {
  const noAddress = {
    direct: false,
    inferred: false,
    triggered: false,
    reason: "llm_decides"
  };

  assert.equal(
    shouldAttemptReplyDecision({
      botUserId: "bot-1",
      settings: {
        permissions: {
          allowUnsolicitedReplies: true
        },
        interaction: {
          activity: {
            ambientReplyEagerness: 10,
            responseWindowEagerness: 0
          }
        }
      },
      recentMessages: [
        {
          message_id: "bot-ctx-1",
          author_id: "bot-1",
          referenced_message_id: "human-ctx-1"
        },
        {
          message_id: "human-ctx-1",
          author_id: "user-1"
        }
      ],
      addressSignal: noAddress,
      triggerMessageId: "msg-1",
      triggerAuthorId: "user-1"
    }),
    false
  );
});

test("reply admission blocks zero-eagerness cold ambient turns and admits max-eagerness ones", () => {
  const highEagernessSettings = {
    permissions: { allowUnsolicitedReplies: true },
    interaction: { activity: { ambientReplyEagerness: 100 } }
  };
  const lowEagernessSettings = {
    permissions: { allowUnsolicitedReplies: true },
    interaction: { activity: { ambientReplyEagerness: 0 } }
  };
  const noAddress = {
    direct: false,
    inferred: false,
    triggered: false,
    reason: "llm_decides"
  };

  assert.equal(
    shouldAttemptReplyDecision({
      botUserId: "bot-1",
      settings: highEagernessSettings,
      recentMessages: [],
      addressSignal: noAddress,
      triggerMessageId: "msg-1"
    }),
    true
  );

  assert.equal(
    shouldAttemptReplyDecision({
      botUserId: "bot-1",
      settings: lowEagernessSettings,
      recentMessages: [],
      addressSignal: noAddress,
      triggerMessageId: "msg-1"
    }),
    false
  );
});

test("reply admission falls back to AMBIENT when another human has already moved the room on", () => {
  const noAddress = {
    direct: false,
    inferred: false,
    triggered: false,
    reason: "llm_decides"
  };
  const settings = {
    permissions: { allowUnsolicitedReplies: true },
    interaction: {
      activity: {
        ambientReplyEagerness: 10,
        responseWindowEagerness: 80
      }
    }
  };

  const attention = resolveTextAttentionState({
    botUserId: "bot-1",
    settings,
    recentMessages: [
      { message_id: "newer-human", author_id: "user-2" },
      { message_id: "bot-ctx", author_id: "bot-1", referenced_message_id: "older-user-1" },
      { message_id: "older-user-1", author_id: "user-1" }
    ],
    addressSignal: noAddress,
    triggerMessageId: "msg-1",
    triggerAuthorId: "user-1"
  });

  assert.equal(attention.mode, "AMBIENT");
  assert.equal(attention.reason, "cold_ambient");
  assert.equal(attention.recentReplyWindowActive, false);
});

test("reply admission applies a reply-channel bonus to cold ambient probability", () => {
  assert.equal(resolveColdAmbientReplyProbability({
    ambientReplyEagerness: 30,
    isReplyChannel: false
  }) < resolveColdAmbientReplyProbability({
    ambientReplyEagerness: 30,
    isReplyChannel: true
  }), true);
});
