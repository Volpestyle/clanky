import { test } from "bun:test";
import assert from "node:assert/strict";
import { parseStructuredInitiativeOutput, resolveMaxMediaPromptLen } from "./botHelpers.ts";
import { normalizeSettings } from "../store/settingsNormalization.ts";

test("resolveMaxMediaPromptLen reads canonical discovery settings", () => {
  const settings = normalizeSettings({
    identity: {
      botName: "clanky"
    },
    initiative: {
      discovery: {
        maxMediaPromptChars: 1375
      }
    }
  });

  assert.equal(resolveMaxMediaPromptLen(settings), 1375);
});

test("parseStructuredInitiativeOutput treats malformed non-drop actions as contract violations", () => {
  const parsed = parseStructuredInitiativeOutput(JSON.stringify({
    action: "hold",
    reason: "later"
  }));

  assert.equal(parsed.action, "hold");
  assert.equal(parsed.skip, false);
  assert.equal(parsed.contractViolation, true);
  assert.equal(parsed.contractViolationReason, "missing_channel_id_and_text");
});
