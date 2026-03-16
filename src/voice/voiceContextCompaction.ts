import { applyOrchestratorOverrideSettings, getResolvedOrchestratorBinding } from "../settings/agentStack.ts";
import { normalizeVoiceText } from "./voiceSessionHelpers.ts";
import {
  CONTEXT_COMPACTION_BATCH_SIZE,
  CONTEXT_COMPACTION_MAX_NOTE_CHARS,
  CONTEXT_COMPACTION_MAX_OUTPUT_TOKENS,
  CONTEXT_COMPACTION_MAX_SUMMARY_CHARS,
  CONTEXT_COMPACTION_RECENT_WINDOW
} from "./voiceSessionManager.constants.ts";
import type { VoiceSession, VoiceTranscriptTimelineEntry } from "./voiceSessionTypes.ts";

type VoiceContextCompactionHost = {
  llm?: {
    generate?: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  } | null;
  store: {
    logAction: (payload: Record<string, unknown>) => void;
  };
  client: {
    user?: {
      id?: string;
    } | null;
  };
};

function getTranscriptTurns(session: VoiceSession): VoiceTranscriptTimelineEntry[] {
  return Array.isArray(session.transcriptTurns)
    ? session.transcriptTurns.filter((row): row is VoiceTranscriptTimelineEntry => Boolean(row && typeof row === "object"))
    : [];
}

function trimToSentenceBoundary(text: string, maxChars: number) {
  const normalized = normalizeVoiceText(text, Math.max(80, maxChars * 2));
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;
  const sliced = normalized.slice(0, maxChars);
  const lastBoundary = Math.max(
    sliced.lastIndexOf(". "),
    sliced.lastIndexOf("! "),
    sliced.lastIndexOf("? ")
  );
  if (lastBoundary >= Math.floor(maxChars * 0.6)) {
    return sliced.slice(0, lastBoundary + 1).trim();
  }
  return sliced.trim();
}

function formatTranscriptTurnForCompaction(turn: VoiceTranscriptTimelineEntry) {
  const speaker = String(turn?.speakerName || (turn?.role === "assistant" ? "Clanky" : "someone")).trim() || "someone";
  const text = normalizeVoiceText(turn?.text || "", 260);
  if (!text) return "";
  if (turn.kind === "membership") {
    return `${speaker} ${turn.eventType === "leave" ? "left" : "joined"} the voice channel.`;
  }
  if (turn.kind === "effect") {
    const summary = normalizeVoiceText(turn.summary || text, 260);
    return summary ? `${speaker}: [voice effect] ${summary}` : "";
  }
  if (turn.kind === "thought") {
    return `Clanky thought: ${text}`;
  }
  return `${speaker}: ${text}`;
}

function buildCompactionPrompt({
  previousSummary,
  turns,
  notes
}: {
  previousSummary: string | null;
  turns: VoiceTranscriptTimelineEntry[];
  notes: string[];
}) {
  const turnLines = turns
    .map((turn) => formatTranscriptTurnForCompaction(turn))
    .filter(Boolean)
    .map((line) => `- ${line}`)
    .join("\n");
  const noteBlock = notes.length
    ? notes
      .map((note) => normalizeVoiceText(note, CONTEXT_COMPACTION_MAX_NOTE_CHARS))
      .filter(Boolean)
      .map((note) => `- ${note}`)
      .join("\n")
    : "- none";

  return [
    "Summarize the following voice conversation context into a concise running summary for an autonomous Discord participant re-entering the ongoing session.",
    "",
    "Preserve, in priority order:",
    "1. Who said what, with speaker names when material",
    "2. The current shared activity or scene (game, task, topic, stream context)",
    "3. Open questions, requests, and unresolved threads the bot may want to pick back up",
    "4. Decisions, commitments, plans, and preferences that still matter in-session",
    "5. Important screen-watch context tied to the people involved",
    "",
    "Do not preserve filler chatter, greetings, laughter, backchannels, repeated rephrasings, or small talk that does not change the conversational state.",
    "",
    "Previous summary (incorporate and condense):",
    previousSummary || "None - first compaction.",
    "",
    "New turns to fold in:",
    turnLines || "- none",
    "",
    "Screen-watch notes from this period (if any):",
    noteBlock,
    "",
    "Output:",
    "- A single compact paragraph in plain prose",
    `- Max ${CONTEXT_COMPACTION_MAX_SUMMARY_CHARS} characters`,
    "- Keep the newest still-relevant details if forced to compress",
    "- Do not invent facts or motivations"
  ].join("\n");
}

export function getCompactedSessionSummaryContext(session: VoiceSession) {
  const text = normalizeVoiceText(session?.compactedContextSummary || "", CONTEXT_COMPACTION_MAX_SUMMARY_CHARS);
  if (!text) return null;
  return {
    text,
    coveredThroughTurn: session?.compactedContextCoveredThroughTurn != null && Number.isFinite(Number(session.compactedContextCoveredThroughTurn))
      ? Math.max(0, Math.round(Number(session.compactedContextCoveredThroughTurn)))
      : null,
    updatedAt: session?.compactedContextLastAt != null && Number.isFinite(Number(session.compactedContextLastAt))
      ? Math.max(0, Math.round(Number(session.compactedContextLastAt)))
      : null
  };
}

export function getCompactionCursor(session: VoiceSession) {
  const summary = getCompactedSessionSummaryContext(session);
  const turns = getTranscriptTurns(session);
  const rawCursor = Number(session?.compactedContextCursor);
  const normalizedCursor = Number.isFinite(rawCursor) ? Math.max(0, Math.min(turns.length, Math.round(rawCursor))) : 0;
  if (!summary?.text || normalizedCursor <= 0) {
    return 0;
  }
  return normalizedCursor;
}

export async function maybeStartVoiceContextCompaction(
  host: VoiceContextCompactionHost,
  {
    session,
    settings,
    source = "generation"
  }: {
    session: VoiceSession;
    settings: unknown;
    source?: string;
  }
) {
  if (!session || session.ending) return;
  const turns = getTranscriptTurns(session);
  const cursor = getCompactionCursor(session);
  const totalTurns = turns.length;
  const recentStart = Math.max(cursor, totalTurns - CONTEXT_COMPACTION_RECENT_WINDOW);
  const eligibleCount = Math.max(0, recentStart - cursor);

  if (session.compactedContextInFlight) {
    host.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: host.client.user?.id || null,
      content: "voice_context_compaction_skipped",
      metadata: {
        sessionId: session.id,
        source,
        reason: "already_in_flight",
        cursor,
        totalTurns,
        eligibleCount,
        pendingNoteCount: Array.isArray(session.pendingCompactionNotes) ? session.pendingCompactionNotes.length : 0
      }
    });
    return;
  }

  if (!host.llm?.generate) {
    host.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: host.client.user?.id || null,
      content: "voice_context_compaction_skipped",
      metadata: {
        sessionId: session.id,
        source,
        reason: "llm_unavailable",
        cursor,
        totalTurns,
        eligibleCount
      }
    });
    return;
  }

  if (eligibleCount < CONTEXT_COMPACTION_BATCH_SIZE) {
    host.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: host.client.user?.id || null,
      content: "voice_context_compaction_skipped",
      metadata: {
        sessionId: session.id,
        source,
        reason: "below_threshold",
        cursor,
        totalTurns,
        eligibleCount,
        threshold: CONTEXT_COMPACTION_BATCH_SIZE
      }
    });
    return;
  }

  const batchEnd = cursor + CONTEXT_COMPACTION_BATCH_SIZE;
  const turnsToCompact = turns.slice(cursor, batchEnd);
  if (!turnsToCompact.length) {
    host.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: host.client.user?.id || null,
      content: "voice_context_compaction_skipped",
      metadata: {
        sessionId: session.id,
        source,
        reason: "no_eligible_batch",
        cursor,
        totalTurns,
        eligibleCount
      }
    });
    return;
  }

  const pendingNotes = Array.isArray(session.pendingCompactionNotes)
    ? session.pendingCompactionNotes.map((note) => normalizeVoiceText(note, CONTEXT_COMPACTION_MAX_NOTE_CHARS)).filter(Boolean)
    : [];
  const previousSummary = getCompactedSessionSummaryContext(session)?.text || null;
  const generationSettings = (() => {
    const binding = getResolvedOrchestratorBinding(settings);
    return applyOrchestratorOverrideSettings(settings, {
      provider: binding.provider,
      model: binding.model,
      temperature: 0.2,
      maxOutputTokens: CONTEXT_COMPACTION_MAX_OUTPUT_TOKENS,
      reasoningEffort: "minimal"
    });
  })();
  const userPrompt = buildCompactionPrompt({
    previousSummary,
    turns: turnsToCompact,
    notes: pendingNotes
  });

  session.compactedContextInFlight = true;
  const startedAt = Date.now();
  host.store.logAction({
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: host.client.user?.id || null,
    content: "voice_context_compaction_started",
    metadata: {
      sessionId: session.id,
      source,
      cursor,
      batchSize: turnsToCompact.length,
      recentStart,
      pendingNoteCount: pendingNotes.length
    }
  });

  try {
    const result = await host.llm.generate({
      settings: generationSettings,
      systemPrompt: "You maintain a compact running continuity summary for an ongoing live voice session.",
      userPrompt,
      contextMessages: [],
      trace: {
        guildId: session.guildId,
        channelId: session.textChannelId,
        userId: host.client.user?.id || null,
        source: "voice_context_compaction"
      }
    });
    const summaryText = trimToSentenceBoundary(String(result?.text || ""), CONTEXT_COMPACTION_MAX_SUMMARY_CHARS);
    if (!summaryText) {
      throw new Error("empty_compaction_summary");
    }
    session.compactedContextSummary = summaryText;
    session.compactedContextCursor = batchEnd;
    session.compactedContextCoveredThroughTurn = batchEnd - 1;
    session.compactedContextLastAt = Date.now();
    session.pendingCompactionNotes = [];
    host.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: host.client.user?.id || null,
      content: "voice_context_compaction_completed",
      metadata: {
        sessionId: session.id,
        source,
        oldCursor: cursor,
        newCursor: batchEnd,
        coveredThroughTurn: batchEnd - 1,
        summaryChars: summaryText.length,
        latencyMs: Math.max(0, Date.now() - startedAt)
      }
    });
  } catch (error) {
    host.store.logAction({
      kind: "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: host.client.user?.id || null,
      content: "voice_context_compaction_failed",
      metadata: {
        sessionId: session.id,
        source,
        cursor,
        batchSize: turnsToCompact.length,
        pendingNoteCount: pendingNotes.length,
        error: String((error as Error)?.message || error),
        latencyMs: Math.max(0, Date.now() - startedAt)
      }
    });
  } finally {
    session.compactedContextInFlight = false;
  }
}
