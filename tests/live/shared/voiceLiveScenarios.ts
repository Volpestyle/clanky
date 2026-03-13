export type VoiceLiveScenarioExpected = {
  classifier: "YES" | "NO";
  admission: "allow" | "deny";
  generation: "reply" | "skip" | "intent";
  voiceIntent?: string | null;
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

// Shared live voice scenarios are a single source of truth for both suites.
// Keep admission plus generation/intent expectations coupled here.
function deriveExpected(
  classifier: "YES" | "NO"
): VoiceLiveScenarioExpected {
  return {
    classifier,
    admission: classifier === "YES" ? "allow" : "deny",
    generation: classifier === "YES" ? "reply" : "skip",
    voiceIntent: null
  };
}

function deriveIntentExpected(
  classifier: "YES" | "NO",
  voiceIntent: string
): VoiceLiveScenarioExpected {
  const base = deriveExpected(classifier);
  return {
    ...base,
    generation: classifier === "YES" ? "intent" : base.generation,
    voiceIntent: classifier === "YES" ? voiceIntent : null
  };
}

function scenario(
  label: string,
  transcript: string,
  classifier: "YES" | "NO",
  overrides?: VoiceScenarioOverrides
): VoiceLiveScenario {
  const participants = overrides?.participants ?? ["vuhlp"];
  const isEvent = overrides?.inputKind === "event";
  const speaker = overrides?.speaker ?? (isEvent ? "YOU" : participants[0]);
  return {
    label,
    transcript: transcript || (isEvent ? `[${speaker} joined the voice channel]` : ""),
    participants,
    speaker,
    expected: deriveExpected(classifier),
    ...overrides
  };
}

function intentScenario(
  label: string,
  transcript: string,
  classifier: "YES" | "NO",
  voiceIntent: string,
  overrides?: VoiceScenarioOverrides
): VoiceLiveScenario {
  const participants = overrides?.participants ?? ["vuhlp"];
  const isEvent = overrides?.inputKind === "event";
  const speaker = overrides?.speaker ?? (isEvent ? "YOU" : participants[0]);
  return {
    label,
    transcript: transcript || (isEvent ? `[${speaker} joined the voice channel]` : ""),
    participants,
    speaker,
    expected: deriveIntentExpected(classifier, voiceIntent),
    ...overrides
  };
}

function group(label: string, scenarios: VoiceLiveScenario[]): VoiceLiveScenarioGroup {
  return { label, scenarios };
}

function eagernessSweep(
  labelTemplate: string,
  base: VoiceScenarioBase,
  threshold: number,
  levels = [10, 20, 30, 50, 70, 90]
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
      expected: deriveExpected(classifier)
    };
  });
}

// Shared live voice scenarios are a single source of truth for admission plus
// generation. Some command rows expect an actionable voiceIntent instead of a
// spoken line.
export const VOICE_LIVE_SHARED_SCENARIO_GROUPS: VoiceLiveScenarioGroup[] = [
  group("name detection fast-paths", [
    scenario("exact bot name in transcript", "Hey clanky, what's up?", "YES"),
    scenario("partial bot name (clanker)", "Hey clanker, play some music", "YES"),
    scenario(
      "ASR garble: planka (shared consonants with clanker)",
      "Yo, can you play me some Migos planka?",
      "YES",
      {
        participants: ["vuhlp", "big bob", "poopy", "tim"]
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
      [10, 25, 50]
    ),
    ...eagernessSweep(
      "event: bot joins a busy call @ eagerness {e}",
      {
        inputKind: "event",
        participants: ["vuhlp", "jake"],
        timeline: turns("vuhlp: i got mad aura", "jake: yea thats wild", "vuhlp: I wish I had some ice cream")
      },
      25,
      [10, 25, 50]
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
      [10, 25, 50]
    )
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
      [10, 25, 50]
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
      [10, 25, 50]
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
      10,
      [10, 25, 50]
    ),
    scenario("one-on-one question after recent bot exchange", "What's the weather like in New York?", "YES", {
      eagerness: 25,
      participants: ["vuhlp"],
      recentAssistantReply: true,
      msSinceAssistantReply: 10_000,
      timeline: turns('YOU: "hey what\'s good"', 'vuhlp: "not much"', 'YOU: "cool cool"')
    }),
    scenario("recent direct address, same speaker clarifies", "wait so Peru is Lima right?", "YES", {
      eagerness: 25,
      participants: ["vuhlp", "jake"],
      speaker: "vuhlp",
      recentAssistantReply: false,
      msSinceDirectAddress: 4_000,
      timeline: turns(
        'vuhlp: "clanky what\'s the capital of Peru?"',
        'jake: "pretty sure it\'s Lima"'
      )
    })
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
    )
  ]),

  group("categorical restraint", [
    scenario("ambient web search request with no direct cue", "Can you look up Nintendo DS prices?", "NO", {
      eagerness: 25,
      participants: ["michael", "test"],
      recentAssistantReply: false
    }),
    scenario("not being annoyingly helpful after humans already answered", "How many are there?", "NO", {
      eagerness: 50,
      participants: ["alice", "bob", "carol"],
      recentAssistantReply: true,
      msSinceAssistantReply: 15_000,
      msSinceDirectAddress: 15_000,
      timeline: turns(
        'alice: "How do I win Super mario?"',
        'bob: "you get all the stars."'
      )
    }),
    scenario("multi-human side conversation between humans", "did you see the game last night?", "NO", {
      eagerness: 50,
      participants: ["alice", "bob", "carol"],
      timeline: turns("Alice: omg that game was crazy last night", "Bob: yeah it was insane", "Carol: Holy shit")
    }),
    scenario("stale direct address after the room moved on", "nah, tacos are cheaper", "NO", {
      eagerness: 50,
      participants: ["alice", "bob", "carol"],
      speaker: "carol",
      recentAssistantReply: false,
      msSinceDirectAddress: 45_000,
      timeline: turns(
        'alice: "clanky what should I order?"',
        'bob: "bro just get tacos"',
        'carol: "yeah tacos are cheaper"'
      )
    }),
    scenario("filler laughter in human banter", "Haha, yea some Braydon like that suppose", "NO", {
      eagerness: 50,
      participants: ["vuhlp", "jake"],
      timeline: turns(
        'jake: "and then he just fell off the chair"',
        'vuhlp: "no way dude"',
        'jake: "yeah bro it was hilarious"'
      )
    }),
    scenario("backchannel noise", "Mm-hmm.", "NO"),
    scenario("self-talk / thinking out loud", "Wait, where did I put my keys...", "NO"),
    scenario("multi-human addressed to specific other person", "Carol, can you pass me that?", "NO", {
      participants: ["alice", "bob", "carol"],
      speaker: "bob"
    })
  ]),

  group("command recognition", [
    intentScenario("play command with bot name", "clanky play sicko mode", "YES", "music_play", {
      eagerness: 10,
      participants: ["alice", "bob"]
    }),
    intentScenario("play command without bot name, active conversation", "Play Sicko Mode", "YES", "music_play", {
      eagerness: 10,
      participants: ["alice", "bob"],
      recentAssistantReply: true,
      msSinceAssistantReply: 15_000
    }),
    intentScenario("playing music in conversation", "Clank play Sicko Mode", "YES", "music_play", {
      eagerness: 10,
      participants: ["alice", "bob", "carol"],
      speaker: "bob",
      recentAssistantReply: true,
      msSinceAssistantReply: 15_000,
      msSinceDirectAddress: 15_000,
      timeline: turns('alice: "Tis the season to be jolly"', 'carol: "How many tictacs can u lick lack?"')
    })
  ]),

  group("music wake latch handling", [
    scenario("ambient chatter during music, no wake", "This beat is fire", "NO", {
      eagerness: 10,
      participants: ["vuhlp", "jake"],
      musicActive: true,
      musicWakeLatched: false
    }),
    intentScenario("skip during music with wake latch", "Skip this song", "YES", "music_queue_next", {
      eagerness: 10,
      participants: ["vuhlp", "jake"],
      musicActive: true,
      musicWakeLatched: true,
      msUntilMusicWakeLatchExpiry: 9_000,
      recentAssistantReply: true,
      msSinceAssistantReply: 5_000
    }),
    scenario("music wake latch carries a lightweight follow-up control", "Turn it up a little", "YES", {
      eagerness: 10,
      participants: ["vuhlp", "jake"],
      musicActive: true,
      musicWakeLatched: true,
      msUntilMusicWakeLatchExpiry: 7_000,
      recentAssistantReply: true,
      msSinceAssistantReply: 8_000,
      timeline: turns(
        'vuhlp: "clanky play sicko mode"',
        'YOU: "playing sicko mode"',
        'jake: "this one is good"'
      )
    })
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
      "eagerness {e}, volunteer conversation (stale, 60s)",
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
      "eagerness {e}, volunteer conversation (fresh, 12s)",
      {
        participants: ["vuhlp", "jake"],
        transcript: "wait is there a way to run python inside a game engine?",
        recentAssistantReply: true,
        msSinceAssistantReply: 12_000,
        timeline: turns(
          'vuhlp: "I been messing with godot lately"',
          'jake: "oh nice, what language does it use?"',
          'vuhlp: "gdscript but I kinda wish it was python"'
        )
      },
      25,
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
