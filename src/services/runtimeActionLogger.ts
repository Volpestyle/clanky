import fs from "node:fs";
import path from "node:path";
import { nowIso } from "../utils.ts";
import { appConfig } from "../config.ts";

const MAX_STRING_LENGTH = 50_000;
const MAX_DEPTH = 6;
const MAX_ARRAY_LENGTH = 80;
const MAX_OBJECT_KEYS = 80;
const REDACTED_VALUE = "[REDACTED]";
const OMISSION_VALUE = "[OMITTED]";
const CIRCULAR_VALUE = "[CIRCULAR]";
const TRUNCATED_VALUE = "[TRUNCATED]";
const SENSITIVE_KEY_PATTERN =
  /(api[-_]?key|secret|authorization|password|bearer|private[-_]?key)/i;

// ── ANSI helpers ───────────────────────────────────────────────────────
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";
const WHITE = "\x1b[37m";
const BRIGHT_CYAN = "\x1b[96m";
const BRIGHT_GREEN = "\x1b[92m";
const BG_RED = "\x1b[41m";
const BG_GREEN = "\x1b[42m";
const BG_CYAN = "\x1b[46m";
const BG_MAGENTA = "\x1b[45m";
const BG_YELLOW = "\x1b[43m";
const BG_BLUE = "\x1b[44m";
const BLACK = "\x1b[30m";

const BRIGHT_RED = "\x1b[91m";
const BRIGHT_YELLOW = "\x1b[93m";

const AGENT_STYLES = {
  voice: { bg: BG_CYAN, fg: BLACK },
  bot: { bg: BG_GREEN, fg: BLACK },
  memory: { bg: BG_MAGENTA, fg: BLACK },
  automation: { bg: BG_YELLOW, fg: BLACK },
  discovery: { bg: BG_BLUE, fg: WHITE },
  runtime: { bg: `\x1b[100m`, fg: WHITE } // bright-black bg
};

function formatAgentBadge(agent) {
  const style = AGENT_STYLES[agent] || AGENT_STYLES.runtime;
  const label = ` ${(agent || "runtime").padEnd(10)} `;
  return `${style.bg}${style.fg}${BOLD}${label}${RESET}`;
}

function isSpeechMetadataKey(key) {
  const normalizedKey = String(key || "").trim();
  return normalizedKey === "transcript" || normalizedKey === "replyText" || normalizedKey === "incomingTranscript" || normalizedKey === "heard";
}

function isHighlightedSpeechMetadataKey(key) {
  const normalizedKey = String(key || "").trim();
  return normalizedKey === "transcript" || normalizedKey === "incomingTranscript" || normalizedKey === "heard";
}

function normalizeInlineSpeechValue(value, maxLength = 220) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return truncateString(text, maxLength);
}

function resolveSpeechStyle(_key, metadata) {
  const transcriptSource = isPlainObject(metadata)
    ? String(metadata.transcriptSource || "").trim().toLowerCase()
    : "";

  if (transcriptSource === "output") {
    return {
      label: "said",
      color: BRIGHT_GREEN
    };
  }

  return {
    label: "heard",
    color: BRIGHT_CYAN
  };
}

function formatSpeechInline(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return "";
  const parts = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (!isSpeechMetadataKey(key)) continue;
    const text = normalizeInlineSpeechValue(value);
    if (!text) continue;
    if (key === "replyText") {
      parts.push(`${DIM}replyText${RESET}${DIM}=${RESET}"${text}"`);
      continue;
    }
    if (!isHighlightedSpeechMetadataKey(key)) continue;
    const style = resolveSpeechStyle(key, metadata);
    parts.push(
      `${DIM}${style.label}${RESET}${DIM}=${RESET}${style.color}${BOLD}"${text}"${RESET}`
    );
  }
  return parts.length > 0 ? `  ${parts.join("  ")}` : "";
}

function formatMetadataInline(metadata) {
  if (!metadata || typeof metadata !== "object") return "";
  const entries = Object.entries(metadata);
  if (entries.length === 0) return "";
  const parts = [];
  for (const [k, v] of entries) {
    if (v === null || v === undefined) continue;
    if (isSpeechMetadataKey(k)) continue;
    const val = typeof v === "object" ? JSON.stringify(v) : String(v);
    if (val.length > 80) continue; // skip bulky values
    parts.push(`${DIM}${k}${RESET}${DIM}=${RESET}${val}`);
  }
  return parts.length > 0 ? `  ${parts.join("  ")}` : "";
}

function detectSkipKind(payload) {
  const event = String(payload.event || "").toLowerCase();
  const kind = String(payload.kind || "").toLowerCase();
  const meta = payload.metadata;
  const allow = meta && typeof meta === "object" ? meta.allow : undefined;

  // Classifier / addressing deny — the main "NO" decision
  if (event === "voice_turn_addressing" && allow === false) {
    return "deny";
  }

  // Text reply [SKIP]
  if (kind === "reply_skipped") {
    return "skip";
  }

  // Pre-classifier drops (silence gate, low confidence, hallucination, stale, etc.)
  if (event.includes("dropped") || event.includes("skipped")) {
    return "drop";
  }

  return null;
}

function formatSkipBadge(skipKind) {
  if (skipKind === "deny") {
    return `${BG_RED}${WHITE}${BOLD} ✗ DENIED ${RESET}`;
  }
  if (skipKind === "skip") {
    return `${BG_MAGENTA}${WHITE}${BOLD} ⊘ SKIP ${RESET}`;
  }
  // "drop"
  return `${DIM}${BRIGHT_YELLOW}⊘ DROP${RESET}`;
}

function formatSkipReason(payload, skipKind) {
  const rawMeta = payload.metadata;
  if (!rawMeta || typeof rawMeta !== "object") return "";
  if (skipKind === "deny") {
    const reason = rawMeta.reason || rawMeta.classifierReason || "";
    const classifier = rawMeta.classifierDecision || "";
    const confidence = Number.isFinite(rawMeta.classifierConfidence)
      ? ` conf=${Number(rawMeta.classifierConfidence).toFixed(2)}`
      : "";
    const latency = Number.isFinite(rawMeta.classifierLatencyMs)
      ? ` ${rawMeta.classifierLatencyMs}ms`
      : "";
    const parts = [];
    if (reason) parts.push(`${BRIGHT_RED}${reason}${RESET}`);
    if (classifier) parts.push(`${DIM}decision=${RESET}${classifier}`);
    if (confidence) parts.push(`${DIM}${confidence}${RESET}`);
    if (latency) parts.push(`${DIM}${latency}${RESET}`);
    return parts.length ? `  ${parts.join("  ")}` : "";
  }
  if (skipKind === "skip") {
    const content = String(payload.content || "").trim();
    return content ? `  ${BRIGHT_RED}${content}${RESET}` : "";
  }
  // "drop" — show the drop reason from event name or metadata
  const meta = isPlainObject(payload.metadata) ? payload.metadata : {};
  const skipCause = String(meta.skipCause || meta.reason || "").trim();
  const metrics = [];
  const peak = Number(meta.peak);
  const rms = Number(meta.rms);
  const activeSampleRatio = Number(meta.activeSampleRatio);
  if (Number.isFinite(peak) && peak > 0) {
    metrics.push(`${DIM}peak=${RESET}${peak.toFixed(3)}`);
  }
  if (Number.isFinite(rms) && rms > 0) {
    metrics.push(`${DIM}rms=${RESET}${rms.toFixed(3)}`);
  }
  if (Number.isFinite(activeSampleRatio) && activeSampleRatio > 0) {
    metrics.push(`${DIM}active=${RESET}${activeSampleRatio.toFixed(3)}`);
  }
  const metricsPart = metrics.length > 0 ? `  ${metrics.join("  ")}` : "";
  if (skipCause) {
    return `  ${BRIGHT_YELLOW}${skipCause}${RESET}${metricsPart}`;
  }
  const event = String(payload.event || "");
  const shortReason = event
    .replace(/^voice_turn_dropped_/, "")
    .replace(/^realtime_turn_/, "")
    .replace(/^file_asr_turn_/, "");
  if (shortReason !== event) {
    return `  ${DIM}${shortReason}${RESET}${metricsPart}`;
  }
  return metricsPart;
}

export function formatPrettyLine(payload) {
  const time = (payload.ts || "").slice(11, 19); // HH:MM:SS
  const isError = payload.level === "error";
  const skipKind = detectSkipKind(payload);

  const timePart = `${DIM}${time}${RESET}`;
  const agentPart = formatAgentBadge(payload.agent);
  const eventText = payload.event || payload.kind || "?";

  if (skipKind) {
    const badge = formatSkipBadge(skipKind);
    const speechPart = formatSpeechInline(payload.metadata);
    const reasonPart = formatSkipReason(payload, skipKind);
    const costPart =
      payload.usd_cost > 0
        ? `  ${YELLOW}$${payload.usd_cost.toFixed(4)}${RESET}`
        : "";
    const eventPart = `${DIM}${eventText}${RESET}`;
    return `${timePart} ${agentPart} ${badge} ${eventPart}${speechPart}${reasonPart}${costPart}\n`;
  }

  const eventPart = isError
    ? `${BG_RED}${WHITE}${BOLD} ${eventText} ${RESET}`
    : `${BOLD}${WHITE}${eventText}${RESET}`;
  const speechPart = formatSpeechInline(payload.metadata);
  const metaPart = formatMetadataInline(payload.metadata);
  const costPart =
    payload.usd_cost > 0
      ? `  ${YELLOW}$${payload.usd_cost.toFixed(4)}${RESET}`
      : "";

  return `${timePart} ${agentPart} ${eventPart}${speechPart}${metaPart}${costPart}\n`;
}

function truncateString(value, maxLength = MAX_STRING_LENGTH) {
  const text = String(value ?? "");
  if (!text) return "";
  if (text.length <= maxLength) return text;
  const sliceLength = Math.max(0, maxLength - 1);
  return `${text.slice(0, sliceLength)}…`;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sanitizeValue(value, { depth = 0, keyName = "", seen = new WeakSet() } = {}) {
  if (keyName && SENSITIVE_KEY_PATTERN.test(String(keyName))) {
    return REDACTED_VALUE;
  }

  if (value === null) return null;
  if (value === undefined) return null;

  if (typeof value === "string") {
    return truncateString(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return {
      name: truncateString(value.name || "Error", 120),
      message: truncateString(value.message || "", 300),
      stack: truncateString(value.stack || "", 3_000)
    };
  }

  if (depth >= MAX_DEPTH) {
    return OMISSION_VALUE;
  }

  if (Array.isArray(value)) {
    const output = [];
    const boundedLength = Math.min(value.length, MAX_ARRAY_LENGTH);
    for (let i = 0; i < boundedLength; i += 1) {
      output.push(
        sanitizeValue(value[i], {
          depth: depth + 1,
          keyName,
          seen
        })
      );
    }
    if (value.length > MAX_ARRAY_LENGTH) {
      output.push(TRUNCATED_VALUE);
    }
    return output;
  }

  if (!isPlainObject(value)) {
    return truncateString(value);
  }

  if (seen.has(value)) {
    return CIRCULAR_VALUE;
  }
  seen.add(value);

  const output = Object.create(null);
  const entries = Object.entries(value);
  const boundedLength = Math.min(entries.length, MAX_OBJECT_KEYS);
  for (let i = 0; i < boundedLength; i += 1) {
    const [entryKey, entryValue] = entries[i];
    output[entryKey] = sanitizeValue(entryValue, {
      depth: depth + 1,
      keyName: entryKey,
      seen
    });
  }
  if (entries.length > MAX_OBJECT_KEYS) {
    output._truncatedKeys = entries.length - MAX_OBJECT_KEYS;
  }
  seen.delete(value);
  return output;
}

function normalizeIdentifier(value, maxLength = 120) {
  const normalized = truncateString(value, maxLength).trim();
  return normalized || null;
}

function normalizeKind(value) {
  return normalizeIdentifier(value, 120) || "bot_runtime";
}

function normalizeLevel(kind) {
  const normalizedKind = String(kind || "").toLowerCase();
  if (normalizedKind.endsWith("_error") || normalizedKind.includes("error")) {
    return "error";
  }
  return "info";
}

function resolveAgent(kind, metadata) {
  if (isPlainObject(metadata)) {
    const explicitAgent =
      normalizeIdentifier(metadata.agent, 80) ||
      normalizeIdentifier(metadata.agentId, 80) ||
      normalizeIdentifier(metadata.agentName, 80);
    if (explicitAgent) return explicitAgent;
  }

  const normalizedKind = String(kind || "");
  if (normalizedKind.startsWith("voice_")) return "voice";
  if (normalizedKind.startsWith("discovery_")) return "discovery";
  if (normalizedKind.startsWith("automation_")) return "automation";
  if (normalizedKind.startsWith("memory_")) return "memory";
  if (normalizedKind.startsWith("bot_")) return "bot";
  return "runtime";
}

export function normalizeRuntimeActionEvent(action) {
  const normalizedAction = isPlainObject(action) ? action : {};
  const kind = normalizeKind(normalizedAction.kind);
  const event = normalizeIdentifier(normalizedAction.content, 180) || kind;
  const metadata = sanitizeValue(normalizedAction.metadata, { keyName: "metadata" });

  return {
    ts: normalizeIdentifier(normalizedAction.createdAt, 40) || nowIso(),
    instance: appConfig.instanceId,
    source: "store_action",
    level: normalizeLevel(kind),
    kind,
    event,
    agent: resolveAgent(kind, normalizedAction.metadata),
    guild_id: normalizeIdentifier(normalizedAction.guildId, 80),
    channel_id: normalizeIdentifier(normalizedAction.channelId, 80),
    message_id: normalizeIdentifier(normalizedAction.messageId, 80),
    user_id: normalizeIdentifier(normalizedAction.userId, 80),
    usd_cost: Number(normalizedAction.usdCost) || 0,
    content: normalizeIdentifier(normalizedAction.content, MAX_STRING_LENGTH),
    metadata
  };
}

function resolveLogFilePath(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  return path.isAbsolute(normalized) ? normalized : path.resolve(process.cwd(), normalized);
}

/**
 * Maximum ndjson log file size before rotation (default 50 MB).
 * When the file exceeds this size at startup, it is rotated to a
 * `.prev.ndjson` backup and a fresh file is opened.  This keeps the
 * file small enough that Promtail can re-read it from the top in
 * under a minute if it loses its position tracking, and all entries
 * stay within Loki's `reject_old_samples_max_age` window.
 */
const LOG_FILE_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

export class RuntimeActionLogger {
  enabled;
  writeToStdout;
  writeLine;
  logFilePath;
  fileStream;

  constructor({ enabled = true, writeToStdout = true, logFilePath = "", writeLine = null } = {}) {
    this.enabled = Boolean(enabled);
    this.writeToStdout = Boolean(writeToStdout);
    this.writeLine = typeof writeLine === "function" ? writeLine : null;
    this.logFilePath = resolveLogFilePath(logFilePath);
    this.fileStream = null;

    if (this.enabled && this.logFilePath) {
      fs.mkdirSync(path.dirname(this.logFilePath), { recursive: true });
      this.rotateIfNeeded();
      this.fileStream = fs.createWriteStream(this.logFilePath, {
        flags: "a",
        encoding: "utf8"
      });
      this.fileStream.on("error", () => {
        this.fileStream = null;
      });
    }
  }

  /**
   * Rotate the ndjson log file on startup if it exceeds LOG_FILE_MAX_BYTES.
   * Keeps one `.prev.ndjson` backup — Promtail only tails the primary file,
   * so the backup is purely for manual forensics.
   */
  private rotateIfNeeded() {
    if (!this.logFilePath) return;
    try {
      const stat = fs.statSync(this.logFilePath);
      if (stat.size <= LOG_FILE_MAX_BYTES) return;
      const prevPath = this.logFilePath.replace(/\.ndjson$/, ".prev.ndjson");
      // Overwrite any existing backup
      fs.renameSync(this.logFilePath, prevPath);
    } catch {
      // File doesn't exist or rename failed — either way, the append
      // open below will create a fresh file.
    }
  }

  attachToStore(store) {
    if (!store || typeof store !== "object") return;
    const previousActionListener = typeof store.onActionLogged === "function" ? store.onActionLogged : null;

    store.onActionLogged = (action) => {
      if (previousActionListener) {
        try {
          previousActionListener(action);
        } catch {
          // keep runtime logger resilient
        }
      }
      this.logAction(action);
    };
  }

  logAction(action) {
    if (!this.enabled) return;
    const payload = normalizeRuntimeActionEvent(action);
    const line = `${JSON.stringify(payload)}\n`;

    if (this.writeLine) {
      try {
        this.writeLine(line, payload);
      } catch {
        // in-test sink should never break runtime logging
      }
    }

    if (this.writeToStdout) {
      try {
        process.stdout.write(formatPrettyLine(payload));
      } catch {
        // stdout failures should not interrupt runtime behavior
      }
    }

    if (this.fileStream) {
      try {
        this.fileStream.write(line);
      } catch {
        // file failures should not interrupt runtime behavior
      }
    }
  }

  close() {
    if (!this.fileStream) return;
    this.fileStream.end();
    this.fileStream = null;
  }
}
