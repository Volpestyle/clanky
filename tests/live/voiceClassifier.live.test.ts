/**
 * Live classifier tests — calls Haiku for real to validate prompt strategy.
 *
 * Run:  ANTHROPIC_API_KEY=sk-... bun test tests/live/voiceClassifier.live.test.ts
 *
 * These are NOT unit tests. They make real API calls and cost a small amount.
 */
import { beforeAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { buildClassifierPrompt } from "../../src/voice/voiceReplyDecision.ts";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = "claude-haiku-4-5-20251001";

let client: Anthropic;

beforeAll(() => {
  if (!ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is required for live classifier tests");
  }
  client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
});

type ClassifierScenario = {
  label: string;
  inputKind?: "transcript" | "event";
  botName?: string;
  eagerness?: number;
  participantCount: number;
  participants: string[];
  speaker: string;
  transcript: string;
  recentAssistantReply?: boolean;
  msSinceAssistantReply?: number | null;
  msSinceDirectAddress?: number | null;
  musicActive?: boolean;
  musicWakeLatched?: boolean;
  timeline?: string[];
  expected: "YES" | "NO";
};

async function runClassifier(scenario: ClassifierScenario): Promise<{ decision: "YES" | "NO"; raw: string }> {
  const { systemPrompt, userPrompt } = buildClassifierPrompt({
    botName: scenario.botName || "clanker conk",
    inputKind: scenario.inputKind || "transcript",
    replyEagerness: scenario.eagerness ?? 50,
    participantCount: scenario.participantCount,
    participantList: scenario.participants,
    speakerName: scenario.speaker,
    transcript: scenario.transcript,
    musicActive: scenario.musicActive,
    musicWakeLatched: scenario.musicWakeLatched,
    conversationContext: {
      recentAssistantReply: scenario.recentAssistantReply,
      msSinceAssistantReply: scenario.msSinceAssistantReply,
      msSinceDirectAddress: scenario.msSinceDirectAddress
    },
    recentHistory: scenario.timeline?.length ? scenario.timeline.join("\n") : undefined
  });

  const result = await client.messages.create({
    model: MODEL,
    max_tokens: 4,
    temperature: 0,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }]
  });
  const raw = result.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  const decision = raw.toUpperCase().includes("YES") ? "YES" : "NO";
  return { decision, raw };
}

const scenarios: ClassifierScenario[] = [
  {
    label: "event: bot joins a 1:1 room",
    inputKind: "event",
    participantCount: 1,
    participants: ["vuhlp"],
    speaker: "YOU",
    transcript: "[YOU joined the voice channel]",
    timeline: ["[vuhlp joined the voice channel]"],
    expected: "YES"
  },
  {
    label: "event: another person joins a busy room",
    inputKind: "event",
    participantCount: 3,
    participants: ["alice", "bob", "carol"],
    speaker: "carol",
    transcript: "[carol joined the voice channel]",
    timeline: ['alice: "we should order food"', 'bob: "yeah maybe tacos"'],
    expected: "NO"
  },
  {
    label: "direct follow-up to bot reply",
    participantCount: 2,
    participants: ["poopy", "jake"],
    speaker: "poopy",
    transcript: "Yo, what's up, man?",
    recentAssistantReply: true,
    msSinceAssistantReply: 4000,
    timeline: ['YOU: "yo, what\'s up?"'],
    expected: "YES"
  },
  {
    label: "music command",
    participantCount: 4,
    participants: ["vuhlp", "big bob", "poopy", "tim"],
    speaker: "vuhlp",
    transcript: "Yo, can you play me some Migos?",
    timeline: ["big bob: i got mad aura", "poopy: yea thats wild", "tim: no way dude"],
    expected: "YES"
  },
  {
    label: "web search request",
    participantCount: 2,
    participants: ["michael", "test"],
    speaker: "michael",
    transcript: "Can you look up Nintendo DS prices?",
    recentAssistantReply: true,
    msSinceAssistantReply: 8000,
    expected: "YES"
  },
  {
    label: "multi-human side conversation between humans",
    participantCount: 3,
    participants: ["alice", "bob", "carol"],
    speaker: "alice",
    transcript: "did you see the game last night?",
    timeline: ["Alice: omg that game was crazy last night", "Bob: yeah it was insane", "Carol: holy shit"],
    expected: "NO"
  },
  {
    label: "filler laughter",
    participantCount: 2,
    participants: ["vuhlp", "jake"],
    speaker: "vuhlp",
    transcript: "Hahaha",
    timeline: ['jake: "and then he just fell off the chair"', 'vuhlp: "no way dude"'],
    expected: "NO"
  },
  {
    label: "backchannel noise",
    participantCount: 1,
    participants: ["vuhlp"],
    speaker: "vuhlp",
    transcript: "Mm-hmm.",
    expected: "NO"
  },
  {
    label: "self-talk / thinking out loud",
    participantCount: 1,
    participants: ["vuhlp"],
    speaker: "vuhlp",
    transcript: "Wait, where did I put my keys...",
    expected: "NO"
  },
  {
    label: "music active, no wake, ambient chatter",
    participantCount: 2,
    participants: ["vuhlp", "jake"],
    speaker: "vuhlp",
    transcript: "This beat is fire",
    musicActive: true,
    musicWakeLatched: false,
    expected: "NO"
  },
  {
    label: "music active with wake latch — command should go through",
    participantCount: 1,
    participants: ["vuhlp"],
    speaker: "vuhlp",
    transcript: "Skip this song",
    musicActive: true,
    musicWakeLatched: true,
    recentAssistantReply: true,
    msSinceAssistantReply: 5000,
    expected: "YES"
  },
  ...[10, 20, 30, 50, 70, 90].map((e) => ({
    label: `eagerness ${e}, follow-up conversation`,
    eagerness: e,
    participantCount: 2,
    participants: ["vuhlp", "jake"],
    speaker: "jake",
    transcript: "yeah but what about game dev?",
    recentAssistantReply: true,
    msSinceAssistantReply: 20000,
    timeline: ['vuhlp: "clank what do you think about rust?"', 'YOU: "rust is great for systems programming"'],
    expected: (e >= 20 ? "YES" : "NO") as "YES" | "NO"
  })),
  ...[10, 20, 30, 50, 70, 90].map((e) => ({
    label: `eagerness ${e}, ambient 1:1`,
    eagerness: e,
    participantCount: 1,
    participants: ["vuhlp"],
    speaker: "vuhlp",
    transcript: "Man, what a day",
    expected: (e >= 50 ? "YES" : "NO") as "YES" | "NO"
  }))
];

describe("voice classifier live tests", () => {
  for (const scenario of scenarios) {
    test(scenario.label, async () => {
      const { decision, raw } = await runClassifier(scenario);
      assert.equal(
        decision,
        scenario.expected,
        `Expected ${scenario.expected} but got ${decision} (raw: "${raw}") for: ${scenario.label}`
      );
    });
  }
});
