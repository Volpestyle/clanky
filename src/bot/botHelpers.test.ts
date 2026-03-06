import { test } from "bun:test";
import assert from "node:assert/strict";
import { resolveMaxMediaPromptLen } from "./botHelpers.ts";
import { normalizeSettings } from "../store/settingsNormalization.ts";

test("resolveMaxMediaPromptLen reads canonical discovery settings", () => {
  const settings = normalizeSettings({
    identity: {
      botName: "clanker conk"
    },
    initiative: {
      discovery: {
        maxMediaPromptChars: 1375
      }
    }
  });

  assert.equal(resolveMaxMediaPromptLen(settings), 1375);
});
