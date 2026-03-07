import {
  executeSharedAdaptiveDirectiveAdd,
  executeSharedAdaptiveDirectiveRemove
} from "../adaptiveDirectives/adaptiveDirectiveToolRuntime.ts";
import type { VoiceSession, VoiceToolRuntimeSessionLike } from "./voiceSessionTypes.ts";
import type { VoiceToolCallArgs, VoiceToolCallManager } from "./voiceToolCallTypes.ts";

type ToolRuntimeSession = VoiceSession | VoiceToolRuntimeSessionLike;

type VoiceDirectiveToolOptions = {
  session?: ToolRuntimeSession | null;
  args?: VoiceToolCallArgs;
};

export async function executeVoiceAdaptiveStyleAddTool(
  manager: VoiceToolCallManager,
  { session, args }: VoiceDirectiveToolOptions
) {
  if (
    !manager.store ||
    typeof manager.store.getActiveAdaptiveStyleNotes !== "function" ||
    typeof manager.store.addAdaptiveStyleNote !== "function" ||
    typeof manager.resolveVoiceSpeakerName !== "function"
  ) {
    return { ok: false, error: "adaptive_directive_unavailable" };
  }

  return executeSharedAdaptiveDirectiveAdd({
    runtime: { store: manager.store },
    guildId: String(session?.guildId || "").trim(),
    actorUserId: session?.lastOpenAiToolCallerUserId || null,
    actorName: manager.resolveVoiceSpeakerName(session, session?.lastOpenAiToolCallerUserId || null),
    sourceMessageId: `voice-tool-${String(session?.id || "session")}`,
    sourceText: "",
    noteText: args?.note,
    directiveKind: typeof args?.kind === "string" ? args.kind : undefined,
    source: "voice_tool"
  });
}

export async function executeVoiceAdaptiveStyleRemoveTool(
  manager: VoiceToolCallManager,
  { session, args }: VoiceDirectiveToolOptions
) {
  if (
    !manager.store ||
    typeof manager.store.getActiveAdaptiveStyleNotes !== "function" ||
    typeof manager.store.removeAdaptiveStyleNote !== "function" ||
    typeof manager.resolveVoiceSpeakerName !== "function"
  ) {
    return { ok: false, error: "adaptive_directive_unavailable" };
  }

  return executeSharedAdaptiveDirectiveRemove({
    runtime: { store: manager.store },
    guildId: String(session?.guildId || "").trim(),
    actorUserId: session?.lastOpenAiToolCallerUserId || null,
    actorName: manager.resolveVoiceSpeakerName(session, session?.lastOpenAiToolCallerUserId || null),
    sourceMessageId: `voice-tool-${String(session?.id || "session")}`,
    sourceText: "",
    noteRef: args?.note_ref,
    target: args?.target,
    removalReason: args?.reason,
    source: "voice_tool"
  });
}
