// Extracted Store Methods
import { clamp } from "../utils.ts";
import { safeJsonParse } from "../normalization/valueParsers.ts";
import { pushPerformanceMetric, summarizeLatencyMetric } from "./storePerformance.ts";

export function getReplyPerformanceStats(store: any, { windowHours = 24, maxSamples = 4000 } = {}) {
const boundedHours = clamp(Math.floor(Number(windowHours) || 24), 1, 168);
const boundedSamples = clamp(Math.floor(Number(maxSamples) || 4000), 100, 20000);
const sinceIso = new Date(Date.now() - boundedHours * 60 * 60 * 1000).toISOString();

const rows = store.db
  .prepare(
    `SELECT kind, metadata
         FROM actions
         WHERE created_at >= ?
           AND kind IN ('sent_reply', 'sent_message', 'reply_skipped')
         ORDER BY id DESC
         LIMIT ?`
  )
  .all(sinceIso, boundedSamples);

const byKind = {
  sent_reply: 0,
  sent_message: 0,
  reply_skipped: 0
};
const totalMsValues = [];
const processingMsValues = [];
const queueMsValues = [];
const ingestMsValues = [];
const memorySliceMsValues = [];
const llm1MsValues = [];
const followupMsValues = [];
const typingDelayMsValues = [];
const sendMsValues = [];

for (const row of rows) {
  const metadata = safeJsonParse(row?.metadata, null);
  const performance = metadata?.performance;
  if (!performance || typeof performance !== "object") continue;

  const kind = String(row?.kind || "");
  if (kind in byKind) byKind[kind] += 1;

  pushPerformanceMetric(totalMsValues, performance.totalMs);
  pushPerformanceMetric(processingMsValues, performance.processingMs);
  pushPerformanceMetric(queueMsValues, performance.queueMs);
  pushPerformanceMetric(ingestMsValues, performance.ingestMs);
  pushPerformanceMetric(memorySliceMsValues, performance.memorySliceMs);
  pushPerformanceMetric(llm1MsValues, performance.llm1Ms);
  pushPerformanceMetric(followupMsValues, performance.followupMs);
  pushPerformanceMetric(typingDelayMsValues, performance.typingDelayMs);
  pushPerformanceMetric(sendMsValues, performance.sendMs);
}

return {
  windowHours: boundedHours,
  sampleLimit: boundedSamples,
  sampleCount: totalMsValues.length,
  byKind,
  totalMs: summarizeLatencyMetric(totalMsValues),
  processingMs: summarizeLatencyMetric(processingMsValues),
  phases: {
    queueMs: summarizeLatencyMetric(queueMsValues),
    ingestMs: summarizeLatencyMetric(ingestMsValues),
    memorySliceMs: summarizeLatencyMetric(memorySliceMsValues),
    llm1Ms: summarizeLatencyMetric(llm1MsValues),
    followupMs: summarizeLatencyMetric(followupMsValues),
    typingDelayMs: summarizeLatencyMetric(typingDelayMsValues),
    sendMs: summarizeLatencyMetric(sendMsValues)
  }
};
}

export function getStats(store: any) {
const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

const rows = store.db
  .prepare(
    `SELECT kind, COUNT(*) AS count
         FROM actions
         WHERE created_at >= ?
         GROUP BY kind`
  )
  .all(since24h);

const totalCostRow = store.db
  .prepare(
    `SELECT COALESCE(SUM(usd_cost), 0) AS total
         FROM actions`
  )
  .get();

const dayCostRows = store.db
  .prepare(
    `SELECT substr(created_at, 1, 10) AS day, COALESCE(SUM(usd_cost), 0) AS usd
         FROM actions
         WHERE created_at >= ?
         GROUP BY day
         ORDER BY day DESC
         LIMIT 14`
  )
  .all(new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString());

const out = {
  last24h: {
    sent_reply: 0,
    sent_message: 0,
    initiative_post: 0,
    reacted: 0,
    llm_call: 0,
    image_call: 0,
    gif_call: 0,
    search_call: 0,
    video_context_call: 0,
    asr_call: 0,
    voice_session_start: 0,
    voice_session_end: 0,
    voice_intent_detected: 0,
    voice_turn_in: 0,
    voice_turn_out: 0,
    voice_soundboard_play: 0,
    voice_error: 0
  },
  totalCostUsd: Number(totalCostRow?.total ?? 0),
  dailyCost: dayCostRows,
  performance: store.getReplyPerformanceStats({
    windowHours: 24,
    maxSamples: 4000
  })
};

for (const row of rows) {
  if (row.kind in out.last24h) {
    out.last24h[row.kind] = Number(row.count ?? 0);
  }
}

return out;
}
