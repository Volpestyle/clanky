import fs from "node:fs/promises";
import path from "node:path";
import { clamp01, clampInt } from "../normalization/numbers.ts";
import { sleep } from "../normalization/time.ts";
import { getMemorySettings } from "../settings/agentStack.ts";
import {
  LORE_SUBJECT,
  SELF_SUBJECT,
  buildFactEmbeddingPayload,
  buildHighlightsSection,
  cleanDailyEntryContent,
  computeChannelScopeScore,
  computeLexicalFactScore,
  computeRecencyScore,
  computeTemporalDecayMultiplier,
  extractStableTokens,
  formatDateLocal,
  formatTypedFactForMemory,
  isBehavioralDirectiveLikeFactText,
  isUnsafeMemoryFactText,
  isInstructionLikeFactText,
  normalizeEvidenceText,
  normalizeFactType,
  normalizeHighlightText,
  normalizeLoreFactForDisplay,
  normalizeMemoryLineInput,
  normalizeQueryEmbeddingText,
  normalizeStoredFactText,
  normalizeSelfFactForDisplay,
  parseDailyEntryLineWithScope,
  passesHybridRelevanceGate,
  rerankWithMmr,
  resolveDirectiveScopeConfig,
  sanitizeInline,
} from "./memoryHelpers.ts";
import { runDailyReflection } from "./dailyReflection.ts";
import { runMicroReflection } from "./microReflection.ts";
import type { MemoryFactRow } from "../store/storeMemory.ts";

const DAILY_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.md$/;
const HYBRID_FACT_LIMIT = 10;
const HYBRID_CANDIDATE_MULTIPLIER = 6;
const HYBRID_MAX_CANDIDATES = 90;
const HYBRID_MAX_VECTOR_BACKFILL_PER_QUERY = 8;
const QUERY_EMBEDDING_CACHE_TTL_MS = 60 * 1000;
const QUERY_EMBEDDING_CACHE_MAX_ENTRIES = 256;
const TEXT_MICRO_REFLECTION_SILENCE_MS = 10 * 60 * 1000;
const TEXT_MICRO_REFLECTION_LOOKBACK_MS = 30 * 60 * 1000;
const TEXT_MICRO_REFLECTION_CONTEXT_PRESSURE_MARGIN = 4;
const TEXT_MICRO_REFLECTION_CONTEXT_PRESSURE_COOLDOWN_MS = 2 * 60 * 1000;
const GUIDANCE_FACT_TYPE = "guidance";
const BEHAVIORAL_FACT_TYPE = "behavioral";
const FULL_MEMORY_DUMP_LIMIT = 200;
const HYBRID_RECENT_CANDIDATE_LIMIT = 24;
const HYBRID_MMR_LAMBDA = 0.7;
const HYBRID_TEMPORAL_DECAY_HALF_LIFE_DAYS = 90;
const HYBRID_TEMPORAL_DECAY_MIN_MULTIPLIER = 0.2;
const MAX_USER_PROFILE_FACTS = 20;
const MAX_USER_GUIDANCE_FACTS = 8;
const MAX_GUILD_SELF_FACTS = 10;
const MAX_GUILD_LORE_FACTS = 10;
const MAX_GUILD_GUIDANCE_FACTS = 12;
const MAX_PROFILE_GUIDANCE_FACTS = 24;
const MAX_PRIMARY_PARTICIPANT_FACTS = 12;
const MAX_SECONDARY_PARTICIPANT_FACTS = 6;
const MAX_SECONDARY_RELEVANT_FACTS = 3;
const MAX_CONVERSATION_QUERY_CHARS = 320;
const MAX_BEHAVIORAL_QUERY_CHARS = 420;
const MAX_SECTION_FACTS = 6;
const MAX_PEOPLE_FACTS_PER_SUBJECT = 6;
const MAX_DIRECTIVE_EVIDENCE_CHARS = 220;

function sortProfileFacts<T extends MemoryFactRow>(rows: T[]) {
  return [...(Array.isArray(rows) ? rows : [])].sort((left, right) => {
    const confidenceDelta = Number(right?.confidence || 0) - Number(left?.confidence || 0);
    if (Math.abs(confidenceDelta) > 1e-6) return confidenceDelta;
    const updatedDelta =
      Date.parse(String(right?.updated_at || "")) - Date.parse(String(left?.updated_at || ""));
    if (updatedDelta !== 0) return updatedDelta;
    return Number(right?.id || 0) - Number(left?.id || 0);
  });
}

function buildPromptSubjectLabel(subject: string, subjectLabels: Record<string, string> = {}) {
  const normalizedSubject = String(subject || "").trim();
  if (!normalizedSubject) return "unknown";
  if (subjectLabels[normalizedSubject]) return String(subjectLabels[normalizedSubject]).trim() || normalizedSubject;
  if (normalizedSubject === SELF_SUBJECT) return "Bot";
  if (normalizedSubject === LORE_SUBJECT) return "Shared lore";
  return normalizedSubject;
}

function decoratePromptFactRows(rows: MemoryFactRow[], subjectLabels: Record<string, string> = {}) {
  return sortProfileFacts(rows).map((row) => ({
    ...row,
    subjectLabel: buildPromptSubjectLabel(String(row?.subject || ""), subjectLabels)
  }));
}

function dedupePromptFactRows(rows: Array<MemoryFactRow & { subjectLabel?: string }>) {
  const seen = new Set<string>();
  const deduped: Array<MemoryFactRow & { subjectLabel?: string }> = [];
  for (const row of rows) {
    const key = [
      String(row?.id || ""),
      String(row?.subject || ""),
      String(row?.fact_type || ""),
      String(row?.fact || "")
    ].join("::");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

function mergeUniqueFactCandidates(...groups: Array<Array<MemoryFactRow> | null | undefined>) {
  const merged = new Map<number, MemoryFactRow>();
  for (const group of groups) {
    for (const row of Array.isArray(group) ? group : []) {
      const rowId = Number(row?.id);
      if (!Number.isInteger(rowId) || rowId <= 0 || merged.has(rowId)) continue;
      merged.set(rowId, row);
    }
  }
  return [...merged.values()];
}

export class MemoryManager {
  store;
  llm;
  memoryFilePath;
  memoryDirPath;
  pendingWrite;
  initializedDailyFiles;
  ingestQueue;
  ingestQueuedJobs;
  ingestWorkerActive;
  maxIngestQueue;
  queryEmbeddingCache;
  queryEmbeddingInFlight;
  dailyLogMessageIds;
  textMicroReflectionTimers;
  textMicroReflectionState;
  microReflectionInFlight;

  constructor({ store, llm, memoryFilePath }) {
    this.store = store;
    this.llm = llm;
    this.memoryFilePath = memoryFilePath;
    this.memoryDirPath = path.dirname(memoryFilePath);
    this.pendingWrite = false;
    this.initializedDailyFiles = new Set();
    this.ingestQueue = [];
    this.ingestQueuedJobs = new Map();
    this.ingestWorkerActive = false;
    this.maxIngestQueue = 400;
    this.queryEmbeddingCache = new Map();
    this.queryEmbeddingInFlight = new Map();
    this.dailyLogMessageIds = new Map();
    this.textMicroReflectionTimers = new Map();
    this.textMicroReflectionState = new Map();
    this.microReflectionInFlight = new Set();
  }

  async ingestMessage({
    messageId,
    authorId,
    authorName,
    content,
    isBot = false,
    settings,
    trace = { guildId: null, channelId: null, userId: null, source: null }
  }) {
    const normalizedMessageId = String(messageId || "").trim();
    if (!normalizedMessageId) return false;

    const existingJob = this.ingestQueuedJobs.get(normalizedMessageId);
    if (existingJob?.promise) {
      return existingJob.promise;
    }

    this.recordVoiceTranscriptMessage({
      messageId: normalizedMessageId,
      authorId,
      authorName,
      content,
      isBot,
      trace
    });

    if (this.ingestQueue.length >= this.maxIngestQueue) {
      const dropped = this.ingestQueue.shift();
      if (dropped?.messageId) {
        this.ingestQueuedJobs.delete(dropped.messageId);
      }
      if (typeof dropped?.resolve === "function") {
        dropped.resolve(false);
      }
      this.logMemoryError("ingest_queue_overflow", "ingest queue full; dropping oldest message", {
        droppedMessageId: dropped?.messageId || null
      });
    }

    let resolveJob = (_value = false) => undefined;
    const promise = new Promise<boolean>((resolve) => {
      resolveJob = resolve;
    });

    const job = {
      messageId: normalizedMessageId,
      authorId: String(authorId || "").trim(),
      authorName: String(authorName || "unknown"),
      content,
      isBot: Boolean(isBot),
      settings,
      trace,
      resolve: resolveJob,
      promise
    };
    this.ingestQueue.push(job);
    this.ingestQueuedJobs.set(normalizedMessageId, job);
    void this.runIngestWorker();
    return promise;
  }

  recordVoiceTranscriptMessage({
    messageId,
    authorId,
    authorName,
    content,
    isBot = false,
    trace = { guildId: null, channelId: null, userId: null, source: null }
  }) {
    if (!String(messageId || "").startsWith("voice-")) return;
    if (typeof this.store?.recordMessage !== "function") return;

    const cleanedContent = cleanDailyEntryContent(content);
    const normalizedChannelId = String(trace?.channelId || "").trim();
    const normalizedAuthorId = String(authorId || trace?.userId || "").trim();
    if (!cleanedContent || !normalizedChannelId || !normalizedAuthorId) return;

    try {
      this.store.recordMessage({
        messageId: String(messageId),
        guildId: String(trace?.guildId || "").trim() || null,
        channelId: normalizedChannelId,
        authorId: normalizedAuthorId,
        authorName: String(authorName || "unknown")
          .replace(/\s+/g, " ")
          .trim() || "unknown",
        isBot: Boolean(isBot),
        content: cleanedContent
      });
    } catch (error) {
      this.logMemoryError("voice_history_record", error, {
        messageId: String(messageId || ""),
        userId: normalizedAuthorId,
        channelId: normalizedChannelId
      });
    }
  }

  async runIngestWorker() {
    if (this.ingestWorkerActive) return;
    this.ingestWorkerActive = true;

    try {
      while (this.ingestQueue.length) {
        const job = this.ingestQueue.shift();
        if (!job) continue;
        this.ingestQueuedJobs.delete(job.messageId);
        try {
          await this.processIngestMessage(job);
          if (typeof job.resolve === "function") job.resolve(true);
        } catch (error) {
          this.logMemoryError("ingest_worker", error, {
            messageId: job.messageId,
            userId: job.authorId
          });
          if (typeof job.resolve === "function") job.resolve(false);
        }
      }
    } finally {
      this.ingestWorkerActive = false;
    }
  }

  async processIngestMessage({
    messageId,
    authorId,
    authorName,
    content,
    isBot = false,
    settings = null,
    trace = { guildId: null, channelId: null, userId: null, source: null }
  }) {
    const cleanedContent = cleanDailyEntryContent(content);
    if (!cleanedContent) return;
    const scopeGuildId = String(trace?.guildId || "").trim();
    const scopeChannelId = String(trace?.channelId || "").trim();

    const source = String(trace?.source || "").trim();
    const isVoice = source.startsWith("voice");

    try {
      await this.appendDailyLogEntry({
        messageId,
        authorId,
        authorName,
        guildId: scopeGuildId,
        channelId: scopeChannelId,
        content: cleanedContent,
        isVoice
      });
      this.queueMemoryRefresh();
      void this.ensureConversationMessageVector({
        messageId,
        content: cleanedContent,
        settings,
        trace
      });
      if (!isBot) {
        this.scheduleTextChannelMicroReflection({
          messageId,
          guildId: scopeGuildId,
          channelId: scopeChannelId,
          settings
        });
      }
    } catch (error) {
      this.logMemoryError("daily_log_write", error, { messageId, userId: authorId });
    }
  }

  async drainIngestQueue({ timeoutMs = 5000 } = {}) {
    const timeout = Math.max(100, Number(timeoutMs) || 5000);
    const deadline = Date.now() + timeout;
    while ((this.ingestWorkerActive || this.ingestQueue.length) && Date.now() < deadline) {
      await sleep(25);
    }
  }

  loadUserFactProfile({ userId, guildId }: { userId?: string | null; guildId?: string | null }) {
    const normalizedGuildId = String(guildId || "").trim();
    const normalizedUserId = String(userId || "").trim();
    if (!normalizedGuildId || !normalizedUserId) {
      return {
        userFacts: [] as MemoryFactRow[],
        guidanceFacts: [] as MemoryFactRow[]
      };
    }

    const rows = this.store.getFactsForScope({
      guildId: normalizedGuildId,
      subjectIds: [normalizedUserId],
      limit: 120
    });
    const guidanceFacts = rows.filter((row) => String(row?.fact_type || "").trim() === GUIDANCE_FACT_TYPE);
    const userFacts = rows.filter((row) => {
      const factType = String(row?.fact_type || "").trim();
      return factType !== GUIDANCE_FACT_TYPE && factType !== BEHAVIORAL_FACT_TYPE;
    });

    return {
      userFacts: sortProfileFacts(userFacts).slice(0, MAX_USER_PROFILE_FACTS),
      guidanceFacts: decoratePromptFactRows(guidanceFacts, { [normalizedUserId]: normalizedUserId }).slice(0, MAX_USER_GUIDANCE_FACTS)
    };
  }

  loadGuildFactProfile({ guildId }: { guildId?: string | null }) {
    const normalizedGuildId = String(guildId || "").trim();
    if (!normalizedGuildId) {
      return {
        selfFacts: [] as MemoryFactRow[],
        loreFacts: [] as MemoryFactRow[],
        guidanceFacts: [] as MemoryFactRow[]
      };
    }

    const rows = this.store.getFactsForScope({
      guildId: normalizedGuildId,
      subjectIds: [SELF_SUBJECT, LORE_SUBJECT],
      limit: 120
    });
    const guidanceFacts = rows.filter((row) => String(row?.fact_type || "").trim() === GUIDANCE_FACT_TYPE);
    const regularFacts = rows.filter((row) => {
      const factType = String(row?.fact_type || "").trim();
      return factType !== GUIDANCE_FACT_TYPE && factType !== BEHAVIORAL_FACT_TYPE;
    });

    return {
      selfFacts: sortProfileFacts(
        regularFacts.filter((row) => String(row.subject || "").trim() === SELF_SUBJECT)
      ).slice(0, MAX_GUILD_SELF_FACTS),
      loreFacts: sortProfileFacts(
        regularFacts.filter((row) => String(row.subject || "").trim() === LORE_SUBJECT)
      ).slice(0, MAX_GUILD_LORE_FACTS),
      guidanceFacts: decoratePromptFactRows(guidanceFacts, {
        [SELF_SUBJECT]: "Bot",
        [LORE_SUBJECT]: "Shared lore"
      }).slice(0, MAX_GUILD_GUIDANCE_FACTS)
    };
  }

  loadExistingFactsForReflection({ guildId, subjectIds }: { guildId: string; subjectIds: string[] }) {
    const normalizedGuildId = String(guildId || "").trim();
    if (!normalizedGuildId || !subjectIds.length) return [];
    const rows = this.store.getFactProfileRows({
      guildId: normalizedGuildId,
      subjects: subjectIds,
      limit: 200
    });
    return rows.map((row) => ({
      id: Number(row.id || 0),
      subject: String(row.subject || ""),
      fact: String(row.fact || ""),
      fact_type: String(row.fact_type || "other")
    }));
  }

  loadFactProfile({
    userId,
    guildId,
    participantIds = [],
    participantNames = {}
  }: {
    userId?: string | null;
    guildId?: string | null;
    participantIds?: string[];
    participantNames?: Record<string, string>;
  }) {
    const normalizedUserId = String(userId || "").trim() || null;
    const normalizedParticipantIds = [
      ...new Set(
        (Array.isArray(participantIds) ? participantIds : [])
          .map((value) => String(value || "").trim())
          .filter(Boolean)
      )
    ];
    if (normalizedUserId && !normalizedParticipantIds.includes(normalizedUserId)) {
      normalizedParticipantIds.unshift(normalizedUserId);
    }
    const normalizedGuildId = String(guildId || "").trim();
    if (!normalizedGuildId) {
      return {
        participantProfiles: [],
        selfFacts: [],
        loreFacts: [],
        userFacts: [],
        relevantFacts: [],
        guidanceFacts: []
      };
    }
    const subjectLabels: Record<string, string> = {
      [SELF_SUBJECT]: "Bot",
      [LORE_SUBJECT]: "Shared lore"
    };
    for (const participantId of normalizedParticipantIds) {
      subjectLabels[participantId] = String(participantNames?.[participantId] || participantId).trim() || participantId;
    }
    const rows = this.store.getFactsForScope({
      guildId: normalizedGuildId,
      subjectIds: [...normalizedParticipantIds, SELF_SUBJECT, LORE_SUBJECT],
      limit: Math.max(160, (normalizedParticipantIds.length + 2) * 40)
    });
    const regularFacts = sortProfileFacts(
      rows.filter((row) => {
        const factType = String(row?.fact_type || "").trim();
        return factType !== GUIDANCE_FACT_TYPE && factType !== BEHAVIORAL_FACT_TYPE;
      })
    );
    const guidanceFacts = dedupePromptFactRows(
      decoratePromptFactRows(
        rows.filter((row) => String(row?.fact_type || "").trim() === GUIDANCE_FACT_TYPE),
        subjectLabels
      )
    ).slice(0, MAX_PROFILE_GUIDANCE_FACTS);
    const participants = normalizedParticipantIds.map((participantId) => {
      const participantFacts = regularFacts.filter((row) => String(row?.subject || "").trim() === participantId);
      return {
        userId: participantId,
        displayName: subjectLabels[participantId],
        isPrimary: participantId === normalizedUserId,
        facts: participantFacts.slice(0, participantId === normalizedUserId ? MAX_PRIMARY_PARTICIPANT_FACTS : MAX_SECONDARY_PARTICIPANT_FACTS)
      };
    });
    const primaryProfile = participants.find((entry) => entry.isPrimary) || participants[0] || null;
    const selfFacts = regularFacts.filter((row) => String(row?.subject || "").trim() === SELF_SUBJECT).slice(0, MAX_GUILD_SELF_FACTS);
    const loreFacts = regularFacts.filter((row) => String(row?.subject || "").trim() === LORE_SUBJECT).slice(0, MAX_GUILD_LORE_FACTS);
    const secondaryFacts = participants
      .filter((entry) => !entry.isPrimary)
      .flatMap((entry) => entry.facts.slice(0, MAX_SECONDARY_RELEVANT_FACTS));

    return {
      participantProfiles: participants.map((entry) => ({
        userId: entry.userId,
        displayName: entry.displayName,
        isPrimary: entry.isPrimary,
        facts: entry.facts
      })),
      selfFacts,
      loreFacts,
      userFacts: Array.isArray(primaryProfile?.facts) ? primaryProfile.facts : [],
      relevantFacts: [...secondaryFacts, ...selfFacts, ...loreFacts],
      guidanceFacts
    };
  }

  async loadBehavioralFactsForPrompt({
    guildId,
    channelId = null,
    queryText,
    participantIds = [],
    settings,
    trace = {},
    limit = 8
  }: {
    guildId: string;
    channelId?: string | null;
    queryText: string;
    participantIds?: string[];
    settings?: Record<string, unknown> | null;
    trace?: Record<string, unknown>;
    limit?: number;
  }) {
    const normalizedGuildId = String(guildId || "").trim();
    const normalizedQueryText = String(queryText || "").replace(/\s+/g, " ").trim().slice(0, MAX_BEHAVIORAL_QUERY_CHARS);
    if (!normalizedGuildId || !normalizedQueryText) return [];

    const subjectIds = [
      ...new Set(
        [SELF_SUBJECT, LORE_SUBJECT, ...(Array.isArray(participantIds) ? participantIds : [])]
          .map((value) => String(value || "").trim())
          .filter(Boolean)
      )
    ];
    const rows = await this.searchDurableFacts({
      guildId: normalizedGuildId,
      channelId: String(channelId || "").trim() || null,
      queryText: normalizedQueryText,
      subjectIds,
      factTypes: [BEHAVIORAL_FACT_TYPE],
      settings,
      trace,
      limit: clampInt(limit, 1, 12)
    });
    return decoratePromptFactRows(rows as MemoryFactRow[], {
      [SELF_SUBJECT]: "Bot",
      [LORE_SUBJECT]: "Shared lore"
    }).slice(0, clampInt(limit, 1, 12));
  }

  async ensureConversationMessageVector({
    messageId,
    content,
    settings,
    trace = {}
  }: {
    messageId?: string | null;
    content?: string | null;
    settings?: Record<string, unknown> | null;
    trace?: Record<string, unknown>;
  }) {
    const normalizedMessageId = String(messageId || "").trim();
    const payload = cleanDailyEntryContent(content);
    if (!normalizedMessageId || !payload) return null;
    if (!this.llm?.isEmbeddingReady?.()) return null;
    if (typeof this.store?.upsertMessageVectorNative !== "function") return null;

    try {
      const embedded = await this.llm.embedText({
        settings,
        text: payload,
        trace: {
          ...trace,
          source: String(trace?.source || "conversation_message_embed")
        }
      });
      const vector = Array.isArray(embedded?.embedding)
        ? embedded.embedding.map((value) => Number(value))
        : [];
      const model = String(embedded?.model || "").trim();
      if (!vector.length || !model) return null;
      this.store.upsertMessageVectorNative({
        messageId: normalizedMessageId,
        model,
        embedding: vector
      });
      return {
        model,
        dims: vector.length,
        embedding: vector
      };
    } catch {
      return null;
    }
  }

  async searchConversationHistory({
    guildId,
    channelId = null,
    queryText,
    settings,
    trace = {},
    limit = 3,
    maxAgeHours = 24 * 7,
    before = 1,
    after = 1
  }: {
    guildId: string;
    channelId?: string | null;
    queryText: string;
    settings?: Record<string, unknown> | null;
    trace?: Record<string, unknown>;
    limit?: number;
    maxAgeHours?: number;
    before?: number;
    after?: number;
  }) {
    const normalizedGuildId = String(guildId || "").trim();
    const normalizedQuery = String(queryText || "").replace(/\s+/g, " ").trim().slice(0, MAX_CONVERSATION_QUERY_CHARS);
    if (!normalizedGuildId || !normalizedQuery) return [];

    try {
      const queryEmbedding = await this.getQueryEmbeddingForRetrieval({
        queryText: normalizedQuery,
        settings,
        trace: {
          ...trace,
          source: String(trace?.source || "conversation_history_query")
        }
      });
      if (
        queryEmbedding?.embedding?.length &&
        queryEmbedding?.model &&
        typeof this.store?.searchConversationWindowsByEmbedding === "function"
      ) {
        const semanticWindows = this.store.searchConversationWindowsByEmbedding({
          guildId: normalizedGuildId,
          channelId: String(channelId || "").trim() || null,
          queryEmbedding: queryEmbedding.embedding,
          model: queryEmbedding.model,
          limit: clampInt(limit, 1, 8),
          maxAgeHours: clampInt(maxAgeHours, 1, 24 * 30),
          before: clampInt(before, 0, 4),
          after: clampInt(after, 0, 4)
        });
        if (Array.isArray(semanticWindows) && semanticWindows.length > 0) {
          return semanticWindows;
        }
      }
    } catch {
      // Fall back to lexical history search below.
    }

    if (typeof this.store?.searchConversationWindows !== "function") return [];
    return this.store.searchConversationWindows({
      guildId: normalizedGuildId,
      channelId: String(channelId || "").trim() || null,
      queryText: normalizedQuery,
      limit: clampInt(limit, 1, 8),
      maxAgeHours: clampInt(maxAgeHours, 1, 24 * 30),
      before: clampInt(before, 0, 4),
      after: clampInt(after, 0, 4)
    });
  }

  isVoiceConversationMessage(messageId = "") {
    return String(messageId || "").trim().startsWith("voice-");
  }

  scheduleTextChannelMicroReflection({
    messageId,
    guildId,
    channelId,
    settings
  }: {
    messageId?: string | null;
    guildId?: string | null;
    channelId?: string | null;
    settings?: Record<string, unknown> | null;
  }) {
    const normalizedGuildId = String(guildId || "").trim();
    const normalizedChannelId = String(channelId || "").trim();
    const normalizedMessageId = String(messageId || "").trim();
    if (!normalizedGuildId || !normalizedChannelId || !normalizedMessageId) return;
    if (this.isVoiceConversationMessage(normalizedMessageId)) return;

    const resolvedSettings = settings || this.store.getSettings?.() || null;
    const memorySettings = getMemorySettings(resolvedSettings);
    if (!memorySettings.enabled || !memorySettings.reflection?.enabled) return;

    const key = `${normalizedGuildId}:${normalizedChannelId}`;
    const now = Date.now();
    const currentTimer = this.textMicroReflectionTimers.get(key);
    if (currentTimer) {
      clearTimeout(currentTimer);
    }

    const previousState = this.textMicroReflectionState.get(key) || {};
    this.textMicroReflectionState.set(key, {
      ...previousState,
      guildId: normalizedGuildId,
      channelId: normalizedChannelId,
      lastMessageAtMs: now,
      lastMessageId: normalizedMessageId,
      settings: resolvedSettings
    });

    void this.maybeRunContextPressureMicroReflection({
      key,
      state: this.textMicroReflectionState.get(key),
      memorySettings
    });

    const timer = setTimeout(() => {
      this.textMicroReflectionTimers.delete(key);
      void this.runTextChannelMicroReflection(key).catch((error) => {
        this.logMemoryError("text_micro_reflection", error, {
          guildId: normalizedGuildId,
          channelId: normalizedChannelId
        });
      });
    }, TEXT_MICRO_REFLECTION_SILENCE_MS);
    this.textMicroReflectionTimers.set(key, timer);
  }

  async maybeRunContextPressureMicroReflection({
    key,
    state,
    memorySettings
  }: {
    key: string;
    state: Record<string, unknown> | undefined;
    memorySettings: ReturnType<typeof getMemorySettings>;
  }) {
    if (!this.store?.getMessagesInWindow) return;
    if (!state || typeof state !== "object") return;

    const guildId = String(state.guildId || "").trim();
    const channelId = String(state.channelId || "").trim();
    const lastMessageAtMs = Number(state.lastMessageAtMs || 0);
    if (!guildId || !channelId || !lastMessageAtMs) return;

    const inFlightKey = `text:${guildId}:${channelId}`;
    if (this.microReflectionInFlight.has(inFlightKey)) return;

    const now = Date.now();
    const lastContextPressureAtMs = Number(state.lastContextPressureAtMs || 0);
    if (lastContextPressureAtMs > 0 && now - lastContextPressureAtMs < TEXT_MICRO_REFLECTION_CONTEXT_PRESSURE_COOLDOWN_MS) {
      return;
    }

    const maxRecentMessages = clampInt(memorySettings.promptSlice?.maxRecentMessages, 4, 120);
    const threshold = Math.max(6, maxRecentMessages - TEXT_MICRO_REFLECTION_CONTEXT_PRESSURE_MARGIN);
    const processedThroughMs = Number(state.processedThroughMs || 0);
    const sinceMs = Math.max(0, Math.max(processedThroughMs, lastMessageAtMs - TEXT_MICRO_REFLECTION_LOOKBACK_MS));

    const entries = this.store.getMessagesInWindow({
      guildId,
      channelId,
      sinceIso: new Date(sinceMs).toISOString(),
      untilIso: new Date(lastMessageAtMs).toISOString(),
      limit: Math.max(maxRecentMessages * 2, 120)
    });
    const humanCount = (Array.isArray(entries) ? entries : []).filter((entry) => {
      const messageId = String(entry?.message_id || "");
      if (messageId.startsWith("reaction:")) return false;
      return !entry?.is_bot;
    }).length;
    if (humanCount < threshold) return;

    this.textMicroReflectionState.set(key, {
      ...state,
      lastContextPressureAtMs: now
    });

    const startedAt = Date.now();
    void this.runTextChannelMicroReflection(key, {
      trigger: "text_context_pressure",
      untilMs: lastMessageAtMs
    })
      .then((result) => {
        this.store.logAction?.({
          kind: "text_runtime",
          guildId,
          channelId,
          content: "memory_micro_reflection_context_pressure",
          metadata: {
            trigger: "text_context_pressure",
            ok: Boolean(result?.ok),
            reason: result?.reason || null,
            humanCount,
            threshold,
            durationMs: Math.max(0, Date.now() - startedAt)
          }
        });
      })
      .catch((error) => {
        this.logMemoryError("text_micro_reflection_context_pressure", error, {
          guildId,
          channelId,
          humanCount,
          threshold
        });
      });
  }

  async runTextChannelMicroReflection(
    key = "",
    {
      trigger = "text_channel_silence",
      untilMs = null
    }: {
      trigger?: "text_channel_silence" | "text_context_pressure";
      untilMs?: number | null;
    } = {}
  ) {
    const state = this.textMicroReflectionState.get(String(key || "").trim()) || null;
    if (!state) return { ok: false, reason: "state_missing" };

    const guildId = String(state.guildId || "").trim();
    const channelId = String(state.channelId || "").trim();
    const lastMessageAtMs = Number(state.lastMessageAtMs || 0);
    const reflectionUntilMs = Number.isFinite(Number(untilMs))
      ? Math.min(lastMessageAtMs, Number(untilMs))
      : lastMessageAtMs;
    const settings = state.settings || this.store.getSettings?.() || null;
    const memorySettings = getMemorySettings(settings);
    if (!guildId || !channelId || !reflectionUntilMs || !memorySettings.enabled || !memorySettings.reflection?.enabled) {
      return { ok: false, reason: "state_invalid" };
    }

    const inFlightKey = `text:${guildId}:${channelId}`;
    if (this.microReflectionInFlight.has(inFlightKey)) {
      return { ok: false, reason: "already_running" };
    }

    const processedThroughMs = Number(state.processedThroughMs || 0);
    const sinceMs = Math.max(processedThroughMs, reflectionUntilMs - TEXT_MICRO_REFLECTION_LOOKBACK_MS);
    const persistProcessedThrough = (value: number) => {
      const latestStateRaw = this.textMicroReflectionState.get(key);
      const latestState = latestStateRaw && typeof latestStateRaw === "object"
        ? latestStateRaw as Record<string, unknown>
        : state;
      const previousProcessedThroughMs = Number(latestState.processedThroughMs || 0);
      this.textMicroReflectionState.set(key, {
        ...latestState,
        processedThroughMs: Math.max(previousProcessedThroughMs, value)
      });
    };
    const entries = this.store.getMessagesInWindow({
      guildId,
      channelId,
      sinceIso: new Date(sinceMs).toISOString(),
      untilIso: new Date(reflectionUntilMs).toISOString(),
      limit: 120
    });
    const normalizedEntries = (Array.isArray(entries) ? entries : [])
      .filter((entry) => !String(entry?.message_id || "").startsWith("reaction:"))
      .map((entry) => ({
        timestampIso: String(entry?.created_at || "").trim(),
        timestampMs: Date.parse(String(entry?.created_at || "")),
        author: String(entry?.author_name || "unknown").trim() || "unknown",
        authorId: String(entry?.author_id || "").trim() || null,
        isBot: Boolean(entry?.is_bot),
        content: String(entry?.content || "").trim()
      }))
      .filter((entry) => !entry.isBot)
      .filter((entry) => entry.content);
    if (!normalizedEntries.length) {
      persistProcessedThrough(reflectionUntilMs);
      return { ok: false, reason: "no_entries" };
    }

    this.microReflectionInFlight.add(inFlightKey);
    try {
      const result = await runMicroReflection({
        memory: this,
        store: this.store,
        llm: this.llm,
        settings,
        guildId,
        channelId,
        trigger,
        sourceMessageId: `micro_reflection_text_${trigger}_${guildId}_${channelId}_${reflectionUntilMs}`,
        entries: normalizedEntries
      });
      persistProcessedThrough(reflectionUntilMs);
      return result;
    } finally {
      this.microReflectionInFlight.delete(inFlightKey);
    }
  }

  async runVoiceSessionMicroReflection({
    guildId,
    channelId = null,
    sessionId,
    settings,
    startedAtMs,
    transcriptTurns = [],
    pendingMemoryIngest = null
  }: {
    guildId?: string | null;
    channelId?: string | null;
    sessionId?: string | null;
    settings?: Record<string, unknown> | null;
    startedAtMs?: number | null;
    transcriptTurns?: Array<Record<string, unknown>>;
    pendingMemoryIngest?: Promise<unknown> | null;
  }) {
    const normalizedGuildId = String(guildId || "").trim();
    const normalizedSessionId = String(sessionId || "").trim() || "session";
    const resolvedSettings = settings || this.store.getSettings?.() || null;
    const memorySettings = getMemorySettings(resolvedSettings);
    if (!normalizedGuildId || !memorySettings.enabled || !memorySettings.reflection?.enabled) {
      return { ok: false, reason: "memory_reflection_disabled" };
    }

    const inFlightKey = `voice:${normalizedGuildId}:${normalizedSessionId}`;
    if (this.microReflectionInFlight.has(inFlightKey)) {
      return { ok: false, reason: "already_running" };
    }

    if (pendingMemoryIngest) {
      try {
        await pendingMemoryIngest;
      } catch {
        // Best effort. The transcript timeline below is still enough to reflect on.
      }
    }

    const normalizedEntries = (Array.isArray(transcriptTurns) ? transcriptTurns : [])
      .filter((turn) => {
        const kind = String(turn?.kind || "speech").trim();
        return kind === "speech" || !kind;
      })
      .map((turn) => ({
        timestampIso: Number.isFinite(Number(turn?.at))
          ? new Date(Number(turn.at)).toISOString()
          : "",
        timestampMs: Number(turn?.at) || 0,
        author: String(turn?.speakerName || "unknown").trim() || "unknown",
        authorId: String(turn?.userId || "").trim() || null,
        isBot: String(turn?.role || "").trim() === "assistant",
        content: String(turn?.text || "").trim()
      }))
      .filter((entry) => entry.content);
    if (!normalizedEntries.length) {
      return { ok: false, reason: "no_entries" };
    }

    const sessionStartMs = Number.isFinite(Number(startedAtMs)) ? Number(startedAtMs) : 0;
    const scopedEntries = sessionStartMs > 0
      ? normalizedEntries.filter((entry) => entry.timestampMs >= sessionStartMs)
      : normalizedEntries;

    this.microReflectionInFlight.add(inFlightKey);
    try {
      return await runMicroReflection({
        memory: this,
        store: this.store,
        llm: this.llm,
        settings: resolvedSettings,
        guildId: normalizedGuildId,
        channelId: String(channelId || "").trim() || null,
        trigger: "voice_session_end",
        sourceMessageId: `micro_reflection_voice_${normalizedGuildId}_${normalizedSessionId}`,
        entries: scopedEntries
      });
    } finally {
      this.microReflectionInFlight.delete(inFlightKey);
    }
  }

  async searchDurableFacts({
    guildId,
    channelId = null,
    queryText,
    subjectIds = null,
    factTypes = null,
    settings,
    trace = {},
    limit = HYBRID_FACT_LIMIT
  }) {
    const scopeGuildId = String(guildId || "").trim();
    if (!scopeGuildId) return [];
    const normalizedTrace =
      trace && typeof trace === "object"
        ? trace as Record<string, unknown>
        : {};

    const isFullMemoryQuery = queryText === "__ALL__";
    const boundedLimit = isFullMemoryQuery
      ? clampInt(limit, 1, FULL_MEMORY_DUMP_LIMIT)
      : clampInt(limit, 1, 24);

    if (isFullMemoryQuery) {
      const rows = this.store.getFactsForScope?.({
        guildId: scopeGuildId,
        subjectIds,
        factTypes,
        limit: boundedLimit
      }) || [];
      return rows.map((row) => ({
        id: row.id,
        created_at: row.created_at,
        guild_id: row.guild_id,
        channel_id: row.channel_id,
        subject: row.subject,
        fact: row.fact,
        fact_type: row.fact_type,
        evidence_text: row.evidence_text,
        source_message_id: row.source_message_id,
        confidence: row.confidence,
        score: row._score,
        semanticScore: row._semanticScore,
        lexicalScore: row._lexicalScore
      }));
    }

    const query = String(queryText || "").trim();
    const candidateLimit = Math.min(
      HYBRID_MAX_CANDIDATES,
      Math.max(boundedLimit * HYBRID_CANDIDATE_MULTIPLIER, boundedLimit)
    );
    const recentCandidateLimit = Math.min(
      HYBRID_RECENT_CANDIDATE_LIMIT,
      Math.max(boundedLimit * 2, boundedLimit)
    );
    const queryTokens = extractStableTokens(query, 8);

    const recentCandidates = this.store.getFactsForScope?.({
      guildId: scopeGuildId,
      subjectIds,
      factTypes,
      limit: recentCandidateLimit
    }) || [];

    const lexicalCandidates = this.store.searchMemoryFactsLexical?.({
      guildId: scopeGuildId,
      subjectIds,
      factTypes,
      queryText: query,
      queryTokens,
      limit: candidateLimit
    }) || [];

    let semanticCandidates: MemoryFactRow[] = [];
    if (typeof this.store.searchMemoryFactsByEmbedding === "function") {
      try {
        const queryEmbedding = await this.getQueryEmbeddingForRetrieval({
          queryText: query,
          settings,
          trace: {
            ...normalizedTrace,
            source: String(normalizedTrace.source || "memory_semantic_candidates")
          }
        });
        if (queryEmbedding?.embedding?.length && queryEmbedding?.model) {
          semanticCandidates = this.store.searchMemoryFactsByEmbedding({
            guildId: scopeGuildId,
            subjectIds,
            factTypes,
            model: queryEmbedding.model,
            queryEmbedding: queryEmbedding.embedding,
            limit: candidateLimit
          });
        }
      } catch {
        semanticCandidates = [];
      }
    }

    const candidates = mergeUniqueFactCandidates(
      semanticCandidates,
      lexicalCandidates,
      recentCandidates
    );
    if (!candidates.length) return [];

    const ranked = await this.rankHybridCandidates({
      candidates,
      queryText,
      settings,
      trace: normalizedTrace,
      channelId,
      requireRelevanceGate: true
    });

    return ranked.slice(0, boundedLimit).map((row) => ({
      id: row.id,
      created_at: row.created_at,
      guild_id: row.guild_id,
      channel_id: row.channel_id,
      subject: row.subject,
      fact: row.fact,
      fact_type: row.fact_type,
      evidence_text: row.evidence_text,
      source_message_id: row.source_message_id,
      confidence: row.confidence,
      score: row._score,
      semanticScore: row._semanticScore,
      lexicalScore: row._lexicalScore
    }));
  }

  async rankHybridCandidates({
    candidates,
    queryText,
    settings,
    trace = {},
    channelId = null,
    requireRelevanceGate = false
  }) {
    const query = String(queryText || "").trim();
    const queryTokens = extractStableTokens(query, 32);
    const queryCompact = normalizeHighlightText(query);
    const normalizedChannelId = String(channelId || "").trim();
    const semanticScores = await this.getSemanticScoreMap({ candidates, queryText: query, settings, trace });
    const semanticAvailable = semanticScores.size > 0;

    const scored = candidates.map((row) => {
      const lexicalScore = computeLexicalFactScore(row, { queryTokens, queryCompact });
      const semanticScore = semanticScores.get(Number(row.id)) || 0;
      const recencyScore = computeRecencyScore(row.created_at);
      const confidenceScore = clamp01(row.confidence, 0.5);
      const channelScore = computeChannelScopeScore(row.channel_id, normalizedChannelId);
      const combined = semanticAvailable
        ? 0.5 * semanticScore + 0.28 * lexicalScore + 0.1 * confidenceScore + 0.07 * recencyScore + 0.05 * channelScore
        : 0.75 * lexicalScore + 0.1 * confidenceScore + 0.1 * recencyScore + 0.05 * channelScore;
      const temporalMultiplier = computeTemporalDecayMultiplier({
        createdAtIso: row.created_at,
        factType: row.fact_type,
        halfLifeDays: HYBRID_TEMPORAL_DECAY_HALF_LIFE_DAYS,
        minMultiplier: HYBRID_TEMPORAL_DECAY_MIN_MULTIPLIER
      });
      const decayedScore = combined * temporalMultiplier;

      return {
        ...row,
        _score: Number(decayedScore.toFixed(6)),
        _semanticScore: Number(semanticScore.toFixed(6)),
        _lexicalScore: Number(lexicalScore.toFixed(6))
      };
    });

    const sorted = scored.sort((a, b) => {
      if (b._score !== a._score) return b._score - a._score;
      return Date.parse(b.created_at || "") - Date.parse(a.created_at || "");
    });

    if (!queryTokens.length && !semanticAvailable) {
      return sorted;
    }

    const filtered = sorted.filter((row) =>
      passesHybridRelevanceGate({
        row,
        semanticAvailable
      }));
    if (filtered.length) {
      return rerankWithMmr(filtered, { lambda: HYBRID_MMR_LAMBDA });
    }
    if (requireRelevanceGate) return [];
    return rerankWithMmr(sorted, { lambda: HYBRID_MMR_LAMBDA });
  }

  buildQueryEmbeddingCacheKey({ queryText, settings }) {
    const normalizedQuery = normalizeQueryEmbeddingText(queryText);
    if (!normalizedQuery) return "";
    const resolvedModel = String(this.llm?.resolveEmbeddingModel?.(settings) || "").trim().toLowerCase() || "default";
    return `${resolvedModel}\n${normalizedQuery}`;
  }

  getCachedQueryEmbedding(cacheKey) {
    if (!cacheKey) return null;
    const now = Date.now();
    const cached = this.queryEmbeddingCache.get(cacheKey) || null;
    if (!cached) return null;
    if (now >= Number(cached.expiresAt || 0)) {
      this.queryEmbeddingCache.delete(cacheKey);
      return null;
    }
    return {
      embedding: Array.isArray(cached.embedding) ? [...cached.embedding] : [],
      model: String(cached.model || "")
    };
  }

  setCachedQueryEmbedding(cacheKey, value) {
    if (!cacheKey) return;
    const embedding = Array.isArray(value?.embedding) ? value.embedding.map((item) => Number(item)) : [];
    const model = String(value?.model || "").trim();
    if (!embedding.length || !model) return;

    const now = Date.now();
    this.queryEmbeddingCache.set(cacheKey, {
      embedding,
      model,
      expiresAt: now + QUERY_EMBEDDING_CACHE_TTL_MS
    });

    for (const [key, entry] of this.queryEmbeddingCache.entries()) {
      if (now < Number(entry?.expiresAt || 0)) continue;
      this.queryEmbeddingCache.delete(key);
    }
    while (this.queryEmbeddingCache.size > QUERY_EMBEDDING_CACHE_MAX_ENTRIES) {
      const oldestKey = this.queryEmbeddingCache.keys().next().value;
      if (!oldestKey) break;
      this.queryEmbeddingCache.delete(oldestKey);
    }
  }

  async getQueryEmbeddingForRetrieval({ queryText, settings, trace = {} }) {
    const query = normalizeQueryEmbeddingText(queryText);
    if (query.length < 3) return null;

    const cacheKey = this.buildQueryEmbeddingCacheKey({ queryText: query, settings });
    if (!cacheKey) return null;

    const cached = this.getCachedQueryEmbedding(cacheKey);
    if (cached?.embedding?.length && cached?.model) {
      return cached;
    }

    const inFlight = this.queryEmbeddingInFlight.get(cacheKey);
    if (inFlight) {
      return await inFlight;
    }

    const task = (async () => {
      const queryEmbeddingResult = await this.llm.embedText({
        settings,
        text: query,
        trace: {
          ...trace,
          source: String((trace as Record<string, unknown>)?.source || "memory_query")
        }
      });
      const queryEmbedding = Array.isArray(queryEmbeddingResult?.embedding)
        ? queryEmbeddingResult.embedding.map((value) => Number(value))
        : [];
      const model = String(queryEmbeddingResult?.model || "").trim();
      if (!queryEmbedding.length || !model) return null;

      const result = {
        embedding: queryEmbedding,
        model
      };
      this.setCachedQueryEmbedding(cacheKey, result);
      return result;
    })();

    this.queryEmbeddingInFlight.set(cacheKey, task);
    try {
      return await task;
    } finally {
      this.queryEmbeddingInFlight.delete(cacheKey);
    }
  }

  async getSemanticScoreMap({ candidates, queryText, settings, trace = {} }) {
    if (!this.llm?.isEmbeddingReady?.()) return new Map();

    const query = String(queryText || "").trim();
    if (query.length < 3) return new Map();

    let queryEmbeddingResult = null;
    try {
      queryEmbeddingResult = await this.getQueryEmbeddingForRetrieval({
        queryText: query,
        settings,
        trace
      });
    } catch {
      return new Map();
    }

    const queryEmbedding = Array.isArray(queryEmbeddingResult?.embedding)
      ? queryEmbeddingResult.embedding
      : [];
    const model = String(queryEmbeddingResult?.model || "").trim();
    if (!queryEmbedding.length || !model) return new Map();

    const factIds = candidates
      .map((row) => Number(row.id))
      .filter((value) => Number.isInteger(value) && value > 0);
    if (!factIds.length) return new Map();

    const scoreMap = new Map();
    const scoredFactIds = new Set();
    const collectNativeScores = (ids) => {
      const rows = this.store.getMemoryFactVectorNativeScores?.({
        factIds: ids,
        model,
        queryEmbedding
      });
      if (!Array.isArray(rows) || !rows.length) return;
      for (const row of rows) {
        const factId = Number(row?.fact_id);
        const score = Number(row?.score);
        if (!Number.isInteger(factId) || factId <= 0) continue;
        scoredFactIds.add(factId);
        if (Number.isFinite(score) && score > 0) {
          scoreMap.set(factId, score);
        }
      }
    };
    collectNativeScores(factIds);

    const unresolvedFactIds = factIds.filter((factId) => !scoredFactIds.has(factId));
    if (!unresolvedFactIds.length) return scoreMap;

    let backfilled = 0;
    const unresolvedSet = new Set(unresolvedFactIds);
    for (const row of candidates) {
      const factId = Number(row.id);
      if (!unresolvedSet.has(factId)) continue;
      if (!Number.isInteger(factId) || factId <= 0) continue;
      if (backfilled >= HYBRID_MAX_VECTOR_BACKFILL_PER_QUERY) break;

      const embedding = await this.ensureFactVector({
        factRow: row,
        model,
        settings,
        trace: {
          ...trace,
          source: "memory_fact"
        }
      });
      if (embedding?.length) {
        backfilled += 1;
      }
    }

    if (backfilled > 0) {
      collectNativeScores(unresolvedFactIds);
    }

    return scoreMap;
  }

  async ensureFactVector({ factRow, model = "", settings, trace = {} }) {
    const factId = Number(factRow?.id);
    if (!Number.isInteger(factId) || factId <= 0) return null;

    const resolvedModel = String(model || this.llm?.resolveEmbeddingModel?.(settings) || "").trim();
    if (!resolvedModel) return null;

    const existing = this.store.getMemoryFactVectorNative?.(factId, resolvedModel);
    if (existing?.length) return existing;

    try {
      const payload = buildFactEmbeddingPayload(factRow);
      if (!payload) return null;
      const embedded = await this.llm.embedText({
        settings,
        text: payload,
        trace
      });
      const vector = Array.isArray(embedded?.embedding)
        ? embedded.embedding.map((value) => Number(value))
        : [];
      if (!vector.length) return null;

      this.store.upsertMemoryFactVectorNative({
        factId,
        model: embedded.model || resolvedModel,
        embedding: vector
      });
      return vector;
    } catch {
      return null;
    }
  }

  async queueMemoryRefresh() {
    if (this.pendingWrite) return;
    this.pendingWrite = true;

    setTimeout(async () => {
      try {
        await this.refreshMemoryMarkdown();
      } catch (error) {
        this.logMemoryError("curation_refresh", error);
      } finally {
        this.pendingWrite = false;
      }
    }, 1000);
  }

  async refreshMemoryMarkdown() {
    const markdown = await this.buildMemoryMarkdown();
    await fs.mkdir(this.memoryDirPath, { recursive: true });
    await fs.writeFile(this.memoryFilePath, markdown, "utf8");
  }

  async buildMemoryMarkdown({ guildId = null }: { guildId?: string | null } = {}) {
    const normalizedGuildId = String(guildId || "").trim() || null;
    const peopleSection = this.buildPeopleSection(normalizedGuildId);
    const selfSection = this.buildSelfSection(MAX_SECTION_FACTS, normalizedGuildId);
    const recentDailyEntries = await this.getRecentDailyEntries({
      days: 3,
      maxEntries: 120,
      guildId: normalizedGuildId
    });
    const highlightsSection = buildHighlightsSection(recentDailyEntries, 24);
    const loreSection = this.buildLoreSection(MAX_SECTION_FACTS, normalizedGuildId);
    const dailyFiles = await this.getRecentDailyFiles(5);
    const dailyFilesLine = dailyFiles.length
      ? dailyFiles.map((filePath) => `memory/${path.basename(filePath)}`).join(", ")
      : "(No daily files yet.)";
    const scopeLine = normalizedGuildId
      ? `_Operator-facing summary for guild \`${normalizedGuildId}\`. Runtime prompts use indexed durable facts + retrieval, not this markdown file directly._`
      : "_Operator-facing summary. Runtime prompts use indexed durable facts + retrieval, not this markdown file directly._";

    return [
      "# Durable Memory Snapshot",
      "",
      scopeLine,
      "",
      "## People (Durable Facts)",
      ...(peopleSection.length ? peopleSection : ["- (No stable people facts yet.)"]),
      "",
      "## Bot Self Memory",
      ...(selfSection.length ? selfSection : ["- (No durable self-memory lines yet.)"]),
      "",
      "## Ongoing Lore",
      ...(loreSection.length ? loreSection : ["- (No durable lore lines yet.)"]),
      "",
      "## Recent Journal Highlights",
      ...(highlightsSection.length ? highlightsSection : ["- (No recent highlights yet.)"]),
      "",
      "## Source Daily Logs",
      "- Daily logs are append-only in `memory/YYYY-MM-DD.md`.",
      normalizedGuildId
        ? `- Recent files: ${dailyFilesLine} (entries filtered to guild \`${normalizedGuildId}\`).`
        : `- Recent files: ${dailyFilesLine}`
    ].join("\n");
  }

  async readMemoryMarkdown({ guildId = null }: { guildId?: string | null } = {}) {
    const normalizedGuildId = String(guildId || "").trim() || null;
    if (normalizedGuildId) {
      return await this.buildMemoryMarkdown({ guildId: normalizedGuildId });
    }

    try {
      return await fs.readFile(this.memoryFilePath, "utf8");
    } catch {
      return "# Memory\n\n(no memory file yet)";
    }
  }

  async purgeGuildMemory({ guildId }: { guildId?: string | null } = {}) {
    const normalizedGuildId = String(guildId || "").trim();
    if (!normalizedGuildId) {
      return {
        ok: false,
        reason: "guild_required",
        guildId: null,
        durableFactsDeleted: 0,
        durableFactVectorsDeleted: 0,
        conversationMessagesDeleted: 0,
        conversationVectorsDeleted: 0,
        reflectionEventsDeleted: 0,
        journalEntriesDeleted: 0,
        journalFilesTouched: 0,
        summaryRefreshed: false
      } as const;
    }

    this.clearScheduledTextMicroReflectionsForGuild(normalizedGuildId);

    try {
      await this.drainIngestQueue({ timeoutMs: 8_000 });
    } catch {
      // Best effort. The purge below is still the source of truth.
    }

    await this.waitForGuildMicroReflectionsToSettle(normalizedGuildId, 8_000);

    const durableResult =
      typeof this.store?.deleteMemoryFactsForGuild === "function"
        ? this.store.deleteMemoryFactsForGuild(normalizedGuildId)
        : { factsDeleted: 0, vectorsDeleted: 0 };
    const messageResult =
      typeof this.store?.deleteMessagesForGuild === "function"
        ? this.store.deleteMessagesForGuild(normalizedGuildId)
        : { messagesDeleted: 0, vectorsDeleted: 0 };
    const reflectionResult =
      typeof this.store?.deleteMemoryReflectionRunsForGuild === "function"
        ? this.store.deleteMemoryReflectionRunsForGuild(normalizedGuildId)
        : { deleted: 0 };
    const journalResult = await this.purgeGuildEntriesFromDailyLogs(normalizedGuildId);

    let summaryRefreshed = false;
    try {
      await this.refreshMemoryMarkdown();
      summaryRefreshed = true;
    } catch {
      summaryRefreshed = false;
    }

    return {
      ok: true,
      reason: "deleted",
      guildId: normalizedGuildId,
      durableFactsDeleted: Number(durableResult?.factsDeleted || 0),
      durableFactVectorsDeleted: Number(durableResult?.vectorsDeleted || 0),
      conversationMessagesDeleted: Number(messageResult?.messagesDeleted || 0),
      conversationVectorsDeleted: Number(messageResult?.vectorsDeleted || 0),
      reflectionEventsDeleted: Number(reflectionResult?.deleted || 0),
      journalEntriesDeleted: Number(journalResult?.entriesDeleted || 0),
      journalFilesTouched: Number(journalResult?.filesTouched || 0),
      summaryRefreshed
    } as const;
  }

  buildPeopleSection(guildId: string | null = null) {
    const normalizedGuildId = String(guildId || "").trim() || null;
    const subjects = this.store
      .getMemorySubjects(80, normalizedGuildId ? { guildId: normalizedGuildId } : null)
      .filter((subjectRow) => subjectRow.subject !== LORE_SUBJECT && subjectRow.subject !== SELF_SUBJECT);
    const factsByScopedSubject = this.getPeopleFactsByScopedSubject(subjects);
    const peopleLines = [];

    for (const subjectRow of subjects) {
      const scopedSubjectKey = `${String(subjectRow.guild_id || "").trim()}::${String(subjectRow.subject || "").trim()}`;
      const rows = factsByScopedSubject.get(scopedSubjectKey) || [];
      const cleaned = [
        ...new Set(
          rows
            .map((row) => formatTypedFactForMemory(row.fact, row.fact_type))
            .filter(Boolean)
        )
      ].slice(0, MAX_PEOPLE_FACTS_PER_SUBJECT);
      if (!cleaned.length) continue;
      const scopeLabel = normalizedGuildId ? "" : subjectRow.guild_id ? `[guild:${subjectRow.guild_id}] ` : "";
      peopleLines.push(`- ${scopeLabel}${subjectRow.subject}: ${cleaned.join(" | ")}`);
    }

    return peopleLines;
  }

  getPeopleFactsByScopedSubject(subjectRows = []) {
    const subjectsByGuild = new Map();
    for (const subjectRow of subjectRows) {
      const guildId = String(subjectRow?.guild_id || "").trim();
      const subjectId = String(subjectRow?.subject || "").trim();
      if (!guildId || !subjectId) continue;
      const existing = subjectsByGuild.get(guildId) || [];
      if (!existing.includes(subjectId)) {
        existing.push(subjectId);
      }
      subjectsByGuild.set(guildId, existing);
    }

    const factsByScopedSubject = new Map();
    for (const [guildId, subjectIds] of subjectsByGuild.entries()) {
      const rows = this.store.getFactsForSubjectsScoped({
        guildId,
        subjectIds,
        perSubjectLimit: MAX_PEOPLE_FACTS_PER_SUBJECT,
        totalLimit: Math.min(1200, Math.max(200, subjectIds.length * 10))
      });

      for (const row of rows) {
        const scopedGuildId = String(row?.guild_id || "").trim();
        const scopedSubjectId = String(row?.subject || "").trim();
        if (!scopedGuildId || !scopedSubjectId) continue;
        const scopedSubjectKey = `${scopedGuildId}::${scopedSubjectId}`;
        const existing = factsByScopedSubject.get(scopedSubjectKey) || [];
        if (existing.length >= MAX_PEOPLE_FACTS_PER_SUBJECT) continue;
        existing.push(row);
        factsByScopedSubject.set(scopedSubjectKey, existing);
      }
    }

    return factsByScopedSubject;
  }

  buildSelfSection(maxItems = MAX_SECTION_FACTS, guildId: string | null = null) {
    const normalizedGuildId = String(guildId || "").trim() || null;
    const rows = this.store.getFactsForSubjectScoped(
      SELF_SUBJECT,
      32,
      normalizedGuildId ? { guildId: normalizedGuildId } : null
    );
    const durableSelfLines = [];
    const seen = new Set();
    for (const row of rows) {
      const normalized = normalizeSelfFactForDisplay(row.fact);
      if (!normalized) continue;
      const key = `${row.guild_id || ""}:${normalized.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const scopeLabel = normalizedGuildId ? "" : row.guild_id ? `[guild:${row.guild_id}] ` : "";
      durableSelfLines.push(`- ${scopeLabel}${normalized}`);
    }
    return durableSelfLines.slice(0, Math.max(1, maxItems));
  }

  buildLoreSection(maxItems = MAX_SECTION_FACTS, guildId: string | null = null) {
    const normalizedGuildId = String(guildId || "").trim() || null;
    const rows = this.store.getFactsForSubjectScoped(
      LORE_SUBJECT,
      32,
      normalizedGuildId ? { guildId: normalizedGuildId } : null
    );
    const durableLoreLines = [];
    const seen = new Set();
    for (const row of rows) {
      const normalized = normalizeLoreFactForDisplay(row.fact);
      if (!normalized) continue;
      const key = `${row.guild_id || ""}:${normalized.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const scopeLabel = normalizedGuildId ? "" : row.guild_id ? `[guild:${row.guild_id}] ` : "";
      durableLoreLines.push(`- ${scopeLabel}${normalized}`);
    }
    return durableLoreLines.slice(0, Math.max(1, maxItems));
  }

  async rememberDirectiveLineDetailed({
    line,
    sourceMessageId,
    userId,
    guildId,
    channelId = null,
    sourceText = "",
    scope = "lore",
    subjectOverride = null,
    factType = null,
    confidence = null,
    validationMode = "strict",
    evidenceText = null,
    supersedesFactText = null
  }: {
    line: string;
    sourceMessageId?: string | null;
    userId?: string | null;
    guildId?: string | null;
    channelId?: string | null;
    sourceText?: string;
    scope?: string;
    subjectOverride?: string | null;
    factType?: string | null;
    confidence?: number | null;
    validationMode?: string;
    evidenceText?: string | null;
    supersedesFactText?: string | null;
  }) {
    const scopeGuildId = String(guildId || "").trim();
    if (!scopeGuildId) {
      return {
        ok: false,
        reason: "guild_required"
      };
    }

    const scopeConfig = resolveDirectiveScopeConfig(scope);
    const subject = subjectOverride ? String(subjectOverride).trim() : scopeConfig.subject;
    const normalizedFactType = normalizeFactType(factType || scopeConfig.defaultFactType);
    if (!subject) {
      return {
        ok: false,
        reason: "subject_required"
      };
    }

    const cleaned = normalizeMemoryLineInput(line);
    if (!cleaned) {
      return {
        ok: false,
        reason: "empty_fact"
      };
    }
    const normalizedValidationMode =
      String(validationMode || "").trim().toLowerCase() === "minimal" ? "minimal" : "strict";
    const allowsBehavioralInstruction =
      normalizedFactType === GUIDANCE_FACT_TYPE || normalizedFactType === BEHAVIORAL_FACT_TYPE;
    if (normalizedValidationMode === "strict") {
      if (isUnsafeMemoryFactText(cleaned)) {
        return { ok: false, reason: "unsafe_instruction" };
      }
      if (
        !allowsBehavioralInstruction &&
        (isBehavioralDirectiveLikeFactText(cleaned) || isInstructionLikeFactText(cleaned))
      ) {
        return { ok: false, reason: "instruction_like" };
      }
    }

    const factText = normalizeStoredFactText(cleaned);
    const normalizedEvidenceText = evidenceText
      ? sanitizeInline(evidenceText, MAX_DIRECTIVE_EVIDENCE_CHARS)
      : normalizeEvidenceText(sourceText, sourceText);
    const normalizedConfidence = clamp01(
      Number.isFinite(Number(confidence)) ? Number(confidence) : 0.72,
      0.72
    );
    // If this fact supersedes an older one (reflection merge), update in-place.
    const normalizedSupersedesText = supersedesFactText
      ? String(supersedesFactText || "").replace(/\s+/g, " ").trim()
      : null;
    let supersededFact = null;
    if (normalizedSupersedesText && normalizedSupersedesText !== factText) {
      supersededFact = this.store.getMemoryFactBySubjectAndFact?.(
        scopeGuildId,
        subject,
        normalizedSupersedesText
      ) || null;
      if (supersededFact && typeof this.store.updateMemoryFact === "function") {
        const updateResult = this.store.updateMemoryFact({
          guildId: scopeGuildId,
          factId: supersededFact.id,
          subject,
          fact: factText,
          factType: normalizedFactType,
          evidenceText: normalizedEvidenceText,
          confidence: Math.max(normalizedConfidence, Number(supersededFact.confidence || 0))
        });
        if (updateResult?.ok) {
          const updatedRow = updateResult.row || this.store.getMemoryFactBySubjectAndFact(scopeGuildId, subject, factText);
          this.store.logAction({
            kind: "memory_fact",
            guildId: scopeGuildId,
            channelId: channelId ? String(channelId) : null,
            userId,
            messageId: sourceMessageId,
            content: factText,
            metadata: {
              actorName: userId ? String(userId) : null,
              factId: Number(updatedRow?.id || supersededFact.id || 0) || null,
              subject,
              fact: factText,
              factType: normalizedFactType,
              confidence: Number(updatedRow?.confidence ?? normalizedConfidence),
              evidenceText: normalizedEvidenceText,
              source: scopeConfig.traceSource,
              reason: "merged_superseded",
              supersededFact: normalizedSupersedesText,
              scope: scopeConfig.scope,
              channelId: channelId ? String(channelId) : null,
              sourceMessageId
            }
          });
          if (updatedRow) {
            void this.ensureFactVector({
              factRow: updatedRow,
              settings: null,
              trace: { userId, source: scopeConfig.traceSource }
            });
          }
          this.queueMemoryRefresh();
          return {
            ok: true,
            reason: "merged_superseded",
            factText,
            scope: scopeConfig.scope,
            subject,
            factType: normalizedFactType,
            isNew: false
          };
        }
        // If update failed (e.g. duplicate), fall through to normal insert path.
      }
    }

    const existingFact = this.store.getMemoryFactBySubjectAndFact(scopeGuildId, subject, factText);
    const inserted = this.store.addMemoryFact({
      guildId: scopeGuildId,
      channelId: channelId ? String(channelId) : null,
      subject,
      fact: factText,
      factType: normalizedFactType,
      evidenceText: normalizedEvidenceText,
      sourceMessageId,
      confidence: normalizedConfidence
    });

    if (!inserted) {
      return {
        ok: false,
        reason: "store_rejected",
        factText,
        scope: scopeConfig.scope,
        subject
      };
    }

    const factRow = this.store.getMemoryFactBySubjectAndFact(scopeGuildId, subject, factText);
    this.store.logAction({
      kind: "memory_fact",
      guildId: scopeGuildId,
      channelId: channelId ? String(channelId) : null,
      userId,
      messageId: sourceMessageId,
      content: factText,
      metadata: {
        actorName: userId ? String(userId) : null,
        factId: Number(factRow?.id || existingFact?.id || 0) || null,
        subject,
        fact: factText,
        factType: normalizedFactType,
        confidence: Number(factRow?.confidence ?? existingFact?.confidence ?? normalizedConfidence),
        evidenceText: normalizedEvidenceText,
        source: scopeConfig.traceSource,
        reason: existingFact ? "updated_existing" : "added_new",
        scope: scopeConfig.scope,
        channelId: channelId ? String(channelId) : null,
        sourceMessageId
      }
    });
    this.store.archiveOldFactsForSubject({
      guildId: scopeGuildId,
      subject,
      keep: scopeConfig.keep
    });

    if (factRow) {
      void this.ensureFactVector({
        factRow,
        settings: null,
        trace: {
          userId,
          source: scopeConfig.traceSource
        }
      });
    }
    this.queueMemoryRefresh();
    return {
      ok: true,
      reason: existingFact ? "updated_existing" : "added_new",
      factText,
      scope: scopeConfig.scope,
      subject,
      factType: normalizedFactType,
      isNew: !existingFact
    };
  }

  async rememberDirectiveLine(args) {
    const result = await this.rememberDirectiveLineDetailed(args);
    return Boolean(result?.ok);
  }

  async appendDailyLogEntry({ messageId = "", authorId, authorName, guildId = "", channelId = "", content, isVoice = false }) {
    const now = new Date();
    const dateKey = formatDateLocal(now);
    const dailyFilePath = path.join(this.memoryDirPath, `${dateKey}.md`);
    const safeAuthorName = sanitizeInline(authorName || "unknown", 80);
    const safeAuthorId = sanitizeInline(authorId || "unknown", 40);
    const safeMessageId = sanitizeInline(messageId || "", 40);
    const safeGuildId = sanitizeInline(guildId || "", 40);
    const safeChannelId = sanitizeInline(channelId || "", 40);
    const scopeFragment = [
      safeGuildId ? `guild:${safeGuildId}` : "",
      safeChannelId ? `channel:${safeChannelId}` : "",
      safeMessageId ? `message:${safeMessageId}` : "",
      isVoice ? "voice" : ""
    ]
      .filter(Boolean)
      .join(" ");
    const scopedContent = scopeFragment ? `[${scopeFragment}] ${content}` : content;
    const line = `- ${now.toISOString()} | ${safeAuthorName} (${safeAuthorId}) | ${scopedContent}`;

    await fs.mkdir(this.memoryDirPath, { recursive: true });
    await this.ensureDailyLogHeader(dailyFilePath, dateKey);
    if (safeMessageId) {
      const knownMessageIds = await this.getDailyLogMessageIds(dailyFilePath);
      if (knownMessageIds.has(safeMessageId)) return;
      await fs.appendFile(dailyFilePath, `${line}\n`, "utf8");
      knownMessageIds.add(safeMessageId);
      return;
    }
    await fs.appendFile(dailyFilePath, `${line}\n`, "utf8");
  }

  clearScheduledTextMicroReflectionsForGuild(guildId: string) {
    const normalizedGuildId = String(guildId || "").trim();
    if (!normalizedGuildId) return;

    for (const [key, timer] of this.textMicroReflectionTimers.entries()) {
      if (!String(key || "").startsWith(`${normalizedGuildId}:`)) continue;
      clearTimeout(timer);
      this.textMicroReflectionTimers.delete(key);
    }

    for (const key of this.textMicroReflectionState.keys()) {
      if (String(key || "").startsWith(`${normalizedGuildId}:`)) {
        this.textMicroReflectionState.delete(key);
      }
    }
  }

  async waitForGuildMicroReflectionsToSettle(guildId: string, timeoutMs = 8_000) {
    const normalizedGuildId = String(guildId || "").trim();
    if (!normalizedGuildId) return;

    const deadline = Date.now() + Math.max(100, Number(timeoutMs) || 8_000);
    while (Date.now() < deadline) {
      let hasInFlight = false;
      for (const key of this.microReflectionInFlight) {
        if (
          String(key || "").startsWith(`text:${normalizedGuildId}:`) ||
          String(key || "").startsWith(`voice:${normalizedGuildId}:`)
        ) {
          hasInFlight = true;
          break;
        }
      }
      if (!hasInFlight) return;
      await sleep(25);
    }
  }

  async getDailyLogMessageIds(dailyFilePath) {
    const cacheKey = String(dailyFilePath || "").trim();
    if (!cacheKey) return new Set();
    const cached = this.dailyLogMessageIds.get(cacheKey);
    if (cached) return cached;

    const messageIds = new Set();
    try {
      const existing = await fs.readFile(cacheKey, "utf8");
      for (const line of existing.split("\n")) {
        const match = line.match(/\bmessage:([^\]\s]+)/u);
        if (match?.[1]) {
          messageIds.add(String(match[1]).trim());
        }
      }
    } catch {
      // Ignore missing/unreadable daily file and bootstrap with an empty index.
    }
    this.dailyLogMessageIds.set(cacheKey, messageIds);
    return messageIds;
  }

  async ensureDailyLogHeader(dailyFilePath, dateKey) {
    if (this.initializedDailyFiles.has(dailyFilePath)) return;

    try {
      await fs.access(dailyFilePath);
    } catch {
      const header = [
        `# Daily Memory Log ${dateKey}`,
        "",
        "- Append-only chat journal used to distill `memory/MEMORY.md`.",
        "",
        "## Entries",
        ""
      ].join("\n");

      try {
        await fs.writeFile(dailyFilePath, header, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }

    this.initializedDailyFiles.add(dailyFilePath);
  }

  async purgeGuildEntriesFromDailyLogs(guildId: string) {
    const normalizedGuildId = String(guildId || "").trim();
    if (!normalizedGuildId) {
      return {
        entriesDeleted: 0,
        filesTouched: 0
      };
    }

    let dailyFileNames: string[] = [];
    try {
      dailyFileNames = (await fs.readdir(this.memoryDirPath))
        .filter((name) => DAILY_FILE_PATTERN.test(name))
        .sort();
    } catch {
      return {
        entriesDeleted: 0,
        filesTouched: 0
      };
    }

    let entriesDeleted = 0;
    let filesTouched = 0;
    for (const fileName of dailyFileNames) {
      const dailyFilePath = path.join(this.memoryDirPath, fileName);
      let text = "";
      try {
        text = await fs.readFile(dailyFilePath, "utf8");
      } catch {
        continue;
      }

      const lines = text.split("\n");
      const keptLines: string[] = [];
      let fileRemovedCount = 0;
      for (const line of lines) {
        const parsed = parseDailyEntryLineWithScope(line);
        if (parsed && String(parsed.guildId || "").trim() === normalizedGuildId) {
          fileRemovedCount += 1;
          continue;
        }
        keptLines.push(line);
      }

      if (!fileRemovedCount) continue;

      while (keptLines.length > 0 && keptLines[keptLines.length - 1] === "") {
        keptLines.pop();
      }
      await fs.writeFile(dailyFilePath, `${keptLines.join("\n")}\n`, "utf8");
      this.dailyLogMessageIds.delete(dailyFilePath);
      this.initializedDailyFiles.add(dailyFilePath);
      entriesDeleted += fileRemovedCount;
      filesTouched += 1;
    }

    return {
      entriesDeleted,
      filesTouched
    };
  }

  async getRecentDailyFiles(limit = 5) {
    try {
      const entries = await fs.readdir(this.memoryDirPath);
      return entries
        .filter((name) => DAILY_FILE_PATTERN.test(name))
        .sort()
        .reverse()
        .slice(0, Math.max(1, limit))
        .map((name) => path.join(this.memoryDirPath, name));
    } catch {
      return [];
    }
  }

  async getRecentDailyEntries({ days = 3, maxEntries = 120, guildId = null } = {}) {
    const files = await this.getRecentDailyFiles(days);
    const normalizedGuildId = String(guildId || "").trim() || null;
    const entries = [];

    for (const filePath of files) {
      let text = "";
      try {
        text = await fs.readFile(filePath, "utf8");
      } catch {
        continue;
      }

      for (const line of text.split("\n")) {
        const parsed = parseDailyEntryLineWithScope(line);
        if (!parsed) continue;
        if (normalizedGuildId && String(parsed.guildId || "").trim() !== normalizedGuildId) continue;
        entries.push({
          author: parsed.author,
          text: parsed.content,
          timestampMs: parsed.timestampMs
        });
      }
    }

    entries.sort((a, b) => b.timestampMs - a.timestampMs);
    return entries.slice(0, Math.max(1, maxEntries));
  }

  logMemoryError(scope, error, metadata = null) {
    try {
      this.store.logAction({
        kind: "bot_error",
        content: `memory_${scope}: ${String(error?.message || error)}`,
        metadata
      });
    } catch {
      // Avoid cascading failures while handling memory errors.
    }
  }

  async runDailyReflection(settings) {
    if (!settings?.memory?.enabled || !settings?.memory?.reflection?.enabled) return;
    return await runDailyReflection({
      memory: this,
      store: this.store,
      llm: this.llm,
      settings
    });
  }
}


export const __memoryTestables = {
  computeChannelScopeScore,
  computeTemporalDecayMultiplier,
  passesHybridRelevanceGate,
  rerankWithMmr,
  isInstructionLikeFactText
};
