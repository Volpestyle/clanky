import fs from "node:fs/promises";
import path from "node:path";
import { clamp01, clampInt } from "./normalization/numbers.ts";
import { sleepMs } from "./normalization/time.ts";
import {
  LORE_SUBJECT,
  SELF_SUBJECT,
  buildFactEmbeddingPayload,
  buildHighlightsSection,
  cleanDailyEntryContent,
  computeChannelScopeScore,
  computeLexicalFactScore,
  computeRecencyScore,
  extractStableTokens,
  formatDateLocal,
  formatTypedFactForMemory,
  isInstructionLikeFactText,
  isTextGroundedInSource,
  normalizeEvidenceText,
  normalizeHighlightText,
  normalizeLoreFactForDisplay,
  normalizeMemoryLineInput,
  normalizeQueryEmbeddingText,
  normalizeSelfFactForDisplay,
  parseDailyEntryLine,
  passesHybridRelevanceGate,
  resolveDirectiveScopeConfig,
  sanitizeInline,
} from "./memory/memoryHelpers.ts";
import { runDailyReflection, rerunDailyReflectionForDateGuild } from "./memory/dailyReflection.ts";

const DAILY_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.md$/;
const HYBRID_FACT_LIMIT = 10;
const HYBRID_CANDIDATE_MULTIPLIER = 6;
const HYBRID_MAX_CANDIDATES = 90;
const HYBRID_MAX_VECTOR_BACKFILL_PER_QUERY = 8;
const QUERY_EMBEDDING_CACHE_TTL_MS = 60 * 1000;
const QUERY_EMBEDDING_CACHE_MAX_ENTRIES = 256;
const FACT_RETENTION_DEFAULT = 80;
const FACT_RETENTION_SELF_LORE = 120;
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
  }

  async ingestMessage({
    messageId,
    authorId,
    authorName,
    content,
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
      settings,
      trace,
      resolve: resolveJob,
      promise
    };
    this.ingestQueue.push(job);
    this.ingestQueuedJobs.set(normalizedMessageId, job);
    this.runIngestWorker().catch(() => undefined);
    return promise;
  }

  recordVoiceTranscriptMessage({
    messageId,
    authorId,
    authorName,
    content,
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
        isBot: false,
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
    trace = { guildId: null, channelId: null, userId: null, source: null }
  }) {
    const cleanedContent = cleanDailyEntryContent(content);
    if (!cleanedContent) return;
    const scopeGuildId = String(trace?.guildId || "").trim();
    const scopeChannelId = String(trace?.channelId || "").trim();

    try {
      await this.appendDailyLogEntry({
        messageId,
        authorId,
        authorName,
        guildId: scopeGuildId,
        channelId: scopeChannelId,
        content: cleanedContent
      });
      this.queueMemoryRefresh();
    } catch (error) {
      this.logMemoryError("daily_log_write", error, { messageId, userId: authorId });
    }
  }

  resolveSubjectRetentionLimit(subject) {
    const normalizedSubject = String(subject || "").trim();
    if (!normalizedSubject) return FACT_RETENTION_DEFAULT;
    if (normalizedSubject === SELF_SUBJECT || normalizedSubject === LORE_SUBJECT) {
      return FACT_RETENTION_SELF_LORE;
    }
    return FACT_RETENTION_DEFAULT;
  }

  async drainIngestQueue({ timeoutMs = 5000 } = {}) {
    const timeout = Math.max(100, Number(timeoutMs) || 5000);
    const deadline = Date.now() + timeout;
    while ((this.ingestWorkerActive || this.ingestQueue.length) && Date.now() < deadline) {
      await sleepMs(25);
    }
  }

  async buildPromptMemorySlice({ userId, guildId, channelId, queryText, settings, trace = {} }) {
    const scopeGuildId = String(guildId || "").trim();
    if (!scopeGuildId) {
      return {
        userFacts: [],
        relevantFacts: [],
        relevantMessages: []
      };
    }

    const userFacts = await this.selectHybridFacts({
      subjects: [userId],
      guildId: scopeGuildId,
      channelId,
      queryText,
      settings,
      trace,
      limit: 8
    });
    const relevantFacts = await this.selectHybridFacts({
      subjects: [userId, SELF_SUBJECT, LORE_SUBJECT],
      guildId: scopeGuildId,
      channelId,
      queryText,
      settings,
      trace,
      limit: HYBRID_FACT_LIMIT
    });
    const relevantMessages = channelId ? this.store.searchRelevantMessages(channelId, queryText, 8) : [];

    return {
      userFacts,
      relevantFacts,
      relevantMessages
    };
  }

  async searchDurableFacts({
    guildId,
    channelId = null,
    queryText,
    settings,
    trace = {},
    limit = HYBRID_FACT_LIMIT
  }) {
    const scopeGuildId = String(guildId || "").trim();
    if (!scopeGuildId) return [];

    const isFullMemoryQuery = queryText === "__ALL__";
    const boundedLimit = isFullMemoryQuery ? clampInt(limit, 1, 100) : clampInt(limit, 1, 24);
    const candidateLimit = Math.min(
      HYBRID_MAX_CANDIDATES * 2,
      Math.max(boundedLimit * HYBRID_CANDIDATE_MULTIPLIER * 2, boundedLimit)
    );
    const candidates = this.store.getFactsForScope({
      guildId: scopeGuildId,
      limit: candidateLimit
    });
    if (!candidates.length) return [];

    if (isFullMemoryQuery) {
      return candidates.slice(0, boundedLimit).map((row) => ({
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

    const ranked = await this.rankHybridCandidates({
      candidates,
      queryText,
      settings,
      trace,
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

  async selectHybridFacts({ subjects, guildId, channelId, queryText, settings, trace = {}, limit = HYBRID_FACT_LIMIT }) {
    const normalizedSubjects = [...new Set((subjects || []).map((value) => String(value || "").trim()).filter(Boolean))];
    if (!normalizedSubjects.length) return [];
    const scopeGuildId = String(guildId || "").trim();
    if (!scopeGuildId) return [];

    const boundedLimit = clampInt(limit, 1, 24);
    const candidateLimit = Math.min(
      HYBRID_MAX_CANDIDATES,
      Math.max(boundedLimit * HYBRID_CANDIDATE_MULTIPLIER, boundedLimit)
    );
    const candidates = this.store.getFactsForSubjects(normalizedSubjects, candidateLimit, {
      guildId: scopeGuildId
    });
    if (!candidates.length) return [];

    const ranked = await this.rankHybridCandidates({
      candidates,
      queryText,
      settings,
      trace,
      channelId
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

      return {
        ...row,
        _score: Number(combined.toFixed(6)),
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
    if (filtered.length) return filtered;
    if (requireRelevanceGate) return [];
    return sorted;
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
          source: "memory_query"
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
    const peopleSection = this.buildPeopleSection();
    const selfSection = this.buildSelfSection(6);
    const recentDailyEntries = await this.getRecentDailyEntries({ days: 3, maxEntries: 120 });
    const highlightsSection = buildHighlightsSection(recentDailyEntries, 24);
    const loreSection = this.buildLoreSection(6);
    const dailyFiles = await this.getRecentDailyFiles(5);
    const dailyFilesLine = dailyFiles.length
      ? dailyFiles.map((filePath) => `memory/${path.basename(filePath)}`).join(", ")
      : "(No daily files yet.)";

    const markdown = [
      "# Durable Memory Snapshot",
      "",
      "_Operator-facing summary. Runtime prompts use indexed durable facts + retrieval, not this markdown file directly._",
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
      `- Recent files: ${dailyFilesLine}`
    ].join("\n");

    await fs.mkdir(this.memoryDirPath, { recursive: true });
    await fs.writeFile(this.memoryFilePath, markdown, "utf8");
  }

  async readMemoryMarkdown() {
    try {
      return await fs.readFile(this.memoryFilePath, "utf8");
    } catch {
      return "# Memory\n\n(no memory file yet)";
    }
  }

  buildPeopleSection() {
    const subjects = this.store
      .getMemorySubjects(80)
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
      ].slice(0, 6);
      if (!cleaned.length) continue;
      const scopeLabel = subjectRow.guild_id ? `[guild:${subjectRow.guild_id}] ` : "";
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
        perSubjectLimit: 6,
        totalLimit: Math.min(1200, Math.max(200, subjectIds.length * 10))
      });

      for (const row of rows) {
        const scopedGuildId = String(row?.guild_id || "").trim();
        const scopedSubjectId = String(row?.subject || "").trim();
        if (!scopedGuildId || !scopedSubjectId) continue;
        const scopedSubjectKey = `${scopedGuildId}::${scopedSubjectId}`;
        const existing = factsByScopedSubject.get(scopedSubjectKey) || [];
        if (existing.length >= 6) continue;
        existing.push(row);
        factsByScopedSubject.set(scopedSubjectKey, existing);
      }
    }

    return factsByScopedSubject;
  }

  buildSelfSection(maxItems = 6) {
    const rows = this.store.getFactsForSubjectScoped(SELF_SUBJECT, 32, null);
    const durableSelfLines = [];
    const seen = new Set();
    for (const row of rows) {
      const normalized = normalizeSelfFactForDisplay(row.fact);
      if (!normalized) continue;
      const key = `${row.guild_id || ""}:${normalized.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const scopeLabel = row.guild_id ? `[guild:${row.guild_id}] ` : "";
      durableSelfLines.push(`- ${scopeLabel}${normalized}`);
    }
    return durableSelfLines.slice(0, Math.max(1, maxItems));
  }

  buildLoreSection(maxItems = 6) {
    const rows = this.store.getFactsForSubjectScoped(LORE_SUBJECT, 32, null);
    const durableLoreLines = [];
    const seen = new Set();
    for (const row of rows) {
      const normalized = normalizeLoreFactForDisplay(row.fact);
      if (!normalized) continue;
      const key = `${row.guild_id || ""}:${normalized.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const scopeLabel = row.guild_id ? `[guild:${row.guild_id}] ` : "";
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
    validationMode = "strict"
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
    if (normalizedValidationMode === "strict" && isInstructionLikeFactText(cleaned)) {
      return {
        ok: false,
        reason: "instruction_like"
      };
    }
    if (normalizedValidationMode === "strict" && !isTextGroundedInSource(cleaned, sourceText)) {
      return {
        ok: false,
        reason: "not_grounded_in_source"
      };
    }

    const factText = `${scopeConfig.prefix}: ${cleaned}.`;
    const existingFact = this.store.getMemoryFactBySubjectAndFact(scopeGuildId, subject, factText);
    const inserted = this.store.addMemoryFact({
      guildId: scopeGuildId,
      channelId: channelId ? String(channelId) : null,
      subject,
      fact: factText,
      factType: scopeConfig.factType,
      evidenceText: normalizeEvidenceText(sourceText, sourceText),
      sourceMessageId,
      confidence: 0.72
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

    this.store.logAction({
      kind: "memory_fact",
      userId,
      messageId: sourceMessageId,
      content: factText
    });
    this.store.archiveOldFactsForSubject({
      guildId: scopeGuildId,
      subject,
      keep: scopeConfig.keep
    });

    const factRow = this.store.getMemoryFactBySubjectAndFact(scopeGuildId, subject, factText);
    if (factRow) {
      this.ensureFactVector({
        factRow,
        settings: null,
        trace: {
          userId,
          source: scopeConfig.traceSource
        }
      }).catch(() => undefined);
    }
    this.queueMemoryRefresh();
    return {
      ok: true,
      reason: existingFact ? "updated_existing" : "added_new",
      factText,
      scope: scopeConfig.scope,
      subject,
      factType: scopeConfig.factType,
      isNew: !existingFact
    };
  }

  async rememberDirectiveLine(args) {
    const result = await this.rememberDirectiveLineDetailed(args);
    return Boolean(result?.ok);
  }

  async appendDailyLogEntry({ messageId = "", authorId, authorName, guildId = "", channelId = "", content }) {
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
      safeMessageId ? `message:${safeMessageId}` : ""
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

  async getRecentDailyEntries({ days = 3, maxEntries = 120 } = {}) {
    const files = await this.getRecentDailyFiles(days);
    const entries = [];

    for (const filePath of files) {
      let text = "";
      try {
        text = await fs.readFile(filePath, "utf8");
      } catch {
        continue;
      }

      for (const line of text.split("\n")) {
        const parsed = parseDailyEntryLine(line);
        if (parsed) entries.push(parsed);
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

  async rerunDailyReflection({ dateKey, guildId, settings = null }) {
    const resolvedSettings = settings || this.store.getSettings();
    return await rerunDailyReflectionForDateGuild({
      memory: this,
      store: this.store,
      llm: this.llm,
      settings: resolvedSettings,
      dateKey,
      guildId
    });
  }
}


export const __memoryTestables = {
  computeChannelScopeScore,
  passesHybridRelevanceGate,
  isInstructionLikeFactText,
  isTextGroundedInSource
};
