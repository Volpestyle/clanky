import { test } from "bun:test";
import assert from "node:assert/strict";
import { buildVoiceTurnPrompt } from "./index.ts";

test("buildVoiceTurnPrompt includes multi-participant join-window greeting bias guidance", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    transcript: "hi",
    joinWindowActive: true,
    participantRoster: [{ displayName: "alice" }, { displayName: "bob" }]
  });

  assert.equal(
    prompt.includes(
      "Join-window bias: if this turn is a short greeting/check-in (for example hi/hey/yo/sup/what's up), default to a brief acknowledgement instead of [SKIP] even in multi-participant channels, unless clearly aimed at another human."
    ),
    true
  );
});

test("buildVoiceTurnPrompt omits join-window greeting bias guidance when join-window is inactive", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    transcript: "hi",
    joinWindowActive: false
  });

  assert.equal(prompt.includes("Join-window bias:"), false);
});

test("buildVoiceTurnPrompt biases low-information eager turns toward skip", () => {
  const prompt = buildVoiceTurnPrompt({
    speakerName: "alice",
    transcript: "haha",
    isEagerTurn: true,
    voiceEagerness: 50
  });

  assert.equal(
    prompt.includes(
      "If the turn is only laughter, filler, or backchannel noise (for example haha, lol, hmm, mm, uh-huh, yup), strongly prefer [SKIP] unless there is a clear question, request, or obvious conversational value in replying."
    ),
    true
  );
});
