import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  annotateLatestVoiceTurnAddressing,
  buildVoiceAddressingState,
  findLatestVoiceTurnIndex,
  mergeVoiceAddressingAnnotation,
  normalizeVoiceAddressingAnnotation
} from "./voiceAddressing.ts";

describe("normalizeVoiceAddressingAnnotation", () => {
  test("normalizes canonical targets, clamps confidence, and cleans metadata", () => {
    const result = normalizeVoiceAddressingAnnotation({
      rawAddressing: {
        talkingTo: " everyone ",
        directedConfidence: 1.8
      },
      source: "Model Output",
      reason: "  asked   the whole   room "
    });

    assert.deepEqual(result, {
      talkingTo: "ALL",
      directedConfidence: 1,
      source: "model_output",
      reason: "asked the whole room"
    });
  });

  test("infers ME and floors confidence when the turn was directly addressed", () => {
    const result = normalizeVoiceAddressingAnnotation({
      rawAddressing: {},
      directAddressed: true,
      directedConfidence: 0.1
    });

    assert.deepEqual(result, {
      talkingTo: "ME",
      directedConfidence: 0.72,
      source: null,
      reason: null
    });
  });

  test("returns null when neither a target nor confidence is present", () => {
    const result = normalizeVoiceAddressingAnnotation({
      rawAddressing: {
        talkingTo: "   "
      }
    });

    assert.equal(result, null);
  });
});

describe("mergeVoiceAddressingAnnotation", () => {
  test("returns the incoming annotation when there is no current state", () => {
    const incoming = {
      talkingTo: "ME",
      directedConfidence: 0.8,
      source: "generation",
      reason: "clear vocative"
    };

    assert.deepEqual(mergeVoiceAddressingAnnotation(null, incoming), incoming);
  });

  test("keeps the current annotation when the incoming signal is only marginally stronger", () => {
    const current = {
      talkingTo: "ALL",
      directedConfidence: 0.6,
      source: "classifier",
      reason: "broad address"
    };
    const incoming = {
      talkingTo: "ME",
      directedConfidence: 0.61,
      source: "heuristic",
      reason: "weak cue"
    };

    assert.deepEqual(mergeVoiceAddressingAnnotation(current, incoming), current);
  });

  test("lets generation replace the current target within the confidence slack window", () => {
    const current = {
      talkingTo: "ALL",
      directedConfidence: 0.6,
      source: "classifier",
      reason: "broad address"
    };
    const incoming = {
      talkingTo: "ME",
      directedConfidence: 0.56,
      source: "generation",
      reason: "named the bot"
    };

    assert.deepEqual(mergeVoiceAddressingAnnotation(current, incoming), {
      talkingTo: "ME",
      directedConfidence: 0.56,
      source: "generation",
      reason: "named the bot"
    });
  });
});

describe("findLatestVoiceTurnIndex", () => {
  test("matches the latest turn by normalized text, role, and user id", () => {
    const turns = [
      null,
      {
        role: "assistant",
        userId: null,
        speakerName: "bot",
        text: "hello there",
        at: 1
      },
      {
        role: "user",
        userId: "u1",
        speakerName: "alice",
        text: "hello world",
        at: 2
      },
      {
        role: "user",
        userId: "u1",
        speakerName: "alice",
        text: "hello    world",
        at: 3
      }
    ];

    const index = findLatestVoiceTurnIndex(turns, {
      role: "user",
      userId: "u1",
      text: "  hello world  "
    });

    assert.equal(index, 3);
  });

  test("returns the latest matching turn when text is omitted", () => {
    const turns = [
      {
        role: "user",
        userId: "u1",
        speakerName: "alice",
        text: "first",
        at: 1
      },
      {
        role: "user",
        userId: "u2",
        speakerName: "bob",
        text: "second",
        at: 2
      },
      {
        role: "user",
        userId: "u1",
        speakerName: "alice",
        text: "third",
        at: 3
      }
    ];

    const index = findLatestVoiceTurnIndex(turns, {
      role: "user",
      userId: "u1"
    });

    assert.equal(index, 2);
  });
});

describe("annotateLatestVoiceTurnAddressing", () => {
  test("annotates only the latest matching turns in both model and transcript histories", () => {
    const session = {
      recentVoiceTurns: [
        {
          role: "user" as const,
          userId: "u1",
          speakerName: "alice",
          text: "hey bot",
          at: 1
        },
        {
          role: "user" as const,
          userId: "u2",
          speakerName: "bob",
          text: "different",
          at: 2
        },
        {
          role: "user" as const,
          userId: "u1",
          speakerName: "alice",
          text: "hey   bot",
          at: 3
        }
      ],
      transcriptTurns: [
        {
          role: "user" as const,
          userId: "u1",
          speakerName: "alice",
          text: "hey bot",
          at: 10
        },
        {
          role: "assistant" as const,
          userId: null,
          speakerName: "bot",
          text: "yo",
          at: 11
        },
        {
          role: "user" as const,
          userId: "u1",
          speakerName: "alice",
          text: "hey bot",
          at: 12
        }
      ]
    };

    const annotated = annotateLatestVoiceTurnAddressing({
      session,
      role: "user",
      userId: "u1",
      text: "hey bot",
      addressing: {
        talkingTo: "ME",
        directedConfidence: 0.85,
        source: "generation"
      }
    });

    assert.equal(annotated, true);
    assert.equal(session.recentVoiceTurns[0]?.addressing, undefined);
    assert.deepEqual(session.recentVoiceTurns[2]?.addressing, {
      talkingTo: "ME",
      directedConfidence: 0.85,
      source: null,
      reason: null
    });
    assert.equal(session.transcriptTurns[0]?.addressing, undefined);
    assert.deepEqual(session.transcriptTurns[2]?.addressing, {
      talkingTo: "ME",
      directedConfidence: 0.85,
      source: null,
      reason: null
    });
  });

  test("returns false when it cannot find a matching turn to annotate", () => {
    const session = {
      recentVoiceTurns: [],
      transcriptTurns: []
    };

    const annotated = annotateLatestVoiceTurnAddressing({
      session,
      role: "user",
      userId: "u1",
      text: "missing",
      addressing: {
        talkingTo: "ME",
        directedConfidence: 0.9
      }
    });

    assert.equal(annotated, false);
  });
});

describe("buildVoiceAddressingState", () => {
  test("builds the current speaker target, last direct address, and recent guesses", () => {
    const state = buildVoiceAddressingState({
      userId: "u1",
      now: 2201,
      maxItems: 2,
      session: {
        transcriptTurns: [
          {
            role: "assistant",
            userId: null,
            speakerName: "bot",
            text: "reply",
            at: 1000,
            addressing: {
              talkingTo: "OTHER",
              directedConfidence: 0.4,
              source: "classifier",
              reason: null
            }
          },
          {
            role: "user",
            userId: "u2",
            speakerName: "Bob",
            text: "hi",
            at: 1200,
            addressing: {
              talkingTo: "ME",
              directedConfidence: 0.25,
              source: "classifier",
              reason: null
            }
          },
          {
            role: "user",
            userId: "u1",
            speakerName: "Alice",
            text: "first",
            at: 1500,
            addressing: {
              talkingTo: "everyone",
              directedConfidence: 0.8,
              source: "classifier",
              reason: null
            }
          },
          {
            role: "user",
            userId: "u1",
            speakerName: "Alice",
            text: "second",
            at: 1700,
            addressing: {
              talkingTo: "ME",
              directedConfidence: 0.3333
            }
          },
          {
            role: "user",
            userId: "u3",
            speakerName: "   ",
            text: "third",
            at: 0,
            addressing: {
              talkingTo: "friend",
              directedConfidence: 2
            }
          }
        ]
      }
    });

    assert.deepEqual(state, {
      currentSpeakerTarget: "ME",
      currentSpeakerDirectedConfidence: 0.333,
      lastDirectedToMe: {
        speakerName: "Alice",
        directedConfidence: 0.333,
        ageMs: 501
      },
      recentAddressingGuesses: [
        {
          speakerName: "Alice",
          talkingTo: "ME",
          directedConfidence: 0.333,
          ageMs: 501
        },
        {
          speakerName: "someone",
          talkingTo: "friend",
          directedConfidence: 1,
          ageMs: null
        }
      ]
    });
  });

  test("returns null when there are no transcript annotations to summarize", () => {
    const state = buildVoiceAddressingState({
      session: {
        transcriptTurns: [
          {
            role: "user",
            userId: "u1",
            speakerName: "alice",
            text: "hello",
            at: 1
          }
        ]
      }
    });

    assert.equal(state, null);
  });
});
