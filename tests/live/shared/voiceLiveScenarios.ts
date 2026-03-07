export type VoiceLiveScenarioExpected = {
  classifier: "YES" | "NO";
  admission: "allow" | "deny";
  generation: "reply" | "skip" | "either";
};

export type VoiceLiveScenario = {
  label: string;
  inputKind?: "transcript" | "event";
  botName?: string;
  eagerness?: number;
  participants: string[];
  speaker?: string;
  userId?: string;
  transcript: string;
  recentAssistantReply?: boolean;
  msSinceAssistantReply?: number | null;
  msSinceDirectAddress?: number | null;
  musicActive?: boolean;
  musicWakeLatched?: boolean;
  msUntilMusicWakeLatchExpiry?: number | null;
  timeline?: string[];
  expected: VoiceLiveScenarioExpected;
};

export type VoiceLiveScenarioGroup = {
  label: string;
  scenarios: VoiceLiveScenario[];
};

type VoiceScenarioOverrides = Partial<Omit<VoiceLiveScenario, "label" | "transcript" | "expected">>;
type VoiceScenarioBase = Omit<VoiceLiveScenario, "label" | "eagerness" | "expected"> & {
  transcript?: string;
};

function turns(...entries: string[]): string[] {
  return entries;
}

function deriveExpected(
  classifier: "YES" | "NO",
  overrides: Partial<VoiceLiveScenarioExpected> = {}
): VoiceLiveScenarioExpected {
  return {
    classifier,
    admission: classifier === "YES" ? "allow" : "deny",
    generation: classifier === "YES" ? "reply" : "skip",
    ...overrides
  };
}

function scenario(
  label: string,
  transcript: string,
  classifier: "YES" | "NO",
  overrides?: VoiceScenarioOverrides,
  expectedOverrides?: Partial<VoiceLiveScenarioExpected>
): VoiceLiveScenario {
  const participants = overrides?.participants ?? ["vuhlp"];
  const isEvent = overrides?.inputKind === "event";
  const speaker = overrides?.speaker ?? (isEvent ? "YOU" : participants[0]);
  return {
    label,
    transcript: transcript || (isEvent ? `[${speaker} joined the voice channel]` : ""),
    participants,
    speaker,
    expected: deriveExpected(classifier, expectedOverrides),
    ...overrides
  };
}

function eventScenario(
  label: string,
  classifier: "YES" | "NO",
  overrides?: VoiceScenarioOverrides,
  expectedOverrides?: Partial<VoiceLiveScenarioExpected>
): VoiceLiveScenario {
  return scenario(label, "", classifier, {
    inputKind: "event",
    ...overrides
  }, expectedOverrides);
}

function group(label: string, scenarios: VoiceLiveScenario[]): VoiceLiveScenarioGroup {
  return { label, scenarios };
}

function eagernessSweep(
  labelTemplate: string,
  base: VoiceScenarioBase,
  threshold: number,
  levels = [10, 20, 30, 50, 70, 90],
  expectedOverrides?: Partial<VoiceLiveScenarioExpected>
): VoiceLiveScenario[] {
  return levels.map((eagerness) => {
    const classifier = eagerness >= threshold ? "YES" : "NO";
    const participants = base.participants ?? ["vuhlp"];
    const isEvent = base.inputKind === "event";
    const speaker = base.speaker ?? (isEvent ? "YOU" : participants[0]);
    return {
      ...base,
      label: labelTemplate.replace("{e}", String(eagerness)),
      transcript: String(base.transcript || (isEvent ? `[${speaker} joined the voice channel]` : "")),
      participants,
      speaker,
      eagerness,
      expected: deriveExpected(classifier, expectedOverrides)
    };
  });
}

export const VOICE_LIVE_SCENARIO_GROUPS: VoiceLiveScenarioGroup[] = [
  group("name detection fast-paths", [
    scenario("exact bot name in transcript", "Hey clanker conk, what's up?", "YES"),
    scenario("partial bot name (clanker)", "Hey clanker, play some music", "YES"),
    scenario(
      "ASR garble: planka (shared consonants with clanker)",
      "Yo, can you play me some Migos planka?",
      "YES",
      {
        participants: ["vuhlp", "big bob", "poopy", "tim"]
      },
      {
        generation: "either"
      }
    ),
    scenario("no bot name, ambient chatter", "did you see the game last night?", "NO", {
      participants: ["alice", "bob", "carol"]
    })
  ]),

  group("join events", [
    ...eagernessSweep(
      "event: bot joins a 1:1 room @ eagerness {e}",
      {
        inputKind: "event",
        participants: ["vuhlp"],
        timeline: turns("[vuhlp joined the voice channel]")
      },
      10,
      [10, 25, 50],
      {
        generation: "either"
      }
    ),
    ...eagernessSweep(
      "event: bot joins a busy call @ eagerness {e}",
      {
        inputKind: "event",
        participants: ["vuhlp", "jake"],
        timeline: turns("vuhlp: i got mad aura", "jake: yea thats wild", "vuhlp: I wish I had some ice cream")
      },
      25,
      [10, 25, 50],
      {
        generation: "either"
      }
    ),
    ...eagernessSweep(
      "event: another person joins busy room mid-conversation @ eagerness {e}",
      {
        inputKind: "event",
        participants: ["alice", "bob", "carol"],
        speaker: "carol",
        timeline: turns('alice: "we should order food"', 'bob: "yeah maybe tacos"')
      },
      50,
      [10, 25, 50],
      {
        generation: "either"
      }
    )
  ]),

  group("music commands", [
    scenario("play command with bot name", "clanker conk play sicko mode", "YES", {
      participants: ["alice", "bob"]
    }),
    scenario("play command without bot name, active conversation", "Play Sicko Mode", "YES", {
      participants: ["alice", "bob"],
      recentAssistantReply: true,
      msSinceAssistantReply: 15_000
    }),
    scenario("skip during music with wake latch", "Skip this song", "YES", {
      musicActive: true,
      musicWakeLatched: true,
      msUntilMusicWakeLatchExpiry: 9_000,
      recentAssistantReply: true,
      msSinceAssistantReply: 5_000
    }),
    scenario("ambient chatter during music, no wake", "This beat is fire", "NO", {
      participants: ["vuhlp", "jake"],
      musicActive: true,
      musicWakeLatched: false
    })
  ]),

  group("clear engagement", [
    ...eagernessSweep(
      "fuzzy matching name @ eagerness {e}",
      {
        transcript: "Hi Clayton",
        participants: ["poopy", "jake"],
        recentAssistantReply: true,
        msSinceAssistantReply: 4_000,
        timeline: turns('poopy: "Whos that?"')
      },
      10,
      [10, 25, 50],
      {
        generation: "either"
      }
    ),
    ...eagernessSweep(
      "fuzzy matching name pt 2 @ eagerness {e}",
      {
        transcript: "Oh my god its clunky",
        participants: ["poopy", "jake"],
        recentAssistantReply: true,
        msSinceAssistantReply: 4_000,
        timeline: turns('poopy: "Oh my"')
      },
      10,
      [10, 25, 50],
      {
        generation: "either"
      }
    ),
    ...eagernessSweep(
      "direct follow up to bot after vague reply @ eagerness {e}",
      {
        participants: ["poopy", "jake"],
        transcript: "you always talkin bout chaos man",
        recentAssistantReply: true,
        msSinceAssistantReply: 7_000,
        timeline: turns(
          'poopy: "How you doing big bro?"',
          'YOU: "Im just vibing in the chaos right now"'
        )
      },
      25,
      [10, 25, 50]
    ),
    ...eagernessSweep(
      "1:1 question to the bot @ eagerness {e}",
      {
        transcript: "What's the weather like in New York?",
        participants: ["vuhlp", "jake"],
        recentAssistantReply: true,
        msSinceAssistantReply: 10_000,
        timeline: turns('YOU: "hey what\'s good"', 'vuhlp: "not much"', 'YOU: "cool cool"')
      },
      25,
      [10, 25, 50]
    ),
    ...eagernessSweep(
      "recent direct address, same speaker clarifies @ eagerness {e}",
      {
        transcript: "wait so Peru is Lima right?",
        participants: ["vuhlp", "jake"],
        speaker: "vuhlp",
        recentAssistantReply: false,
        msSinceDirectAddress: 4_000,
        timeline: turns(
          'vuhlp: "clanker conk what\'s the capital of Peru?"',
          'jake: "pretty sure it\'s Lima"'
        )
      },
      25,
      [10, 25, 50]
    ),
    ...eagernessSweep(
      "web search request, no recent assistant reply @ eagerness {e}",
      {
        participants: ["michael", "test"],
        transcript: "Can you look up Nintendo DS prices?",
        recentAssistantReply: false
      },
      10,
      [10, 25, 50]
    )
  ]),

  group("contextual engagement", [
    ...eagernessSweep(
      "multi-human subtle question to bot in conversation @ eagerness {e}",
      {
        transcript: "yea idk, dooo AI's like pizza?",
        participants: ["alice", "bob", "carol"],
        recentAssistantReply: true,
        msSinceAssistantReply: 15_000,
        msSinceDirectAddress: 15_000,
        timeline: turns('alice: "so what should we do for dinner?"', 'bob: "do AIs like pizza?"')
      },
      25,
      [10, 25, 50]
    ),
    ...eagernessSweep(
      "being naturally helpful in conversation @ eagerness {e}",
      {
        transcript: "How far is it?",
        participants: ["alice", "bob", "carol"],
        recentAssistantReply: true,
        msSinceAssistantReply: 15_000,
        msSinceDirectAddress: 15_000,
        timeline: turns(
          'alice: "I wish I knew how far away Dallas was from Chicago"',
          'bob: "Yeah, me too"'
        )
      },
      50,
      [10, 25, 50, 75]
    ),
    ...eagernessSweep(
      "NOT being annoyingly helpful in conversation @ eagerness {e}",
      {
        transcript: "How many are there?",
        participants: ["alice", "bob", "carol"],
        recentAssistantReply: true,
        msSinceAssistantReply: 15_000,
        msSinceDirectAddress: 15_000,
        timeline: turns(
          'alice: "How do I win Super mario?"',
          'bob: "you get all the stars."'
        )
      },
      75,
      [10, 25, 50, 75]
    ),
    ...eagernessSweep(
      "playing music in conversation @ eagerness {e}",
      {
        transcript: "Clank play Sicko Mode",
        participants: ["alice", "bob", "carol"],
        speaker: "bob",
        recentAssistantReply: true,
        msSinceAssistantReply: 15_000,
        msSinceDirectAddress: 15_000,
        timeline: turns('alice: "Tis the season to be jolly"', 'carol: "How many tictacs can u lick lack?"')
      },
      10,
      [10, 50],
      {
        generation: "either"
      }
    )
  ]),

  group("stays quiet", [
    ...eagernessSweep(
      "multi-human side conversation between humans @ eagerness {e}",
      {
        participants: ["alice", "bob", "carol"],
        transcript: "did you see the game last night?",
        timeline: turns("Alice: omg that game was crazy last night", "Bob: yeah it was insane", "Carol: Holy shit")
      },
      80,
      [10, 25, 50, 75, 80]
    ),
    ...eagernessSweep(
      "stale direct address after the room moved on @ eagerness {e}",
      {
        transcript: "nah, tacos are cheaper",
        participants: ["alice", "bob", "carol"],
        speaker: "carol",
        recentAssistantReply: false,
        msSinceDirectAddress: 45_000,
        timeline: turns(
          'alice: "clanker conk what should I order?"',
          'bob: "bro just get tacos"',
          'carol: "yeah tacos are cheaper"'
        )
      },
      50,
      [25, 50, 75]
    ),
    ...eagernessSweep(
      "filler laughter @ eagerness {e}",
      {
        transcript: "Haha, yea some Braydon like that suppose",
        participants: ["vuhlp", "jake"],
        timeline: turns(
          'jake: "and then he just fell off the chair"',
          'vuhlp: "no way dude"',
          'jake: "yeah bro it was hilarious"'
        )
      },
      80,
      [25, 50, 75, 80]
    ),
    scenario("backchannel noise", "Mm-hmm.", "NO"),
    scenario("self-talk / thinking out loud", "Wait, where did I put my keys...", "NO"),
    scenario("multi-human addressed to specific other person", "Carol, can you pass me that?", "NO", {
      participants: ["alice", "bob", "carol"],
      speaker: "bob"
    })
  ]),

  group("music wake latch", [
    scenario("music active, no wake, ambient chatter", "This beat is fire", "NO", {
      participants: ["vuhlp", "jake"],
      musicActive: true,
      musicWakeLatched: false
    }),
    ...eagernessSweep(
      "music active with wake latch - command should go through @ eagerness {e}",
      {
        transcript: "Skip this song",
        participants: ["vuhlp"],
        musicActive: true,
        musicWakeLatched: true,
        msUntilMusicWakeLatchExpiry: 9_000,
        recentAssistantReply: true,
        msSinceAssistantReply: 5_000
      },
      10,
      [10, 25, 50]
    ),
    ...eagernessSweep(
      "music wake latch carries a lightweight follow-up control @ eagerness {e}",
      {
        transcript: "Turn it up a little",
        participants: ["vuhlp", "jake"],
        musicActive: true,
        musicWakeLatched: true,
        msUntilMusicWakeLatchExpiry: 7_000,
        recentAssistantReply: true,
        msSinceAssistantReply: 8_000,
        timeline: turns(
          'vuhlp: "clanker conk play sicko mode"',
          'YOU: "playing sicko mode"',
          'jake: "this one is good"'
        )
      },
      10,
      [10, 25, 50]
    )
  ]),

  group("eagerness sweeps", [
    ...eagernessSweep(
      "eagerness {e}, follow up conversation",
      {
        participants: ["vuhlp", "jake"],
        speaker: "vuhlp",
        transcript: "yeah but what about game dev?",
        recentAssistantReply: true,
        msSinceAssistantReply: 10_000,
        timeline: turns(
          'vuhlp: "clank what do you think about rust?"',
          'YOU: "rust is great for systems programming"'
        )
      },
      25,
      [10, 25, 50]
    ),
    ...eagernessSweep(
      "eagerness {e}, follow up conversation, old conversation",
      {
        participants: ["vuhlp", "jake"],
        speaker: "vuhlp",
        transcript: "yeah but what about game dev?",
        recentAssistantReply: true,
        msSinceAssistantReply: 20_000,
        timeline: turns(
          'vuhlp: "clank what do you think about rust?"',
          'YOU: "rust is great for systems programming"'
        )
      },
      50,
      [10, 20, 50]
    ),
    ...eagernessSweep(
      "eagerness {e}, volunteer conversation",
      {
        participants: ["vuhlp", "jake"],
        transcript: "I wonder what the best programming language for game dev is",
        recentAssistantReply: true,
        msSinceAssistantReply: 60_000,
        timeline: turns(
          'vuhlp: "yo what do you think about rust?"',
          'jake: "rust is great for systems programming"',
          'vuhlp: "yeah but what about game dev?"'
        )
      },
      50,
      [10, 25, 50]
    ),
    ...eagernessSweep(
      "eagerness {e}, interrupt conversation",
      {
        participants: ["vuhlp", "jake"],
        transcript: "nah you stupid as shi for sayin that",
        recentAssistantReply: true,
        msSinceAssistantReply: 20_000,
        timeline: turns(
          'vuhlp: "yo what do you think about rust?"',
          'jake: "rust is great for systems programming"'
        )
      },
      80,
      [25, 50, 75, 80]
    ),
    ...eagernessSweep(
      "ambient chatter in 1:1 @ eagerness {e}",
      {
        participants: ["vuhlp"],
        transcript: "Man, what a day"
      },
      50,
      [10, 25, 50, 75]
    ),
    ...eagernessSweep(
      "ambient chatter in group @ eagerness {e}",
      {
        participants: ["lucky", "zeal"],
        transcript: "Man, what a day"
      },
      75,
      [10, 25, 50, 75]
    )
  ])
];
