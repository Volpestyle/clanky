export const LOOKUP_CONTEXT_MAX_ROWS_PER_CHANNEL_DEFAULT = 120;
export const LOOKUP_CONTEXT_MAX_RESULTS_DEFAULT = 5;
import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { clamp, nowIso } from "../utils.ts";
import { normalizeSettings } from "./settingsNormalization.ts";
import {
  rewriteRuntimeSettingsRow,
  getSettings,
  getSettingsRecord,
  setSettings,
  patchSettings,
  resetSettings
} from "./storeSettings.ts";
import {
  recordMessage,
  getRecentMessages,
  getRecentMessagesAcrossGuild,
  getMessagesInWindow,
  searchRelevantMessages,
  searchConversationWindows,
  searchConversationWindowsByEmbedding,
  getActiveChannels,
  getReferencedMessageStats,
  upsertMessageVectorNative
} from "./storeMessages.ts";
import { maybePruneActionLog, pruneActionLog, logAction, countActionsSince, getLastActionTime, getRecentActions, getRecentMemoryReflections, deleteReflectionRun, getRecentBrowserSessions, indexResponseTriggersForAction, hasTriggeredResponse, hasReflectionBeenCompleted } from "./storeActionLog.ts";
import { wasLinkSharedSince, recordSharedLink, pruneLookupContext, recordLookupContext, searchLookupContext } from "./storeLookups.ts";
import { getRecentVoiceSessions, getVoiceSessionEvents } from "./storeVoice.ts";
import { getReplyPerformanceStats, getStats } from "./storeStats.ts";
import { createAutomation, getAutomationById, countAutomations, listAutomations, getMostRecentAutomations, findAutomationsByQuery, setAutomationStatus, claimDueAutomations, finalizeAutomationRun, recordAutomationRun, getAutomationRuns } from "./storeAutomation.ts";
import { addMemoryFact, getFactProfileRows, getFactsForSubjectScoped, getFactsForSubjects, getFactsForScope, getFactsForSubjectsScoped, getMemoryFactById, getMemoryFactBySubjectAndFact, updateMemoryFact, deleteMemoryFact, ensureSqliteVecReady, upsertMemoryFactVectorNative, getMemoryFactVectorNative, getMemoryFactVectorNativeScores, getMemorySubjects, archiveOldFactsForSubject, searchMemoryFactsLexical, searchMemoryFactsByEmbedding } from "./storeMemory.ts";

export const SETTINGS_KEY = "runtime_settings";
export const ACTION_LOG_RETENTION_DAYS_DEFAULT = 14;
export const ACTION_LOG_RETENTION_DAYS_MIN = 1;
export const ACTION_LOG_RETENTION_DAYS_MAX = 3650;
export const ACTION_LOG_MAX_ROWS_DEFAULT = 120_000;
export const ACTION_LOG_MAX_ROWS_MIN = 1000;
export const ACTION_LOG_MAX_ROWS_RUNTIME_MIN = 1;
export const ACTION_LOG_MAX_ROWS_MAX = 5_000_000;
export const ACTION_LOG_PRUNE_EVERY_WRITES_DEFAULT = 250;
export const ACTION_LOG_PRUNE_EVERY_WRITES_MIN = 1;
export const ACTION_LOG_PRUNE_EVERY_WRITES_MAX = 10_000;

function resolveEnvBoundedInt(rawValue, fallback, min, max) {
  const parsed = Math.floor(Number(rawValue));
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(parsed, min, max);
}

function resolveStoreEnvInt(name, fallback, min, max) {
  return resolveEnvBoundedInt(process.env[name], fallback, min, max);
}


export class Store {
  dbPath;
  db;
  sqliteVecReady;
  sqliteVecError;
  onActionLogged;
  actionLogRetentionDays;
  actionLogMaxRows;
  actionLogPruneEveryWrites;
  actionWritesSincePrune;

  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
    this.sqliteVecReady = null;
    this.sqliteVecError = "";
    this.onActionLogged = null;
    this.actionLogRetentionDays = resolveStoreEnvInt(
      "ACTION_LOG_RETENTION_DAYS",
      ACTION_LOG_RETENTION_DAYS_DEFAULT,
      ACTION_LOG_RETENTION_DAYS_MIN,
      ACTION_LOG_RETENTION_DAYS_MAX
    );
    this.actionLogMaxRows = resolveStoreEnvInt(
      "ACTION_LOG_MAX_ROWS",
      ACTION_LOG_MAX_ROWS_DEFAULT,
      ACTION_LOG_MAX_ROWS_MIN,
      ACTION_LOG_MAX_ROWS_MAX
    );
    this.actionLogPruneEveryWrites = resolveStoreEnvInt(
      "ACTION_LOG_PRUNE_EVERY_WRITES",
      ACTION_LOG_PRUNE_EVERY_WRITES_DEFAULT,
      ACTION_LOG_PRUNE_EVERY_WRITES_MIN,
      ACTION_LOG_PRUNE_EVERY_WRITES_MAX
    );
    this.actionWritesSincePrune = 0;
  }

  init() {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        guild_id TEXT,
        channel_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        is_bot INTEGER NOT NULL,
        content TEXT NOT NULL,
        referenced_message_id TEXT
      );

      CREATE TABLE IF NOT EXISTS actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        guild_id TEXT,
        channel_id TEXT,
        message_id TEXT,
        user_id TEXT,
        kind TEXT NOT NULL,
        content TEXT,
        metadata TEXT,
        usd_cost REAL NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS memory_facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        channel_id TEXT,
        subject TEXT NOT NULL,
        fact TEXT NOT NULL,
        fact_type TEXT NOT NULL DEFAULT 'other',
        evidence_text TEXT,
        source_message_id TEXT,
        confidence REAL NOT NULL DEFAULT 0.5,
        is_active INTEGER NOT NULL DEFAULT 1,
        UNIQUE(guild_id, subject, fact)
      );

      CREATE TABLE IF NOT EXISTS memory_fact_vectors_native (
        fact_id INTEGER NOT NULL,
        model TEXT NOT NULL,
        dims INTEGER NOT NULL,
        embedding_blob BLOB NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (fact_id, model)
      );

      CREATE TABLE IF NOT EXISTS message_vectors_native (
        message_id TEXT NOT NULL,
        model TEXT NOT NULL,
        dims INTEGER NOT NULL,
        embedding_blob BLOB NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (message_id, model)
      );

      CREATE TABLE IF NOT EXISTS shared_links (
        url TEXT PRIMARY KEY,
        first_shared_at TEXT NOT NULL,
        last_shared_at TEXT NOT NULL,
        share_count INTEGER NOT NULL DEFAULT 1,
        source TEXT
      );

      CREATE TABLE IF NOT EXISTS lookup_context (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        channel_id TEXT,
        user_id TEXT,
        source TEXT,
        query TEXT NOT NULL,
        provider TEXT,
        results_json TEXT NOT NULL,
        match_text TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS automations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        created_by_user_id TEXT NOT NULL,
        created_by_name TEXT,
        title TEXT NOT NULL,
        instruction TEXT NOT NULL,
        schedule_json TEXT NOT NULL,
        next_run_at TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        is_running INTEGER NOT NULL DEFAULT 0,
        running_started_at TEXT,
        last_run_at TEXT,
        last_error TEXT,
        last_result TEXT,
        match_text TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS automation_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        automation_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        summary TEXT,
        error TEXT,
        message_id TEXT,
        metadata TEXT
      );

      CREATE TABLE IF NOT EXISTS response_triggers (
        trigger_message_id TEXT PRIMARY KEY,
        action_id INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_channel_time ON messages(channel_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_guild_time ON messages(guild_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_actions_kind_time ON actions(kind, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_actions_time ON actions(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_vectors_native_model_dims ON memory_fact_vectors_native(model, dims);
      CREATE INDEX IF NOT EXISTS idx_message_vectors_native_model_dims ON message_vectors_native(model, dims);
      CREATE INDEX IF NOT EXISTS idx_shared_links_last_shared_at ON shared_links(last_shared_at DESC);
      CREATE INDEX IF NOT EXISTS idx_lookup_context_scope_time ON lookup_context(guild_id, channel_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_lookup_context_expires ON lookup_context(expires_at);
      CREATE INDEX IF NOT EXISTS idx_automations_scope_status_next ON automations(guild_id, status, next_run_at);
      CREATE INDEX IF NOT EXISTS idx_automations_running_next ON automations(is_running, next_run_at);
      CREATE INDEX IF NOT EXISTS idx_automations_match_text ON automations(guild_id, match_text);
      CREATE INDEX IF NOT EXISTS idx_automation_runs_job_time ON automation_runs(automation_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_response_triggers_action_id ON response_triggers(action_id);
    `);
    this.ensureSqliteVecReady();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_scope_subject ON memory_facts(guild_id, subject, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_scope_channel ON memory_facts(guild_id, channel_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_scope_subject_type ON memory_facts(guild_id, subject, fact_type, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_scope_active ON memory_facts(guild_id, is_active, created_at DESC);
    `);

    if (!this.db.prepare("SELECT 1 FROM settings WHERE key = ?").get(SETTINGS_KEY)) {
      const defaultSettings = normalizeSettings({});
      this.db
        .prepare("INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?)")
        .run(SETTINGS_KEY, JSON.stringify(defaultSettings), nowIso());
    } else {
      const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(SETTINGS_KEY);
      this.rewriteRuntimeSettingsRow(row?.value);
    }

    this.pruneActionLog({ now: nowIso() });
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  rewriteRuntimeSettingsRow(rawValue) {
    return rewriteRuntimeSettingsRow(this, rawValue);
  }

  getSettings() {
    return getSettings(this);
  }

  getSettingsRecord() {
    return getSettingsRecord(this);
  }

  setSettings(next) {
    return setSettings(this, next);
  }

  patchSettings(patch) {
    return patchSettings(this, patch);
  }

  resetSettings() {
    return resetSettings(this);
  }

  recordMessage(message) {
    return recordMessage(this, message);
  }

  getRecentMessages(channelId, limit = 40) {
    return getRecentMessages(this, channelId, limit);
  }

  getRecentMessagesAcrossGuild(guildId, limit = 120) {
    return getRecentMessagesAcrossGuild(this, guildId, limit);
  }

  getMessagesInWindow(opts: {
    guildId: string;
    channelId?: string | null;
    sinceIso?: string | null;
    untilIso?: string | null;
    limit?: number;
  }) {
    return getMessagesInWindow(this, opts);
  }

  searchRelevantMessages(channelId, queryText, limit = 8) {
    return searchRelevantMessages(this, channelId, queryText, limit);
  }

  searchConversationWindows(opts: {
    guildId;
    channelId?;
    queryText?;
    limit?;
    maxAgeHours?;
    before?;
    after?;
  }) {
    return searchConversationWindows(this, opts);
  }

  searchConversationWindowsByEmbedding(opts: {
    guildId: string;
    channelId?: string | null;
    queryEmbedding: number[];
    model: string;
    limit?: number;
    maxAgeHours?: number;
    before?: number;
    after?: number;
  }) {
    return searchConversationWindowsByEmbedding(this, opts);
  }

  upsertMessageVectorNative(opts: {
    messageId: string;
    model: string;
    embedding: number[];
    updatedAt?: string;
  }) {
    return upsertMessageVectorNative(this, opts);
  }

  getActiveChannels(guildId, hours = 24, limit = 10) {
    return getActiveChannels(this, guildId, hours, limit);
  }

  getReferencedMessageStats({
    messageIds,
    guildId = null,
    sinceIso = null
  }: {
    messageIds: string[];
    guildId?: string | null;
    sinceIso?: string | null;
  }) {
    return getReferencedMessageStats(this, {
      messageIds,
      guildId,
      sinceIso
    });
  }

  maybePruneActionLog(opts: { now?: string } = {}) {
    return maybePruneActionLog(this, opts);
  }

  pruneActionLog(opts: { now?: string; maxAgeDays?: number; maxRows?: number } = {}) {
    return pruneActionLog(this, opts);
  }

  logAction(action) {
    return logAction(this, action);
  }

  countActionsSince(kind, sinceIso) {
    return countActionsSince(this, kind, sinceIso);
  }

  getLastActionTime(kind) {
    return getLastActionTime(this, kind);
  }

  getRecentActions(limit = 200, opts: { kinds?: string[]; sinceIso?: string | null; guildId?: string | null } = {}) {
    return getRecentActions(this, limit, opts);
  }

  getRecentMemoryReflections(limit = 20) {
    return getRecentMemoryReflections(this, limit);
  }

  getRecentBrowserSessions(limit = 50, opts: { sinceIso?: string | null } = {}) {
    return getRecentBrowserSessions(this, limit, opts);
  }

  indexResponseTriggersForAction(opts: {
    actionId;
    kind;
    metadata;
    createdAt?: string;
  }) {
    return indexResponseTriggersForAction(this, opts);
  }

  hasTriggeredResponse(triggerMessageId) {
    return hasTriggeredResponse(this, triggerMessageId);
  }

  hasReflectionBeenCompleted(dateKey: string, guildId: string): boolean {
    return hasReflectionBeenCompleted(this, dateKey, guildId);
  }

  deleteReflectionRun(runId: string): { deleted: number } {
    return deleteReflectionRun(this, runId);
  }

  wasLinkSharedSince(url, sinceIso) {
    return wasLinkSharedSince(this, url, sinceIso);
  }

  recordSharedLink(opts: { url; source? }) {
    return recordSharedLink(this, opts);
  }

  pruneLookupContext(opts: {
    now?: string;
    guildId?: string | null;
    channelId?: string | null;
    maxRowsPerChannel?: number;
  } = {}) {
    return pruneLookupContext(this, opts);
  }

  recordLookupContext(opts: {
    guildId;
    channelId?;
    userId?;
    source?;
    query;
    provider?;
    results?;
    ttlHours?;
    maxResults?;
    maxRowsPerChannel?;
  }) {
    return recordLookupContext(this, opts);
  }

  searchLookupContext(opts: {
    guildId;
    channelId?;
    queryText?;
    limit?;
    maxAgeHours?;
  }) {
    return searchLookupContext(this, opts);
  }

  getRecentVoiceSessions(limit = 3, opts: { sinceIso?: string | null } = {}) {
    return getRecentVoiceSessions(this, limit, opts);
  }

  getVoiceSessionEvents(sessionId: string, limit = 500) {
    return getVoiceSessionEvents(this, sessionId, limit);
  }

  getReplyPerformanceStats(opts: { windowHours?: number; maxSamples?: number } = {}) {
    return getReplyPerformanceStats(this, opts);
  }

  getStats() {
    return getStats(this);
  }

  createAutomation(opts: {
    guildId;
    channelId;
    createdByUserId;
    createdByName?;
    title;
    instruction;
    schedule;
    nextRunAt?;
  }) {
    return createAutomation(this, opts);
  }

  getAutomationById(automationId, guildId = null) {
    return getAutomationById(this, automationId, guildId);
  }

  countAutomations(opts: { guildId; statuses? }) {
    return countAutomations(this, opts);
  }

  listAutomations(opts: {
    guildId;
    channelId?;
    statuses?;
    query?;
    limit?;
  }) {
    return listAutomations(this, opts);
  }

  getMostRecentAutomations(opts: {
    guildId;
    channelId?;
    statuses?;
    limit?;
  }) {
    return getMostRecentAutomations(this, opts);
  }

  findAutomationsByQuery(opts: {
    guildId;
    channelId?;
    query?;
    statuses?;
    limit?;
  }) {
    return findAutomationsByQuery(this, opts);
  }

  setAutomationStatus(opts: {
    automationId;
    guildId;
    status;
    nextRunAt?;
    lastError?;
    lastResult?;
  }) {
    return setAutomationStatus(this, opts);
  }

  claimDueAutomations(opts: { now?: string; limit?: number } = {}) {
    return claimDueAutomations(this, opts);
  }

  finalizeAutomationRun(opts: {
    automationId?: number | string;
    guildId?: string;
    status?: string;
    nextRunAt?: string | null;
    lastRunAt?: string | null;
    lastError?: string | null;
    lastResult?: string | null;
  } = {}) {
    return finalizeAutomationRun(this, opts);
  }

  recordAutomationRun(opts: {
    automationId;
    startedAt?;
    finishedAt?;
    status?;
    summary?;
    error?;
    messageId?;
    metadata?;
  }) {
    return recordAutomationRun(this, opts);
  }

  getAutomationRuns(opts: {
    automationId?: number | string;
    guildId?: string;
    limit?: number;
  } = {}) {
    return getAutomationRuns(this, opts);
  }

  addMemoryFact(fact) {
    return addMemoryFact(this, fact);
  }

  getFactsForSubjectScoped(subject, limit = 12, scope = null) {
    return getFactsForSubjectScoped(this, subject, limit, scope);
  }

  getFactsForSubjects(subjects, limit = 80, scope = null) {
    return getFactsForSubjects(this, subjects, limit, scope);
  }

  getFactProfileRows(opts: { guildId?; subjects?; limit? } = {}) {
    return getFactProfileRows(this, opts);
  }

  getFactsForScope(opts: { guildId; limit?; subjectIds?; factTypes?; queryText? }) {
    return getFactsForScope(this, opts);
  }

  searchMemoryFactsLexical(opts: {
    guildId;
    subjectIds?;
    factTypes?;
    queryText?;
    queryTokens?;
    limit?;
  }) {
    return searchMemoryFactsLexical(this, opts);
  }

  searchMemoryFactsByEmbedding(opts: {
    guildId;
    subjectIds?;
    factTypes?;
    model;
    queryEmbedding;
    limit?;
  }) {
    return searchMemoryFactsByEmbedding(this, opts);
  }

  getFactsForSubjectsScoped(opts: {
    guildId?;
    subjectIds?;
    perSubjectLimit?;
    totalLimit?;
  } = {}) {
    return getFactsForSubjectsScoped(this, opts);
  }

  getMemoryFactBySubjectAndFact(guildId, subject, fact) {
    return getMemoryFactBySubjectAndFact(this, guildId, subject, fact);
  }

  getMemoryFactById(factId, guildId = null) {
    return getMemoryFactById(this, factId, guildId);
  }

  updateMemoryFact(opts: {
    guildId;
    factId;
    subject;
    fact;
    factType?;
    evidenceText?;
    confidence?;
  }) {
    return updateMemoryFact(this, opts);
  }

  deleteMemoryFact(opts: { guildId; factId }) {
    return deleteMemoryFact(this, opts);
  }

  ensureSqliteVecReady() {
    return ensureSqliteVecReady(this);
  }

  upsertMemoryFactVectorNative(opts: { factId; model; embedding; updatedAt? }) {
    return upsertMemoryFactVectorNative(this, opts);
  }

  getMemoryFactVectorNative(factId, model) {
    return getMemoryFactVectorNative(this, factId, model);
  }

  getMemoryFactVectorNativeScores(opts: { factIds; model; queryEmbedding }) {
    return getMemoryFactVectorNativeScores(this, opts);
  }

  getMemorySubjects(limit = 80, scope = null) {
    return getMemorySubjects(this, limit, scope);
  }

  archiveOldFactsForSubject(opts: { guildId; subject; factType?; keep? }) {
    return archiveOldFactsForSubject(this, opts);
  }
}
