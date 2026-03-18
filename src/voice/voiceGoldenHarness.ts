import { performance } from "node:perf_hooks";
import { appConfig } from "../config.ts";
import { LLMService } from "../llm.ts";
import { ClankerBot } from "../bot.ts";
import { DEFAULT_SETTINGS } from "../settings/settingsSchema.ts";
import { normalizeSettings } from "../store/settingsNormalization.ts";
import { parseBooleanFlag } from "../normalization/valueParsers.ts";
import { WebSearchService } from "../services/search.ts";
import { runJsonJudge } from "../../scripts/replay/core/judge.ts";
import { summarizeNamedMetricRows, type NumericStats } from "../../scripts/replay/core/metrics.ts";
import { formatPct, stableNumber } from "../../scripts/replay/core/utils.ts";
import { VoiceSessionManager } from "./voiceSessionManager.ts";
import { VOICE_RUNTIME_MODES, parseVoiceRuntimeMode } from "./voiceModes.ts";
import { sleep } from "../normalization/time.ts";

export const VOICE_GOLDEN_MODES = VOICE_RUNTIME_MODES;

type VoiceGoldenMode = (typeof VOICE_GOLDEN_MODES)[number];
type VoiceGoldenRunMode = "simulated" | "live";

type VoiceGoldenCase = {
  id: string;
  title: string;
  userText: string;
  expectedAllow: boolean;
  expectedResponse?: "non_empty" | "empty";
  objective: string;
  participantCount?: number;
  participantDisplayNames?: string[];
  sessionAgeMs?: number;
  recentAssistantReplyMs?: number;
  recentDirectAddressMs?: number;
  recentDirectAddressUserId?: string;
};

type VoiceGoldenJudgeConfig = {
  enabled: boolean;
  provider: string;
  model: string;
};

type VoiceGoldenHarnessOptions = {
  mode?: VoiceGoldenRunMode;
  modes?: VoiceGoldenMode[];
  iterations?: number;
  actorProvider?: string;
  actorModel?: string;
  deciderProvider?: string;
  deciderModel?: string;
  judge?: Partial<VoiceGoldenJudgeConfig>;
  allowMissingCredentials?: boolean;
  maxCases?: number;
  onCaseProgress?: (event: VoiceGoldenCaseProgressEvent) => void;
};

type VoiceGoldenResolvedOptions = {
  mode: VoiceGoldenRunMode;
  modes: VoiceGoldenMode[];
  iterations: number;
  actorProvider: string;
  actorModel: string;
  deciderProvider: string;
  deciderModel: string;
  judge: VoiceGoldenJudgeConfig;
  allowMissingCredentials: boolean;
  maxCases: number;
};

type StageTimings = {
  totalMs: number;
  decisionMs: number;
  connectMs: number;
  inputPrepMs: number;
  inputSendMs: number;
  actorMs: number;
  asrMs: number;
  ttsMs: number;
  outputAsrMs: number;
  responseMs: number;
};

type DecisionResult = {
  allow: boolean;
  reason: string;
  directAddressed: boolean;
  transcript: string;
  error: string;
};

type ModeExecutionResult = {
  transcript: string;
  responseText: string;
  audioBytes: number;
  stage: Omit<StageTimings, "totalMs" | "decisionMs">;
};

type JudgeResult = {
  pass: boolean;
  score: number;
  confidence: number;
  summary: string;
  issues: string[];
  rawText: string;
};

type VoiceGoldenCaseResult = {
  mode: VoiceGoldenMode;
  caseId: string;
  caseTitle: string;
  iteration: number;
  expectedAllow: boolean;
  decision: DecisionResult;
  transcript: string;
  responseText: string;
  audioBytes: number;
  timings: StageTimings;
  pass: boolean;
  judge: JudgeResult;
  error: string | null;
};

type VoiceGoldenModeReport = {
  mode: VoiceGoldenMode;
  skippedReason: string | null;
  results: VoiceGoldenCaseResult[];
  aggregates: {
    executed: number;
    passed: number;
    failed: number;
    passRate: number;
    stageStats: Record<string, StageStat>;
  };
};

type StageStat = NumericStats;

type VoiceGoldenHarnessReport = {
  startedAt: string;
  finishedAt: string;
  options: VoiceGoldenResolvedOptions;
  modeReports: VoiceGoldenModeReport[];
  summary: {
    executed: number;
    passed: number;
    failed: number;
    passRate: number;
    stageStats: Record<string, StageStat>;
  };
};

type VoiceGoldenCaseProgressEvent = {
  phase: "start" | "done";
  mode: VoiceGoldenMode;
  iteration: number;
  modeCaseIndex: number;
  modeCaseCount: number;
  globalCaseIndex: number;
  globalCaseCount: number;
  caseId: string;
  caseTitle: string;
  expectedAllow: boolean;
  pass?: boolean;
  decisionAllow?: boolean;
  decisionReason?: string;
  error?: string | null;
  durationMs?: number;
};

type VoiceGoldenCaseProgressLogger = (event: VoiceGoldenCaseProgressEvent) => void;

function buildVoiceGoldenCaseProgressLine(event: VoiceGoldenCaseProgressEvent): string {
  const base = [
    `mode=${event.mode}`,
    `iteration=${event.iteration}`,
    `modeCase=${event.modeCaseIndex}/${event.modeCaseCount}`,
    `globalCase=${event.globalCaseIndex}/${event.globalCaseCount}`,
    `case=${event.caseId}`
  ].join(" ");

  if (event.phase === "start") {
    return `[voice-golden] start ${base}`;
  }

  const durationMs = Math.max(0, Number(event.durationMs || 0)).toFixed(1);
  return [
    "[voice-golden] done",
    base,
    `pass=${event.pass ? "yes" : "no"}`,
    `allow=${event.decisionAllow ? "yes" : "no"}`,
    `reason=${event.decisionReason || "none"}`,
    `durationMs=${durationMs}`,
    `error=${event.error || "none"}`
  ].join(" ");
}

export function createVoiceGoldenCaseProgressLogger({
  log = (line: string) => {
    console.log(line);
  }
}: {
  log?: (line: string) => void;
} = {}): VoiceGoldenCaseProgressLogger {
  return (event) => {
    log(buildVoiceGoldenCaseProgressLine(event));
  };
}

type DecisionLlmTrace = {
  guildId: string | null;
  channelId: string | null;
  userId: string | null;
  source: string | null;
  event: string | null;
  reason: string | null;
  messageId: string | null;
};

type DecisionLlmGeneratePayload = {
  settings: Record<string, unknown>;
  systemPrompt: string;
  userPrompt: string;
  contextMessages?: unknown[];
  trace?: DecisionLlmTrace;
  jsonSchema?: string;
};

type DecisionLlmGenerateResult = {
  text?: string;
  provider?: string;
  model?: string;
};

type DecisionLlm = {
  generate: (payload: DecisionLlmGeneratePayload) => Promise<DecisionLlmGenerateResult>;
};

type HarnessStoreAction = {
  kind?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  usdCost?: number;
  createdAt?: string;
};

class HarnessStore {
  actions: HarnessStoreAction[];

  constructor() {
    this.actions = [];
  }

  logAction(action: HarnessStoreAction) {
    this.actions.push({
      ...(action || {}),
      createdAt:
        String(action?.createdAt || "").trim() || new Date().toISOString()
    });
  }

  getSettings() {
    return {
      botName: "clanky"
    };
  }

  countActionsSince(kind: string, sinceIso: string) {
    const targetKind = String(kind || "").trim();
    const sinceAt = Date.parse(String(sinceIso || ""));
    if (!targetKind || !Number.isFinite(sinceAt)) return 0;

    let count = 0;
    for (const action of this.actions) {
      if (String(action?.kind || "") !== targetKind) continue;
      const createdAt = Date.parse(String(action?.createdAt || ""));
      if (!Number.isFinite(createdAt)) continue;
      if (createdAt >= sinceAt) count += 1;
    }
    return count;
  }
}

const VOICE_GOLDEN_CASES: VoiceGoldenCase[] = [
  {
    id: "wake-ping",
    title: "Wake Ping",
    userText: "yo clanker",
    expectedAllow: true,
    objective: "Give a short natural acknowledgement suitable for live voice."
  },
  {
    id: "wake-ping-laughter-followup",
    title: "Wake Ping Laughter Followup",
    userText: "haha",
    expectedAllow: true,
    expectedResponse: "empty",
    objective: "After a recent direct wake ping and bot acknowledgement, skip pure laughter/backchannel follow-up instead of filling space.",
    participantCount: 1,
    participantDisplayNames: ["alice"],
    sessionAgeMs: 8_000,
    recentAssistantReplyMs: 3_000,
    recentDirectAddressMs: 4_000,
    recentDirectAddressUserId: "speaker-1"
  },
  {
    id: "direct-question",
    title: "Direct Question",
    userText: "clanker can you explain in one sentence why rust ownership matters?",
    expectedAllow: true,
    objective: "Reply with a short, relevant explanation tied to Rust ownership."
  },
  {
    id: "merged-name",
    title: "Merged Name",
    userText: "clankerconk are you there right now?",
    expectedAllow: true,
    objective: "Acknowledge the direct callout and respond briefly."
  },
  {
    id: "fresh-join-greeting-yo-single",
    title: "Fresh Join Greeting Yo (Single)",
    userText: "yo",
    expectedAllow: true,
    objective: "Right after join, treat a short greeting as worth a brief acknowledgement.",
    participantCount: 1,
    participantDisplayNames: ["alice"],
    sessionAgeMs: 4_000
  },
  {
    id: "fresh-join-greeting-yo-multi",
    title: "Fresh Join Greeting Yo (Multi)",
    userText: "yo",
    expectedAllow: true,
    objective: "Right after join in a group call, treat a short greeting as worth a brief acknowledgement.",
    participantCount: 2,
    participantDisplayNames: ["alice", "bob"],
    sessionAgeMs: 4_000
  },
  {
    id: "fresh-join-greeting-hi-single",
    title: "Fresh Join Greeting Hi (Single)",
    userText: "hi",
    expectedAllow: true,
    objective: "Right after join, treat a hi greeting as worth a brief acknowledgement.",
    participantCount: 1,
    participantDisplayNames: ["alice"],
    sessionAgeMs: 4_000
  },
  {
    id: "fresh-join-greeting-hi-multi",
    title: "Fresh Join Greeting Hi (Multi)",
    userText: "hi",
    expectedAllow: true,
    objective: "Right after join in a group call, treat a hi greeting as worth a brief acknowledgement.",
    participantCount: 2,
    participantDisplayNames: ["alice", "bob"],
    sessionAgeMs: 4_000
  },
  {
    id: "fresh-join-greeting-sup-single",
    title: "Fresh Join Greeting Sup (Single)",
    userText: "sup",
    expectedAllow: true,
    objective: "Right after join, treat a sup check-in as worth a brief acknowledgement.",
    participantCount: 1,
    participantDisplayNames: ["alice"],
    sessionAgeMs: 4_000
  },
  {
    id: "fresh-join-greeting-sup-multi",
    title: "Fresh Join Greeting Sup (Multi)",
    userText: "sup",
    expectedAllow: true,
    objective: "Right after join in a group call, treat a sup check-in as worth a brief acknowledgement.",
    participantCount: 2,
    participantDisplayNames: ["alice", "bob"],
    sessionAgeMs: 4_000
  },
  {
    id: "fresh-join-greeting-yo-clanka-single",
    title: "Fresh Join Greeting Yo Clanka (Single)",
    userText: "yo clanka",
    expectedAllow: true,
    objective: "Treat likely wake-word variants in greeting form as direct enough to acknowledge.",
    participantCount: 1,
    participantDisplayNames: ["alice"],
    sessionAgeMs: 4_000
  },
  {
    id: "fresh-join-greeting-yo-clanka-multi",
    title: "Fresh Join Greeting Yo Clanka (Multi)",
    userText: "yo clanka",
    expectedAllow: true,
    objective: "In group calls, treat likely wake-word variant greetings as direct enough to acknowledge.",
    participantCount: 2,
    participantDisplayNames: ["alice", "bob"],
    sessionAgeMs: 4_000
  },
  {
    id: "fresh-join-non-greeting-undirected",
    title: "Fresh Join Non-Greeting Undirected",
    userText: "the build passed on main",
    expectedAllow: true,
    objective: "Non-greeting, non-directed chatter is passed to the brain which may skip.",
    participantCount: 2,
    participantDisplayNames: ["alice", "bob"],
    sessionAgeMs: 4_000
  },
  {
    id: "fresh-join-non-greeting-undirected-single",
    title: "Fresh Join Non-Greeting Undirected (Single)",
    userText: "the build passed on main",
    expectedAllow: true,
    objective: "Non-greeting, non-directed chatter is passed to the brain which may skip, even in 1:1.",
    participantCount: 1,
    participantDisplayNames: ["alice"],
    sessionAgeMs: 4_000
  },
  {
    id: "fresh-join-directed-to-other",
    title: "Fresh Join Directed To Other Human",
    userText: "bob can you share the link",
    expectedAllow: true,
    objective: "Passed to brain which detects this is addressed to another human and may skip.",
    participantCount: 2,
    participantDisplayNames: ["alice", "bob"],
    sessionAgeMs: 4_000
  },
  {
    id: "low-signal-lol",
    title: "Low Signal Fragment",
    userText: "lol",
    expectedAllow: true,
    objective: "Low-signal fragment passed to brain which decides whether to skip."
  },
  {
    id: "low-signal-comment",
    title: "Low Signal Comment",
    userText: "ha!",
    expectedAllow: true,
    objective: "Low-signal fragment passed to brain which decides whether to skip."
  },
  {
    id: "unaddressed-clear-question",
    title: "Unaddressed Clear Question",
    userText: "what's the fastest way to reduce build times in this project?",
    expectedAllow: true,
    objective: "Provide a concise practical suggestion even without explicit bot naming."
  },
  {
    id: "fresh-fact-check",
    title: "Fresh Fact Check",
    userText: "clanker what's the latest rust stable version right now?",
    expectedAllow: true,
    objective: "Use a web lookup if needed for freshness, then answer in one short line."
  }
];

const DEFAULT_MAX_CASES = VOICE_GOLDEN_CASES.length;
const DEFAULT_CASE_SESSION_AGE_MS = 40_000;
const DEFAULT_CASE_PARTICIPANTS = ["alice", "bob"];
const MAX_CASE_PARTICIPANTS = 10;

function normalizeParticipantDisplayNames(value: unknown) {
  if (!Array.isArray(value)) return [];
  const dedupe = new Set<string>();
  const names: string[] = [];
  for (const item of value) {
    const raw = String(item || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    if (!raw) continue;
    const dedupeKey = raw.toLowerCase();
    if (dedupe.has(dedupeKey)) continue;
    dedupe.add(dedupeKey);
    names.push(raw);
    if (names.length >= MAX_CASE_PARTICIPANTS) break;
  }
  return names;
}

function resolveCaseContext(caseRow: VoiceGoldenCase | null = null) {
  const configuredNames = normalizeParticipantDisplayNames(caseRow?.participantDisplayNames);
  const configuredCount = Number(caseRow?.participantCount);
  const fallbackCount = configuredNames.length || DEFAULT_CASE_PARTICIPANTS.length;
  const rawCount = Number.isFinite(configuredCount)
    ? Math.floor(configuredCount)
    : fallbackCount;
  const participantCount = Math.max(1, Math.min(MAX_CASE_PARTICIPANTS, rawCount));
  const participantDisplayNames =
    configuredNames.length > 0
      ? configuredNames.slice(0, participantCount)
      : DEFAULT_CASE_PARTICIPANTS.slice(0, participantCount);
  while (participantDisplayNames.length < participantCount) {
    participantDisplayNames.push(`speaker-${participantDisplayNames.length + 1}`);
  }
  const configuredSessionAgeMs = Number(caseRow?.sessionAgeMs);
  const sessionAgeMs = Number.isFinite(configuredSessionAgeMs)
    ? Math.max(0, Math.min(300_000, Math.round(configuredSessionAgeMs)))
    : DEFAULT_CASE_SESSION_AGE_MS;
  return {
    participantCount,
    participantDisplayNames,
    sessionAgeMs,
    recentAssistantReplyMs: Number.isFinite(Number(caseRow?.recentAssistantReplyMs))
      ? Math.max(0, Math.min(sessionAgeMs, Math.round(Number(caseRow?.recentAssistantReplyMs))))
      : null,
    recentDirectAddressMs: Number.isFinite(Number(caseRow?.recentDirectAddressMs))
      ? Math.max(0, Math.min(sessionAgeMs, Math.round(Number(caseRow?.recentDirectAddressMs))))
      : null,
    recentDirectAddressUserId:
      String(caseRow?.recentDirectAddressUserId || "").trim() || null
  };
}

function resolveExpectedResponse(caseRow: VoiceGoldenCase) {
  return caseRow.expectedResponse || (caseRow.expectedAllow ? "non_empty" : "empty");
}

function normalizeMode(value: unknown): VoiceGoldenRunMode {
  return String(value || "simulated").trim().toLowerCase() === "live" ? "live" : "simulated";
}

function normalizeVoiceModeList(values: unknown): VoiceGoldenMode[] {
  if (Array.isArray(values)) {
    return values
      .map((value) => normalizeVoiceMode(value))
      .filter((value): value is VoiceGoldenMode => Boolean(value));
  }
  if (typeof values === "string") {
    return values
      .split(",")
      .map((value) => normalizeVoiceMode(value))
      .filter((value): value is VoiceGoldenMode => Boolean(value));
  }
  return [...VOICE_GOLDEN_MODES];
}

function normalizeVoiceMode(value: unknown): VoiceGoldenMode | null {
  return parseVoiceRuntimeMode(value);
}

function resolveDefaults(options: VoiceGoldenHarnessOptions = {}): VoiceGoldenResolvedOptions {
  const requestedModes = normalizeVoiceModeList(options.modes);
  return {
    mode: normalizeMode(options.mode),
    modes: requestedModes.length ? requestedModes : [...VOICE_GOLDEN_MODES],
    iterations: Math.max(1, Math.floor(Number(options.iterations) || 1)),
    actorProvider: String(options.actorProvider || "claude-oauth").trim() || "claude-oauth",
    actorModel: String(options.actorModel || "claude-sonnet-4-5").trim() || "claude-sonnet-4-5",
    deciderProvider: String(options.deciderProvider || "claude-oauth").trim() || "claude-oauth",
    deciderModel: String(options.deciderModel || "claude-sonnet-4-6").trim() || "claude-sonnet-4-6",
    judge: {
      enabled:
        options.judge?.enabled !== undefined
          ? Boolean(options.judge.enabled)
          : true,
      provider: String(options.judge?.provider || "claude-oauth").trim() || "claude-oauth",
      model: String(options.judge?.model || "claude-sonnet-4-6").trim() || "claude-sonnet-4-6"
    },
    allowMissingCredentials: parseBooleanFlag(options.allowMissingCredentials, false),
    maxCases: Math.max(1, Math.min(VOICE_GOLDEN_CASES.length, Math.floor(Number(options.maxCases) || DEFAULT_MAX_CASES)))
  };
}

function buildHarnessSettings({
  voiceMode,
  actorProvider,
  actorModel,
  deciderProvider,
  deciderModel
}: {
  voiceMode: VoiceGoldenMode;
  actorProvider: string;
  actorModel: string;
  deciderProvider: string;
  deciderModel: string;
}) {
  return normalizeSettings({
    ...DEFAULT_SETTINGS,
    botName: "clanky",
    memory: {
      enabled: false
    },
    webSearch: {
      enabled: true,
      maxSearchesPerHour: 12
    },
    llm: {
      provider: actorProvider,
      model: actorModel,
      temperature: 0.25,
      maxOutputTokens: 160
    },
    voice: {
      enabled: true,
      mode: voiceMode,
      replyPath: "brain",
      ambientReplyEagerness: 65,
      generationLlm: {
        provider: actorProvider,
        model: actorModel
      },
      replyDecisionLlm: {
        provider: deciderProvider,
        model: deciderModel
      },
      xai: {
        voice: "Rex",
        audioFormat: "audio/pcm",
        sampleRateHz: 24000,
        region: "us-east-1"
      },
      openaiRealtime: {
        model: "gpt-realtime",
        voice: "alloy",
        inputAudioFormat: "pcm16",
        outputAudioFormat: "pcm16",
        inputTranscriptionModel: "gpt-4o-mini-transcribe"
      },
      geminiRealtime: {
        model: "gemini-2.5-flash-native-audio-preview-12-2025",
        voice: "Aoede",
        apiBaseUrl: "https://generativelanguage.googleapis.com",
        inputSampleRateHz: 24000,
        outputSampleRateHz: 24000
      },
      openaiAudioApi: {
        ttsModel: "gpt-4o-mini-tts",
        ttsVoice: "alloy",
        ttsSpeed: 1
      }
    }
  });
}

function buildJudgeSettings(judge: VoiceGoldenJudgeConfig) {
  return normalizeSettings({
    ...DEFAULT_SETTINGS,
    memory: {
      enabled: false
    },
    llm: {
      provider: judge.provider,
      model: judge.model,
      temperature: 0,
      maxOutputTokens: 260
    }
  });
}

function buildStageStats(rows: VoiceGoldenCaseResult[]): Record<string, StageStat> {
  return summarizeNamedMetricRows(rows.map((row) => ({ ...row.timings })));
}

function stablePassRate(passed: number, executed: number) {
  return formatPct(passed, executed);
}

function hashString(value: string) {
  let hash = 0;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function simulatedDelayMs(key: string, baseMs: number, spreadMs: number) {
  const hash = hashString(key);
  return baseMs + (hash % Math.max(1, spreadMs));
}

function isGreetingCheckIn(text: string) {
  const normalized = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return false;
  const tokens = normalized.split(" ").filter(Boolean);
  if (!tokens.length) return false;
  const firstToken = tokens[0];
  const firstTwoTokens = tokens.slice(0, 2).join(" ");
  const shortGreetingTokens = new Set(["yo", "hi", "hey", "hello", "sup", "hola"]);
  if (shortGreetingTokens.has(firstToken)) return true;
  if (firstTwoTokens === "what up" || firstTwoTokens === "whats up" || firstTwoTokens === "what's up") {
    return true;
  }
  if (normalized === "whatsup" || normalized === "wassup") return true;
  return false;
}

function extractPromptTranscript(prompt: string) {
  const transcriptMatch = prompt.match(/(?:latest\s+transcript|transcript):\s*"([^"]+)"/u);
  return String(transcriptMatch?.[1] || "")
    .trim()
    .toLowerCase();
}

function extractPromptFlag({
  prompt,
  label
}: {
  prompt: string;
  label: string;
}) {
  const normalizedLabel = label
    .toLowerCase()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = prompt.match(new RegExp(`${normalizedLabel}:\\s*(yes|no)`, "u"));
  return match?.[1] === "yes";
}

function buildSimulatedDecisionLlm(): DecisionLlm {
  return {
    async generate(payload) {
      const prompt = String(payload?.userPrompt || "").toLowerCase();
      const transcript = extractPromptTranscript(prompt);
      const freshJoinCue =
        prompt.includes("you just joined") ||
        prompt.includes("someone joined or left");
      const likelyAimedAtOtherParticipant = extractPromptFlag({
        prompt,
        label: "likely aimed at another participant"
      });
      const directlyAddressed = extractPromptFlag({
        prompt,
        label: "directly addressed"
      });
      if (!transcript) return { text: "NO", provider: "simulated", model: "rule-decider" };
      if (likelyAimedAtOtherParticipant) {
        return { text: "NO", provider: "simulated", model: "rule-decider" };
      }
      if (directlyAddressed) return { text: "YES", provider: "simulated", model: "rule-decider" };
      if (transcript.includes("clanker")) return { text: "YES", provider: "simulated", model: "rule-decider" };
      if (freshJoinCue && isGreetingCheckIn(transcript)) {
        return { text: "YES", provider: "simulated", model: "rule-decider" };
      }
      if (/[?]/.test(transcript) && transcript.length > 6) {
        return { text: "YES", provider: "simulated", model: "rule-decider" };
      }
      return { text: "NO", provider: "simulated", model: "rule-decider" };
    }
  };
}

function applyCaseContextToManager({
  manager,
  caseRow
}: {
  manager: VoiceSessionManager;
  caseRow: VoiceGoldenCase | null;
}) {
  const context = resolveCaseContext(caseRow);
  manager.countHumanVoiceParticipants = () => context.participantCount;
  manager.getVoiceChannelParticipants = () =>
    context.participantDisplayNames.map((displayName, index) => ({
      userId: `speaker-${index + 1}`,
      displayName
    }));
  return context;
}

function createDecisionRuntime(llm: DecisionLlm) {
  const store = new HarnessStore();
  const manager = new VoiceSessionManager({
    client: {
      on() {},
      off() {},
      guilds: { cache: new Map() },
      users: { cache: new Map() },
      user: { id: "bot-user", username: "clanky" }
    },
    store,
    appConfig,
    llm,
    memory: null
  });
  applyCaseContextToManager({
    manager,
    caseRow: null
  });
  return {
    manager,
    store
  };
}

function createLiveExecutionRuntime({
  llm,
  search,
  store
}: {
  llm: LLMService;
  search: WebSearchService;
  store: HarnessStore;
}) {
  const bot = new ClankerBot({
    appConfig: {
      ...appConfig,
      disableSimulatedTypingDelay: true
    },
    store,
    llm,
    memory: null,
    discovery: null,
    search,
    gifs: null,
    video: null
  });

  bot.client.user = {
    id: "bot-user",
    username: "clanky",
    tag: "clanky#0001"
  };

  const manager = bot.voiceSessionManager;
  applyCaseContextToManager({
    manager,
    caseRow: null
  });

  return {
    bot,
    manager
  };
}

function createDecisionSession({
  mode,
  caseRow
}: {
  mode: VoiceGoldenMode;
  caseRow: VoiceGoldenCase;
}) {
  const context = resolveCaseContext(caseRow);
  const now = Date.now();
  return {
    id: `voice-golden-${mode}`,
    guildId: "voice-golden-guild",
    textChannelId: "voice-golden-text",
    voiceChannelId: "voice-golden-voice",
    mode,
    botTurnOpen: false,
    startedAt: now - context.sessionAgeMs,
    lastAudioDeltaAt:
      context.recentAssistantReplyMs != null ? now - context.recentAssistantReplyMs : 0,
    lastDirectAddressAt:
      context.recentDirectAddressMs != null ? now - context.recentDirectAddressMs : 0,
    lastDirectAddressUserId: context.recentDirectAddressUserId || "",
    musicWakeLatchedUntil: 0,
    musicWakeLatchedByUserId: null,
    recentVoiceTurns: []
  };
}

async function evaluateDecision({
  manager,
  settings,
  mode,
  caseRow
}: {
  manager: VoiceSessionManager;
  settings: Record<string, unknown>;
  mode: VoiceGoldenMode;
  caseRow: VoiceGoldenCase;
}) {
  const startedAt = performance.now();
  const decision = await manager.evaluateVoiceReplyDecision({
    session: createDecisionSession({
      mode,
      caseRow
    }),
    userId: "speaker-1",
    settings,
    transcript: caseRow.userText,
    source: "realtime"
  });
  const decisionMs = performance.now() - startedAt;

  return {
    decisionMs,
    decision: {
      allow: Boolean(decision.allow),
      reason: String(decision.reason || ""),
      directAddressed: Boolean(decision.directAddressed),
      transcript: String(decision.transcript || caseRow.userText || "").trim(),
      error: String(decision.error || "")
    }
  };
}

function buildExecutionSession({
  mode,
  caseRow
}: {
  mode: VoiceGoldenMode;
  caseRow: VoiceGoldenCase;
}) {
  const now = Date.now();
  const context = resolveCaseContext(caseRow);
  const session = {
    id: `voice-golden-exec-${mode}-${now}-${Math.floor(Math.random() * 1_000_000)}`,
    guildId: "voice-golden-guild",
    textChannelId: "voice-golden-text",
    voiceChannelId: "voice-golden-voice",
    mode,
    ending: false,
    botTurnOpen: false,
    startedAt: now - context.sessionAgeMs,
    lastAudioDeltaAt:
      context.recentAssistantReplyMs != null ? now - context.recentAssistantReplyMs : 0,
    lastDirectAddressAt:
      context.recentDirectAddressMs != null ? now - context.recentDirectAddressMs : 0,
    lastDirectAddressUserId: context.recentDirectAddressUserId || "",
    musicWakeLatchedUntil: 0,
    musicWakeLatchedByUserId: null,
    lastActivityAt: now,
    userCaptures: new Map(),
    recentVoiceTurns: [],
    deferredVoiceActions: {},
    deferredVoiceActionTimers: {},
    soundboard: {
      playCount: 0,
      lastPlayedAt: 0
    },
    streamWatch: {
      active: false
    }
  } as Record<string, unknown>;

  if (mode === "openai_realtime") {
    session.realtimeClient = {
      updateInstructions() {
        return undefined;
      }
    };
  }

  return session;
}

function latestVoiceReplyFromActions({
  actions
}: {
  actions: HarnessStoreAction[];
}) {
  const requested = [...actions]
    .reverse()
    .find((row) => row.kind === "voice_runtime" && row.content === "realtime_reply_requested");
  if (requested) {
    return String(requested.metadata?.replyText || "").trim();
  }
  return "";
}

async function runLiveProductionCase({
  manager,
  store,
  settings,
  mode,
  caseRow,
  directAddressed
}: {
  manager: VoiceSessionManager;
  store: HarnessStore;
  settings: Record<string, unknown>;
  mode: VoiceGoldenMode;
  caseRow: VoiceGoldenCase;
  directAddressed: boolean;
}): Promise<ModeExecutionResult> {
  const stage = {
    connectMs: 0,
    inputPrepMs: 0,
    inputSendMs: 0,
    actorMs: 0,
    asrMs: 0,
    ttsMs: 0,
    outputAsrMs: 0,
    responseMs: 0
  };
  const session = buildExecutionSession({
    mode,
    caseRow
  });
  const actionStart = store.actions.length;
  const responseStartedAt = performance.now();
  const originalSpeakVoiceLineWithTts = manager.speakVoiceLineWithTts.bind(manager);

  manager.speakVoiceLineWithTts = async ({ session: activeSession }) => {
    if (activeSession && typeof activeSession === "object") {
      (activeSession as { lastAudioDeltaAt?: number }).lastAudioDeltaAt = Date.now();
    }
    return true;
  };

  try {
    applyCaseContextToManager({
      manager,
      caseRow
    });
    await manager.runRealtimeBrainReply({
      session,
      settings,
      userId: "speaker-1",
      transcript: caseRow.userText,
      directAddressed,
      source: "voice_golden_production"
    });
  } finally {
    manager.speakVoiceLineWithTts = originalSpeakVoiceLineWithTts;
  }

  stage.responseMs = performance.now() - responseStartedAt;
  stage.actorMs = stage.responseMs;
  const actionDelta = store.actions.slice(actionStart);
  const responseText = latestVoiceReplyFromActions({ actions: actionDelta });

  return {
    transcript: caseRow.userText,
    responseText,
    audioBytes: responseText ? Buffer.byteLength(responseText, "utf8") * 24 : 0,
    stage
  };
}

async function runSimulatedCase({
  mode,
  caseRow,
  decisionAllow,
  iteration
}: {
  mode: VoiceGoldenMode;
  caseRow: VoiceGoldenCase;
  decisionAllow: boolean;
  iteration: number;
}): Promise<ModeExecutionResult> {
  const idSeed = `${mode}:${caseRow.id}:${iteration}`;

  const connectMs = simulatedDelayMs(`${idSeed}:connect`, 18, 10);
  const inputPrepMs = simulatedDelayMs(`${idSeed}:inputPrep`, 32, 25);
  const inputSendMs = simulatedDelayMs(`${idSeed}:inputSend`, 8, 6);
  const asrMs = 0;
  const actorMs = decisionAllow ? simulatedDelayMs(`${idSeed}:actor`, 70, 35) : 0;
  const ttsMs = decisionAllow ? simulatedDelayMs(`${idSeed}:tts`, 48, 18) : 0;
  const responseMs = decisionAllow ? simulatedDelayMs(`${idSeed}:response`, 180, 70) : 0;

  await sleep(connectMs + inputPrepMs + inputSendMs + asrMs + actorMs + ttsMs + responseMs);

  const transcript = caseRow.userText;
  const responseText =
    decisionAllow && resolveExpectedResponse(caseRow) === "non_empty"
      ? `simulated reply (${mode}): ${caseRow.objective.slice(0, 90)}`
      : "";

  return {
    transcript,
    responseText,
    audioBytes: responseText ? Buffer.byteLength(responseText, "utf8") * 24 : 0,
    stage: {
      connectMs,
      inputPrepMs,
      inputSendMs,
      actorMs,
      asrMs,
      ttsMs,
      outputAsrMs: 0,
      responseMs
    }
  };
}

function hasProviderCredentials(provider: string) {
  const normalized = String(provider || "")
    .trim()
    .toLowerCase();
  if (normalized === "openai") return Boolean(appConfig.openaiApiKey);
  if (normalized === "anthropic") return Boolean(appConfig.anthropicApiKey);
  if (normalized === "xai") return Boolean(appConfig.xaiApiKey);
  if (normalized === "claude-oauth") return true;
  return false;
}

function validateHarnessCredentials(options: VoiceGoldenResolvedOptions) {
  const required = [
    ...(options.mode === "live"
      ? [
          { role: "actor", provider: options.actorProvider },
          { role: "decider", provider: options.deciderProvider }
        ]
      : []),
    ...(options.judge.enabled ? [{ role: "judge", provider: options.judge.provider }] : [])
  ];
  const missing = new Set<string>();

  for (const item of required) {
    const provider = String(item.provider || "").trim().toLowerCase();
    if (!provider) continue;
    if (hasProviderCredentials(provider)) continue;
    missing.add(`${item.role}:${provider}`);
  }

  return [...missing];
}

async function runJudge({
  llm,
  judgeSettings,
  mode,
  runMode,
  caseRow,
  decision,
  responseText,
  timings,
  error
}: {
  llm: LLMService;
  judgeSettings: Record<string, unknown>;
  mode: VoiceGoldenMode;
  runMode: VoiceGoldenRunMode;
  caseRow: VoiceGoldenCase;
  decision: DecisionResult;
  responseText: string;
  timings: StageTimings;
  error: string | null;
}): Promise<JudgeResult> {
  const systemPrompt = [
    "You are a strict evaluator for voice chat validation tests.",
    "Return strict JSON only.",
    "Score whether the observed behavior matches expected admission and response quality."
  ].join("\n");

  const userPrompt = [
    `Run mode: ${runMode}`,
    `Voice mode: ${mode}`,
    `Case: ${caseRow.id} (${caseRow.title})`,
    `User utterance: ${caseRow.userText}`,
    `Expectation shouldAllow: ${caseRow.expectedAllow ? "true" : "false"}`,
    `Expectation response: ${resolveExpectedResponse(caseRow)}`,
    `Case objective: ${caseRow.objective}`,
    `Observed decision.allow: ${decision.allow ? "true" : "false"}`,
    `Observed decision.reason: ${decision.reason}`,
    `Observed response text: ${responseText || "(empty)"}`,
    `Observed error: ${error || "(none)"}`,
    `Timings totalMs=${timings.totalMs.toFixed(1)} decisionMs=${timings.decisionMs.toFixed(1)} responseMs=${timings.responseMs.toFixed(1)}`,
    "Scoring rules:",
    "1) A failing admission expectation is a hard fail.",
    "2) If expected response is non_empty, response should be non-empty and reasonably aligned with objective.",
    "3) If expected response is empty, the correct behavior is an empty response or [SKIP]-equivalent silence.",
    'Output schema: {"pass":true|false,"score":0..100,"confidence":0..1,"summary":"...","issues":["..."]}'
  ].join("\n");

  return await runJsonJudge<JudgeResult>({
    llm,
    settings: judgeSettings,
    systemPrompt,
    userPrompt,
    trace: {
      guildId: "voice-golden-guild",
      channelId: "voice-golden-text",
      userId: "judge",
      source: "voice_golden_judge",
      event: "judge_case",
      reason: null,
      messageId: null
    },
    onParsed: (parsed, rawText) => {
      const issues = Array.isArray(parsed.issues)
        ? parsed.issues.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 8)
        : [];

      return {
        pass: Boolean(parsed.pass),
        score: Math.max(0, Math.min(100, Math.floor(stableNumber(parsed.score, 0)))),
        confidence: Math.max(0, Math.min(1, stableNumber(parsed.confidence, 0))),
        summary: String(parsed.summary || "").trim(),
        issues,
        rawText
      };
    },
    onParseError: (rawText) => {
      const deterministicPass =
        decision.allow === caseRow.expectedAllow &&
        (resolveExpectedResponse(caseRow) === "non_empty" ? Boolean(responseText.trim()) : !responseText.trim());
      return {
        pass: deterministicPass,
        score: deterministicPass ? 75 : 25,
        confidence: 0.2,
        summary: "judge_output_parse_failed",
        issues: ["judge returned non-JSON output"],
        rawText
      };
    }
  });
}

function buildDeterministicJudge({
  caseRow,
  decision,
  responseText,
  error
}: {
  caseRow: VoiceGoldenCase;
  decision: DecisionResult;
  responseText: string;
  error: string | null;
}): JudgeResult {
  const admissionMatches = decision.allow === caseRow.expectedAllow;
  const responseMatches =
    resolveExpectedResponse(caseRow) === "non_empty" ? Boolean(responseText.trim()) : !responseText.trim();
  const pass = admissionMatches && responseMatches && !error;
  const issues: string[] = [];
  if (!admissionMatches) issues.push("admission_mismatch");
  if (!responseMatches) issues.push("response_mismatch");
  if (error) issues.push("runtime_error");

  return {
    pass,
    score: pass ? 100 : 20,
    confidence: 1,
    summary: pass ? "deterministic_pass" : "deterministic_fail",
    issues,
    rawText: ""
  };
}

function buildEmptyTimings(decisionMs = 0): StageTimings {
  return {
    totalMs: decisionMs,
    decisionMs,
    connectMs: 0,
    inputPrepMs: 0,
    inputSendMs: 0,
    actorMs: 0,
    asrMs: 0,
    ttsMs: 0,
    outputAsrMs: 0,
    responseMs: 0
  };
}

async function runSingleCase({
  options,
  llm,
  judgeSettings,
  mode,
  settings,
  manager,
  executionStore,
  caseRow,
  iteration
}: {
  options: VoiceGoldenResolvedOptions;
  llm: LLMService | null;
  judgeSettings: Record<string, unknown> | null;
  mode: VoiceGoldenMode;
  settings: Record<string, unknown>;
  manager: VoiceSessionManager;
  executionStore: HarnessStore;
  caseRow: VoiceGoldenCase;
  iteration: number;
}): Promise<VoiceGoldenCaseResult> {
  const startedAt = performance.now();

  let errorText: string | null = null;
  let transcript = "";
  let responseText = "";
  let audioBytes = 0;
  let decisionData: DecisionResult = {
    allow: false,
    reason: "",
    directAddressed: false,
    transcript: "",
    error: ""
  };
  let timings = buildEmptyTimings(0);

  try {
    applyCaseContextToManager({
      manager,
      caseRow
    });
    const decisionResult = await evaluateDecision({
      manager,
      settings,
      mode,
      caseRow
    });
    decisionData = decisionResult.decision;
    timings = buildEmptyTimings(decisionResult.decisionMs);

    if (!decisionData.allow) {
      transcript = decisionData.transcript || caseRow.userText;
    } else if (options.mode === "simulated") {
      const simulated = await runSimulatedCase({
        mode,
        caseRow,
        decisionAllow: true,
        iteration
      });
      transcript = simulated.transcript;
      responseText = simulated.responseText;
      audioBytes = simulated.audioBytes;
      timings = {
        totalMs: 0,
        decisionMs: decisionResult.decisionMs,
        ...simulated.stage
      };
    } else {
      if (!llm) {
        throw new Error("Live mode requires an initialized LLM service.");
      }
      const liveResult = await runLiveProductionCase({
        manager,
        store: executionStore,
        settings,
        mode,
        caseRow,
        directAddressed: Boolean(decisionData.directAddressed)
      });

      transcript = liveResult.transcript || decisionData.transcript || caseRow.userText;
      responseText = liveResult.responseText;
      audioBytes = liveResult.audioBytes;
      timings = {
        totalMs: 0,
        decisionMs: decisionResult.decisionMs,
        ...liveResult.stage
      };
    }
  } catch (error) {
    errorText = String((error as Error)?.message || error || "unknown_error");
  }

  timings.totalMs = Math.max(0, performance.now() - startedAt);

  let judge: JudgeResult;
  if (options.judge.enabled && llm && judgeSettings) {
    try {
      judge = await runJudge({
        llm,
        judgeSettings,
        mode,
        runMode: options.mode,
        caseRow,
        decision: decisionData,
        responseText,
        timings,
        error: errorText
      });
    } catch (error) {
      judge = {
        pass: false,
        score: 0,
        confidence: 0,
        summary: "judge_error",
        issues: [String((error as Error)?.message || error || "unknown judge error")],
        rawText: ""
      };
    }
  } else {
    judge = buildDeterministicJudge({
      caseRow,
      decision: decisionData,
      responseText,
      error: errorText
    });
  }

  return {
    mode,
    caseId: caseRow.id,
    caseTitle: caseRow.title,
    iteration,
    expectedAllow: caseRow.expectedAllow,
    decision: decisionData,
    transcript,
    responseText,
    audioBytes,
    timings,
    pass: Boolean(judge.pass) && !errorText,
    judge,
    error: errorText
  };
}

function aggregateModeReport(mode: VoiceGoldenMode, skippedReason: string | null, results: VoiceGoldenCaseResult[]): VoiceGoldenModeReport {
  const executed = results.length;
  const passed = results.filter((row) => row.pass).length;
  const failed = executed - passed;

  return {
    mode,
    skippedReason,
    results,
    aggregates: {
      executed,
      passed,
      failed,
      passRate: stablePassRate(passed, executed),
      stageStats: buildStageStats(results)
    }
  };
}

export async function runVoiceGoldenHarness(inputOptions: VoiceGoldenHarnessOptions = {}): Promise<VoiceGoldenHarnessReport> {
  const options = resolveDefaults(inputOptions);
  const startedAtIso = new Date().toISOString();
  const onCaseProgress =
    typeof inputOptions.onCaseProgress === "function" ? inputOptions.onCaseProgress : null;

  const judgeSettings = options.judge.enabled ? buildJudgeSettings(options.judge) : null;
  const missing = validateHarnessCredentials(options);
  if (missing.length) {
    if (!options.allowMissingCredentials) {
      throw new Error(`Missing credentials: ${missing.join(", ")}`);
    }
    const modeReports = options.modes.map((mode) =>
      aggregateModeReport(mode, `missing_credentials:${missing.join(",")}`, [])
    );
    return {
      startedAt: startedAtIso,
      finishedAt: new Date().toISOString(),
      options,
      modeReports,
      summary: {
        executed: 0,
        passed: 0,
        failed: 0,
        passRate: 0,
        stageStats: {}
      }
    };
  }
  const cases = VOICE_GOLDEN_CASES.slice(0, options.maxCases);
  const modeReports: VoiceGoldenModeReport[] = [];
  const totalCaseCount = Math.max(0, options.modes.length * options.iterations * cases.length);
  let globalCaseIndex = 0;

  for (const mode of options.modes) {
    const settings = buildHarnessSettings({
      voiceMode: mode,
      actorProvider: options.actorProvider,
      actorModel: options.actorModel,
      deciderProvider: options.deciderProvider,
      deciderModel: options.deciderModel
    });

    let manager: VoiceSessionManager;
    let executionStore: HarnessStore;
    let llm: LLMService | null = null;

    if (options.mode === "live") {
      executionStore = new HarnessStore();
      llm = new LLMService({
        appConfig,
        store: executionStore
      });
      const search = new WebSearchService({
        appConfig,
        store: executionStore
      });
      const runtime = createLiveExecutionRuntime({
        llm,
        search,
        store: executionStore
      });
      manager = runtime.manager;
    } else {
      const runtime = createDecisionRuntime(buildSimulatedDecisionLlm());
      manager = runtime.manager;
      executionStore = runtime.store;
      if (options.judge.enabled) {
        llm = new LLMService({
          appConfig,
          store: new HarnessStore()
        });
      }
    }

    const results: VoiceGoldenCaseResult[] = [];
    const modeCaseCount = Math.max(0, options.iterations * cases.length);
    let modeCaseIndex = 0;
    for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
      for (const caseRow of cases) {
        modeCaseIndex += 1;
        globalCaseIndex += 1;
        onCaseProgress?.({
          phase: "start",
          mode,
          iteration,
          modeCaseIndex,
          modeCaseCount,
          globalCaseIndex,
          globalCaseCount: totalCaseCount,
          caseId: caseRow.id,
          caseTitle: caseRow.title,
          expectedAllow: Boolean(caseRow.expectedAllow)
        });
        const row = await runSingleCase({
          options,
          llm,
          judgeSettings,
          mode,
          settings,
          manager,
          executionStore,
          caseRow,
          iteration
        });
        results.push(row);
        onCaseProgress?.({
          phase: "done",
          mode,
          iteration,
          modeCaseIndex,
          modeCaseCount,
          globalCaseIndex,
          globalCaseCount: totalCaseCount,
          caseId: caseRow.id,
          caseTitle: caseRow.title,
          expectedAllow: Boolean(caseRow.expectedAllow),
          pass: Boolean(row.pass),
          decisionAllow: Boolean(row.decision.allow),
          decisionReason: String(row.decision.reason || ""),
          error: row.error,
          durationMs: Number(row.timings.totalMs || 0)
        });
      }
    }

    modeReports.push(aggregateModeReport(mode, null, results));
    try {
      await manager.dispose("voice_golden_harness_done");
    } catch (error) {
      console.warn(
        `[voice-golden-harness] manager.dispose failed for mode=${mode}: ${String((error as Error)?.message || error)}`
      );
    }
  }

  const allResults = modeReports.flatMap((report) => report.results);
  const passed = allResults.filter((row) => row.pass).length;
  const executed = allResults.length;
  const failed = executed - passed;

  return {
    startedAt: startedAtIso,
    finishedAt: new Date().toISOString(),
    options,
    modeReports,
    summary: {
      executed,
      passed,
      failed,
      passRate: stablePassRate(passed, executed),
      stageStats: buildStageStats(allResults)
    }
  };
}

export function printVoiceGoldenHarnessReport(report: VoiceGoldenHarnessReport) {
  console.log("Voice Golden Validation Harness");
  console.log(`startedAt=${report.startedAt}`);
  console.log(`finishedAt=${report.finishedAt}`);
  console.log(`mode=${report.options.mode}`);
  console.log(`modes=[${report.options.modes.join(", ")}]`);
  console.log(`iterations=${report.options.iterations}`);
  console.log(`judge=${report.options.judge.enabled ? "on" : "off"}`);
  console.log("");

  for (const modeReport of report.modeReports) {
    if (modeReport.skippedReason) {
      console.log(`mode=${modeReport.mode} skipped (${modeReport.skippedReason})`);
      continue;
    }

    console.log(
      `mode=${modeReport.mode} executed=${modeReport.aggregates.executed} pass=${modeReport.aggregates.passed} fail=${modeReport.aggregates.failed} passRate=${modeReport.aggregates.passRate.toFixed(1)}%`
    );
    const totalMs = modeReport.aggregates.stageStats.totalMs;
    const decisionMs = modeReport.aggregates.stageStats.decisionMs;
    const responseMs = modeReport.aggregates.stageStats.responseMs;
    if (totalMs) {
      console.log(
        `  totalMs p50=${totalMs.p50Ms.toFixed(1)} p95=${totalMs.p95Ms.toFixed(1)} avg=${totalMs.avgMs.toFixed(1)}`
      );
    }
    if (decisionMs) {
      console.log(
        `  decisionMs p50=${decisionMs.p50Ms.toFixed(1)} p95=${decisionMs.p95Ms.toFixed(1)} avg=${decisionMs.avgMs.toFixed(1)}`
      );
    }
    if (responseMs) {
      console.log(
        `  responseMs p50=${responseMs.p50Ms.toFixed(1)} p95=${responseMs.p95Ms.toFixed(1)} avg=${responseMs.avgMs.toFixed(1)}`
      );
    }

    const failedRows = modeReport.results.filter((row) => !row.pass).slice(0, 6);
    for (const row of failedRows) {
      console.log(
        `  fail case=${row.caseId} iter=${row.iteration} reason=${row.decision.reason || row.error || row.judge.summary}`
      );
      if (row.judge.issues.length) {
        console.log(`    issues=${row.judge.issues.join(" | ")}`);
      }
    }
  }

  console.log("");
  console.log(
    `summary executed=${report.summary.executed} pass=${report.summary.passed} fail=${report.summary.failed} passRate=${report.summary.passRate.toFixed(1)}%`
  );
}
