export const SYSTEM_SPEECH_OPPORTUNITY = {
  THOUGHT: "thought",
  STREAM_WATCH: "stream_watch"
} as const;

type SystemSpeechOpportunityType =
  typeof SYSTEM_SPEECH_OPPORTUNITY[keyof typeof SYSTEM_SPEECH_OPPORTUNITY];

export const SYSTEM_SPEECH_SOURCE = {
  THOUGHT: "voice_thought_engine",
  THOUGHT_TTS: "voice_thought_engine_tts",
  STREAM_WATCH: "stream_watch_brain_turn"
} as const;

type SystemSpeechReplyAccounting = "none" | "requested" | "spoken";
export const SYSTEM_SPEECH_CLASS = {
  SYSTEM_OPTIONAL: "system_optional",
  REPLY_NORMAL: "reply_normal",
  OPERATIONAL_REQUIRED: "operational_required",
  OPERATIONAL_CRITICAL: "operational_critical"
} as const;

type SystemSpeechClass =
  typeof SYSTEM_SPEECH_CLASS[keyof typeof SYSTEM_SPEECH_CLASS];

type SystemSpeechOpportunityDefinition = {
  type: SystemSpeechOpportunityType;
  sourcePrefixes: readonly string[];
  speechClass: SystemSpeechClass;
  allowSkipAfterFire: boolean;
  replyAccountingOnRequest: SystemSpeechReplyAccounting;
  replyAccountingOnLocalPlayback: SystemSpeechReplyAccounting;
};

const SYSTEM_SPEECH_OPPORTUNITY_DEFINITIONS: readonly SystemSpeechOpportunityDefinition[] = [
  {
    type: SYSTEM_SPEECH_OPPORTUNITY.THOUGHT,
    sourcePrefixes: [SYSTEM_SPEECH_SOURCE.THOUGHT, SYSTEM_SPEECH_SOURCE.THOUGHT_TTS],
    speechClass: SYSTEM_SPEECH_CLASS.SYSTEM_OPTIONAL,
    allowSkipAfterFire: true,
    replyAccountingOnRequest: "requested",
    replyAccountingOnLocalPlayback: "spoken"
  },
  {
    type: SYSTEM_SPEECH_OPPORTUNITY.STREAM_WATCH,
    sourcePrefixes: [SYSTEM_SPEECH_SOURCE.STREAM_WATCH],
    speechClass: SYSTEM_SPEECH_CLASS.SYSTEM_OPTIONAL,
    allowSkipAfterFire: true,
    replyAccountingOnRequest: "requested",
    replyAccountingOnLocalPlayback: "spoken"
  }
] as const;

function normalizeSource(source: string | null | undefined): string {
  return String(source || "").trim().toLowerCase();
}

function resolveSystemSpeechOpportunityDefinition(
  source: string | null | undefined
): SystemSpeechOpportunityDefinition | null {
  const normalizedSource = normalizeSource(source);
  if (!normalizedSource) return null;

  for (const definition of SYSTEM_SPEECH_OPPORTUNITY_DEFINITIONS) {
    if (definition.sourcePrefixes.some((prefix) => normalizedSource.startsWith(prefix))) {
      return definition;
    }
  }
  return null;
}

export function isSystemSpeechOpportunitySource(
  source: string | null | undefined
): boolean {
  return resolveSystemSpeechOpportunityDefinition(source) !== null;
}

export function resolveSystemSpeechClass(
  source: string | null | undefined
): SystemSpeechClass | null {
  return resolveSystemSpeechOpportunityDefinition(source)?.speechClass || null;
}

export function shouldAllowSystemSpeechSkipAfterFire(
  source: string | null | undefined
): boolean {
  const definition = resolveSystemSpeechOpportunityDefinition(source);
  if (!definition) return true;
  return Boolean(definition.allowSkipAfterFire);
}

export function resolveSystemSpeechReplyAccountingOnRequest(
  source: string | null | undefined
): SystemSpeechReplyAccounting | null {
  return resolveSystemSpeechOpportunityDefinition(source)?.replyAccountingOnRequest || null;
}

export function resolveSystemSpeechReplyAccountingOnLocalPlayback(
  source: string | null | undefined
): SystemSpeechReplyAccounting | null {
  return resolveSystemSpeechOpportunityDefinition(source)?.replyAccountingOnLocalPlayback || null;
}
