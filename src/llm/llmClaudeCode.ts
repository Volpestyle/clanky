import { spawn } from "node:child_process";
import { clampInt } from "../normalization/numbers.ts";
import { safeJsonParseFromString } from "../normalization/valueParsers.ts";
import { createAbortError } from "../tools/browserTaskRuntime.ts";
import type { SubAgentProgressEvent } from "../agents/subAgentSession.ts";

type ClaudeCliResult = {
  stdout: string;
  stderr: string;
};

type ClaudeCliError = Error & {
  killed?: boolean;
  signal?: string | null;
  code?: number | null;
  stdout?: string;
  stderr?: string;
};

type ClaudeCliStreamJob = {
  input: string;
  timeoutMs: number;
  onEvent?: (event: SubAgentProgressEvent) => void;
  startedAtMs: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  timedOut: boolean;
  aborted: boolean;
  abortReason: unknown;
  signal?: AbortSignal;
  abortHandler: (() => void) | null;
  timeout: ReturnType<typeof setTimeout> | null;
  resolve: (result: ClaudeCliResult) => void;
  reject: (error: Error) => void;
};

export type ClaudeCliStreamSessionLike = {
  run: (payload: {
    input?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    onEvent?: (event: SubAgentProgressEvent) => void;
  }) => Promise<ClaudeCliResult>;
  close: () => void;
  isIdle: () => boolean;
};

export function safeJsonParse(value, fallback = null) {
  return safeJsonParseFromString(value, fallback);
}

function truncateProgressSummary(value: unknown, maxChars = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 3)).trim()}...`;
}

function extractClaudeToolFilePath(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const record = input as Record<string, unknown>;
  const rawValue =
    record.file_path ??
    record.path ??
    record.target_path ??
    record.new_path ??
    record.old_path ??
    record.destination ??
    record.filename;
  return String(rawValue || "").trim();
}

function isClaudeFileEditTool(toolName: string, filePath: string): boolean {
  if (!filePath) return false;
  const normalizedName = String(toolName || "").trim().toLowerCase();
  return normalizedName.includes("write") ||
    normalizedName.includes("edit") ||
    normalizedName.includes("patch") ||
    normalizedName.includes("create") ||
    normalizedName.includes("append") ||
    normalizedName.includes("mv") ||
    normalizedName.includes("rename");
}

function summarizeClaudeToolUse(part: Record<string, unknown>) {
  const toolName = String(part?.name || "tool").trim() || "tool";
  const filePath = extractClaudeToolFilePath(part?.input);
  const summary = filePath
    ? `Tool ${toolName} on ${filePath}`
    : `Tool ${toolName}`;
  return {
    kind: isClaudeFileEditTool(toolName, filePath) ? "file_edit" as const : "tool_use" as const,
    summary: truncateProgressSummary(summary),
    filePath
  };
}

function summarizeClaudeAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const textParts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (String((part as { type?: unknown }).type || "") !== "text") continue;
    const text = String((part as { text?: unknown }).text || "").trim();
    if (!text) continue;
    textParts.push(text);
  }
  return truncateProgressSummary(textParts.join(" ").trim());
}

function emitProgress(job: ClaudeCliStreamJob, event: SubAgentProgressEvent) {
  if (typeof job.onEvent !== "function") return;
  try {
    job.onEvent(event);
  } catch {
    // Progress callbacks are best-effort and must not break stream execution.
  }
}

function runClaudeCli({ args, input, timeoutMs, maxBufferBytes, cwd = "", signal = undefined as AbortSignal | undefined }) {
  return new Promise<ClaudeCliResult>((resolve, reject) => {
    const spawnOptions: { stdio: ["pipe", "pipe", "pipe"]; cwd?: string } = { stdio: ["pipe", "pipe", "pipe"] };
    const normalizedCwd = String(cwd || "").trim();
    if (normalizedCwd) spawnOptions.cwd = normalizedCwd;
    const child = spawn("claude", args, spawnOptions);
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let aborted = false;

    if (signal?.aborted) {
      reject(createAbortError(signal.reason || "claude CLI cancelled"));
      return;
    }

    const finish = (error: Error | null, result?: ClaudeCliResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler);
      }
      if (error) reject(error);
      else resolve(result || { stdout: "", stderr: "" });
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {}
      setTimeout(() => {
        if (settled) return;
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 1000);
    }, timeoutMs);
    const abortHandler = signal
      ? () => {
          aborted = true;
          try {
            child.kill("SIGTERM");
          } catch {}
          setTimeout(() => {
            if (settled) return;
            try {
              child.kill("SIGKILL");
            } catch {}
          }, 1000);
        }
      : null;
    if (signal && abortHandler) {
      signal.addEventListener("abort", abortHandler, { once: true });
    }

    child.on("error", (error) => finish(error));

    child.stdout.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ""));
      if (stdoutBytes < maxBufferBytes) {
        const remaining = maxBufferBytes - stdoutBytes;
        stdout += buffer.subarray(0, remaining).toString("utf8");
      }
      stdoutBytes += buffer.length;
    });

    child.stderr.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ""));
      if (stderrBytes < maxBufferBytes) {
        const remaining = maxBufferBytes - stderrBytes;
        stderr += buffer.subarray(0, remaining).toString("utf8");
      }
      stderrBytes += buffer.length;
    });

    child.on("close", (code, signal) => {
      if (aborted) {
        const error = createAbortError(signal || "claude CLI cancelled") as ClaudeCliError;
        error.killed = true;
        error.signal = signal || "SIGTERM";
        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        finish(error, undefined);
        return;
      }
      if (timedOut) {
        const error = new Error("claude CLI timeout") as ClaudeCliError;
        error.killed = true;
        error.signal = signal || "SIGTERM";
        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        finish(error, undefined);
        return;
      }

      if (code === 0) {
        finish(null, { stdout, stderr });
        return;
      }

      const error = new Error(`Command failed: claude ${args.join(" ")}`) as ClaudeCliError;
      error.code = code;
      error.signal = signal;
      error.stdout = stdout;
      error.stderr = stderr;
      finish(error, undefined);
    });

    child.stdin.on("error", () => {});
    child.stdin.end(input || "");
  });
}

function appendLimitedText(job: ClaudeCliStreamJob, channel: "stdout" | "stderr", textChunk: string, maxBufferBytes: number) {
  const normalizedChunk = String(textChunk || "");
  if (!normalizedChunk) return;
  const chunkBuffer = Buffer.from(normalizedChunk, "utf8");
  const chunkLength = chunkBuffer.length;

  if (channel === "stdout") {
    if (job.stdoutBytes < maxBufferBytes) {
      const remaining = maxBufferBytes - job.stdoutBytes;
      job.stdout += chunkBuffer.subarray(0, remaining).toString("utf8");
    }
    job.stdoutBytes += chunkLength;
    return;
  }

  if (job.stderrBytes < maxBufferBytes) {
    const remaining = maxBufferBytes - job.stderrBytes;
    job.stderr += chunkBuffer.subarray(0, remaining).toString("utf8");
  }
  job.stderrBytes += chunkLength;
}

function buildClaudeCliCommandError({
  args,
  code,
  signal,
  timedOut = false,
  aborted = false,
  abortReason = "claude CLI cancelled",
  stdout = "",
  stderr = ""
}: {
  args: string[];
  code?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  aborted?: boolean;
  abortReason?: unknown;
  stdout?: string;
  stderr?: string;
}) {
  if (aborted) {
    const error = createAbortError(abortReason) as ClaudeCliError;
    error.killed = true;
    error.signal = signal ?? "SIGTERM";
    error.code = typeof code === "number" ? code : code ?? null;
    error.stdout = String(stdout || "");
    error.stderr = String(stderr || "");
    return error;
  }
  const error = new Error(
    timedOut ? "claude CLI timeout" : `Command failed: claude ${Array.isArray(args) ? args.join(" ") : ""}`
  ) as ClaudeCliError;
  error.killed = Boolean(timedOut);
  error.signal = signal ?? null;
  error.code = typeof code === "number" ? code : code ?? null;
  error.stdout = String(stdout || "");
  error.stderr = String(stderr || "");
  return error;
}

class ClaudeCliStreamSession {
  args: string[];
  maxBufferBytes: number;
  cwd: string;
  child: ReturnType<typeof spawn> | null;
  queue: ClaudeCliStreamJob[];
  activeJob: ClaudeCliStreamJob | null;
  stdoutRemainder: string;
  closed: boolean;
  lastUsedAt: number;

  constructor({ args, maxBufferBytes, cwd = "" }: { args: string[]; maxBufferBytes: number; cwd?: string }) {
    this.args = Array.isArray(args) ? [...args] : [];
    this.maxBufferBytes = Math.max(4096, Math.floor(Number(maxBufferBytes) || 1024 * 1024));
    this.cwd = String(cwd || "").trim();
    this.child = null;
    this.queue = [];
    this.activeJob = null;
    this.stdoutRemainder = "";
    this.closed = false;
    this.lastUsedAt = Date.now();
  }

  isIdle() {
    return !this.activeJob && this.queue.length === 0;
  }

  async run({
    input = "",
    timeoutMs = 30_000,
    signal = undefined as AbortSignal | undefined,
    onEvent
  }: {
    input?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    onEvent?: (event: SubAgentProgressEvent) => void;
  }) {
    if (this.closed) {
      throw new Error("claude-code session is closed");
    }
    if (signal?.aborted) {
      throw createAbortError(signal.reason || "claude-code session cancelled");
    }

    return await new Promise<ClaudeCliResult>((resolve, reject) => {
      this.queue.push({
        input: String(input || ""),
        timeoutMs: Math.max(1, Math.floor(Number(timeoutMs) || 30_000)),
        onEvent,
        startedAtMs: Date.now(),
        stdout: "",
        stderr: "",
        stdoutBytes: 0,
        stderrBytes: 0,
        timedOut: false,
        aborted: false,
        abortReason: "",
        signal,
        abortHandler: null,
        timeout: null,
        resolve,
        reject
      });
      this.pump();
    });
  }

  close() {
    this.closed = true;
    const queuedError = new Error("claude-code session closed");
    for (const job of this.queue.splice(0)) {
      job.reject(queuedError);
    }
    if (this.activeJob) {
      this.failActiveJob(queuedError);
    }
    this.terminateChild();
  }

  private pump() {
    if (this.closed) return;
    if (this.activeJob) return;
    if (!this.queue.length) return;

    this.ensureChild();
    if (!this.child) return;

    const nextJob = this.queue.shift() || null;
    if (!nextJob) return;

    this.activeJob = nextJob;
    this.lastUsedAt = Date.now();
    if (nextJob.signal?.aborted) {
      nextJob.aborted = true;
      nextJob.abortReason = nextJob.signal.reason || "claude-code session cancelled";
      this.failActiveJob(createAbortError(nextJob.abortReason));
      this.pump();
      return;
    }
    if (nextJob.signal) {
      nextJob.abortHandler = () => {
        nextJob.aborted = true;
        nextJob.abortReason = nextJob.signal?.reason || "claude-code session cancelled";
        this.terminateChild();
      };
      nextJob.signal.addEventListener("abort", nextJob.abortHandler, { once: true });
    }
    nextJob.timeout = setTimeout(() => {
      nextJob.timedOut = true;
      this.terminateChild();
    }, nextJob.timeoutMs);

    try {
      this.child.stdin.write(nextJob.input);
    } catch (error) {
      this.failActiveJob(error);
      this.pump();
    }
  }

  private ensureChild() {
    if (this.child) return;
    this.stdoutRemainder = "";

    const spawnOptions: { stdio: ["pipe", "pipe", "pipe"]; cwd?: string } = { stdio: ["pipe", "pipe", "pipe"] };
    if (this.cwd) spawnOptions.cwd = this.cwd;
    const child = spawn("claude", this.args, spawnOptions);
    this.child = child;

    child.stdout.on("data", (chunk) => this.handleStdoutChunk(chunk));
    child.stderr.on("data", (chunk) => this.handleStderrChunk(chunk));
    child.on("error", (error) => {
      this.terminateChild();
      this.failActiveJob(error);
      this.pump();
    });
    child.on("close", (code, signal) => {
      this.child = null;
      this.flushTrailingStdoutLine();

      if (this.activeJob) {
        const active = this.activeJob;
        const error = buildClaudeCliCommandError({
          args: this.args,
          code,
          signal,
          timedOut: active.timedOut,
          aborted: active.aborted,
          abortReason: active.abortReason,
          stdout: active.stdout,
          stderr: active.stderr
        });
        this.failActiveJob(error);
      }

      this.pump();
    });
    child.stdin.on("error", () => {});
  }

  private terminateChild() {
    if (!this.child) return;
    const child = this.child;
    try {
      child.kill("SIGTERM");
    } catch {}
    setTimeout(() => {
      if (!child.killed) {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    }, 1000);
  }

  private handleStdoutChunk(chunk: unknown) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ""));
    this.stdoutRemainder += buffer.toString("utf8");

    while (true) {
      const newlineIndex = this.stdoutRemainder.indexOf("\n");
      if (newlineIndex < 0) break;
      const line = this.stdoutRemainder.slice(0, newlineIndex);
      this.stdoutRemainder = this.stdoutRemainder.slice(newlineIndex + 1);
      this.handleStdoutLine(line);
    }
  }

  private flushTrailingStdoutLine() {
    if (!this.stdoutRemainder) return;
    const trailing = this.stdoutRemainder;
    this.stdoutRemainder = "";
    this.handleStdoutLine(trailing);
  }

  private handleStdoutLine(rawLine: string) {
    const line = String(rawLine || "");
    const active = this.activeJob;
    if (!active) return;

    appendLimitedText(active, "stdout", `${line}\n`, this.maxBufferBytes);
    const parsed = safeJsonParse(line, null);
    if (!parsed || typeof parsed !== "object") return;

    this.emitProgressForParsedLine(active, parsed as Record<string, unknown>);

    if (parsed.type !== "result") return;

    this.finishActiveJob();
  }

  private emitProgressForParsedLine(active: ClaudeCliStreamJob, parsed: Record<string, unknown>) {
    const now = Date.now();
    const elapsedMs = Math.max(0, now - Number(active.startedAtMs || now));
    const eventType = String(parsed.type || "").trim().toLowerCase();

    if (eventType === "assistant") {
      const message = parsed.message && typeof parsed.message === "object"
        ? parsed.message as Record<string, unknown>
        : null;
      const content = Array.isArray(message?.content) ? message.content : [];
      for (const partValue of content) {
        if (!partValue || typeof partValue !== "object") continue;
        const part = partValue as Record<string, unknown>;
        const partType = String(part.type || "").trim().toLowerCase();
        if (partType === "tool_use") {
          const toolEvent = summarizeClaudeToolUse(part);
          emitProgress(active, {
            kind: toolEvent.kind,
            summary: toolEvent.summary || "Tool call executed.",
            elapsedMs,
            timestamp: now,
            filePath: toolEvent.filePath || undefined
          });
        }
      }
      const assistantSummary = summarizeClaudeAssistantText(content);
      if (assistantSummary) {
        emitProgress(active, {
          kind: "assistant_message",
          summary: assistantSummary,
          elapsedMs,
          timestamp: now
        });
      }
      return;
    }

    if (eventType === "result") {
      const status = String(parsed.subtype || parsed.status || "completed").trim() || "completed";
      emitProgress(active, {
        kind: "turn_complete",
        summary: truncateProgressSummary(`Turn ${status}`) || "Turn completed.",
        elapsedMs,
        timestamp: now
      });
      return;
    }

    if (eventType === "error") {
      const detail = truncateProgressSummary(parsed.message || parsed.error || "Sub-agent stream error.");
      emitProgress(active, {
        kind: "error",
        summary: detail || "Sub-agent stream error.",
        elapsedMs,
        timestamp: now
      });
    }
  }

  private handleStderrChunk(chunk: unknown) {
    if (!this.activeJob) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ""));
    appendLimitedText(this.activeJob, "stderr", buffer.toString("utf8"), this.maxBufferBytes);
  }

  private finishActiveJob() {
    const active = this.activeJob;
    if (!active) return;
    this.activeJob = null;
    if (active.timeout) clearTimeout(active.timeout);
    if (active.signal && active.abortHandler) {
      active.signal.removeEventListener("abort", active.abortHandler);
      active.abortHandler = null;
    }
    this.lastUsedAt = Date.now();
    active.resolve({
      stdout: active.stdout,
      stderr: active.stderr
    });
    this.pump();
  }

  private failActiveJob(error: unknown) {
    const active = this.activeJob;
    if (!active) return;
    this.activeJob = null;
    if (active.timeout) clearTimeout(active.timeout);
    if (active.signal && active.abortHandler) {
      active.signal.removeEventListener("abort", active.abortHandler);
      active.abortHandler = null;
    }

    const normalizedError = (error instanceof Error ? error : new Error(String(error || "claude CLI error"))) as ClaudeCliError;
    if (typeof normalizedError.stdout !== "string") {
      normalizedError.stdout = active.stdout;
    }
    if (typeof normalizedError.stderr !== "string") {
      normalizedError.stderr = active.stderr;
    }
    active.reject(normalizedError);
  }
}

export function createClaudeCliStreamSession({
  args,
  maxBufferBytes = 1024 * 1024,
  cwd = ""
}: {
  args: string[];
  maxBufferBytes?: number;
  cwd?: string;
}): ClaudeCliStreamSessionLike {
  if (!Array.isArray(args) || !args.length) {
    throw new Error("claude-code stream session requires non-empty CLI args");
  }
  return new ClaudeCliStreamSession({
    args,
    maxBufferBytes,
    cwd
  });
}

export function buildAnthropicImageParts(imageInputs) {
  const parts = (Array.isArray(imageInputs) ? imageInputs : [])
    .map((image) => {
      const mediaType = String(image?.mediaType || image?.contentType || "").trim().toLowerCase();
      const base64 = String(image?.dataBase64 || "").trim();
      const url = String(image?.url || "").trim();
      if (base64 && /^image\/[a-z0-9.+-]+$/i.test(mediaType)) {
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType,
            data: base64
          }
        };
      }
      if (!url) return null;
      return {
        type: "image",
        source: {
          type: "url",
          url
        }
      };
    })
    .filter(Boolean);
  if (parts.length) {
    const urlParts = parts.filter((p) => p.source?.type === "url");
    if (urlParts.length) {
      console.log(`[buildAnthropicImageParts] url_image_inputs  count=${urlParts.length}  urls=${urlParts.map((p) => p.source.url).join(", ")}`);
    }
  }
  return parts;
}

export function buildClaudeCodeStreamInput({
  contextMessages = [],
  userPrompt,
  imageInputs = [],
  turnPreamble = ""
}) {
  const events = [];

  for (const msg of Array.isArray(contextMessages) ? contextMessages : []) {
    const role = msg?.role === "assistant" ? "assistant" : "user";
    const text = String(msg?.content || "");
    events.push({
      type: role,
      message: {
        role,
        content: [{ type: "text", text }]
      }
    });
  }

  const userText = [String(turnPreamble || "").trim(), String(userPrompt || "").trim()].filter(Boolean).join("\n\n");
  const imageParts = buildAnthropicImageParts(imageInputs);
  const userContent = [{ type: "text", text: userText }, ...imageParts];
  events.push({
    type: "user",
    message: {
      role: "user",
      content: userContent
    }
  });

  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

export function buildClaudeCodeCliArgs({ model, systemPrompt = "", jsonSchema = "", maxTurns = 1 }) {
  const args = buildClaudeCodeBaseCliArgs({
    model,
    verbose: true,
    inputFormat: "stream-json",
    outputFormat: "stream-json",
    maxTurns
  });
  appendClaudeCodeOptionalCliArgs(args, { systemPrompt, jsonSchema });
  return args;
}

export function buildClaudeCodeJsonCliArgs({
  model,
  systemPrompt = "",
  jsonSchema = "",
  prompt = ""
}) {
  const args = buildClaudeCodeBaseCliArgs({
    model,
    outputFormat: "json"
  });
  appendClaudeCodeOptionalCliArgs(args, { systemPrompt, jsonSchema, prompt });
  return args;
}

export function buildClaudeCodeTextCliArgs({
  model,
  systemPrompt = "",
  jsonSchema = "",
  prompt = ""
}) {
  const args = buildClaudeCodeBaseCliArgs({ model });
  appendClaudeCodeOptionalCliArgs(args, { systemPrompt, jsonSchema, prompt });
  return args;
}

export function buildClaudeCodeFallbackPrompt({
  contextMessages = [],
  userPrompt = "",
  imageInputs = []
}) {
  const sections = [];
  const historyLines = [];
  for (const message of Array.isArray(contextMessages) ? contextMessages : []) {
    const role = message?.role === "assistant" ? "assistant" : "user";
    const text = String(message?.content || "").trim();
    if (!text) continue;
    historyLines.push(`${role}: ${text}`);
  }
  if (historyLines.length) {
    sections.push(`Conversation context:\n${historyLines.join("\n")}`);
  }

  const normalizedPrompt = String(userPrompt || "").trim();
  if (normalizedPrompt) {
    sections.push(`User request:\n${normalizedPrompt}`);
  }

  const imageLines = (Array.isArray(imageInputs) ? imageInputs : [])
    .map((image) => {
      const url = String(image?.url || "").trim();
      if (url) return `- ${url}`;

      const mediaType = String(image?.mediaType || image?.contentType || "").trim();
      const hasInlineImage = Boolean(String(image?.dataBase64 || "").trim());
      if (!hasInlineImage) return "";

      return mediaType ? `- inline image (${mediaType})` : "- inline image";
    })
    .filter(Boolean);
  if (imageLines.length) {
    sections.push(`Image references:\n${imageLines.join("\n")}`);
  }

  return sections.join("\n\n").trim();
}

export function buildClaudeCodeSystemPrompt({ systemPrompt = "", maxOutputTokens = 0 }) {
  const normalizedSystemPrompt = String(systemPrompt || "").trim();
  if (!normalizedSystemPrompt) return "";

  const requestedMaxOutputTokens = Number(maxOutputTokens || 0);
  if (!Number.isFinite(requestedMaxOutputTokens) || requestedMaxOutputTokens <= 0) {
    return normalizedSystemPrompt;
  }

  const boundedMaxOutputTokens = clampInt(maxOutputTokens, 1, 32000);

  return [
    normalizedSystemPrompt,
    `Keep the final answer under ${boundedMaxOutputTokens} tokens.`
  ].join("\n\n");
}

export function parseClaudeCodeStreamOutput(rawOutput) {
  const lines = String(rawOutput || "")
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);

  let lastResult = null;
  let lastAssistantText = "";
  let lastStructuredOutputText = "";

  for (const line of lines) {
    const event = safeJsonParse(line, null);
    if (!event || typeof event !== "object") continue;

    if (event.type === "assistant" && event.message && Array.isArray(event.message.content)) {
      const textParts = [];
      for (const part of event.message.content) {
        if (part?.type === "text") {
          const textPart = String(part?.text || "").trim();
          if (textPart) textParts.push(textPart);
          continue;
        }

        if (part?.type === "tool_use" && String(part?.name || "") === "StructuredOutput") {
          const serializedOutput = serializeClaudeCodeStructuredOutput(part?.input);
          if (serializedOutput) lastStructuredOutputText = serializedOutput;
        }
      }

      const text = textParts.join("\n").trim();
      if (text) lastAssistantText = text;
      continue;
    }

    if (event.type === "result") {
      const structuredOutputText = serializeClaudeCodeStructuredOutput(event.structured_output);
      if (structuredOutputText) {
        lastStructuredOutputText = structuredOutputText;
      }
      lastResult = event;
    }
  }

  if (!lastResult) {
    const fallbackText = lastStructuredOutputText || lastAssistantText;
    if (!fallbackText) return null;
    return {
      text: fallbackText,
      isError: false,
      errorMessage: "",
      usage: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
      costUsd: 0
    };
  }

  const usage = lastResult.usage || {};
  const resultText = String(lastResult.result || "").trim();
  const preferredText = lastStructuredOutputText || resultText || lastAssistantText;

  return buildClaudeCodeParsedResult({
    result: lastResult,
    usage,
    resultText: preferredText
  });
}

function serializeClaudeCodeStructuredOutput(rawValue) {
  if (rawValue == null) return "";
  if (typeof rawValue === "string") {
    return String(rawValue || "").trim();
  }

  try {
    return JSON.stringify(rawValue);
  } catch {
    return "";
  }
}

export function parseClaudeCodeJsonOutput(rawOutput) {
  const rawText = String(rawOutput || "").trim();
  if (!rawText) return null;

  const parsedWhole = safeJsonParse(rawText, null);
  let lastResult =
    parsedWhole && typeof parsedWhole === "object" && !Array.isArray(parsedWhole)
      ? parsedWhole
      : null;

  if (!lastResult || (!lastResult.type && lastResult.result === undefined)) {
    const lines = rawText
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean);
    lastResult = null;
    for (const line of lines) {
      const event = safeJsonParse(line, null);
      if (!event || typeof event !== "object") continue;
      if (event.type === "result") {
        lastResult = event;
      }
    }
  }
  if (!lastResult) return null;

  const usage = lastResult.usage || {};
  const resultText =
    serializeClaudeCodeStructuredOutput(lastResult.structured_output) || String(lastResult.result || "").trim();
  return buildClaudeCodeParsedResult({
    result: lastResult,
    usage,
    resultText
  });
}

/**
 * Build CLI args for a persistent multi-turn code agent session.
 * Uses stream-json for both input and output so follow-up messages
 * can be sent on stdin after the initial instruction completes.
 */
export function buildCodeAgentSessionCliArgs({ model, maxTurns = 30 }) {
  return [
    "-p",
    "--verbose",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--no-session-persistence",
    "--model", String(model || "sonnet"),
    "--max-turns", String(clampInt(maxTurns, 1, 10000))
  ];
}

/**
 * Build stream-json input for a code agent session turn.
 * Wraps the user's message as a stream-json user event.
 */
export function buildCodeAgentSessionTurnInput(userMessage: string) {
  const event = {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: String(userMessage || "").trim() }]
    }
  };
  return `${JSON.stringify(event)}\n`;
}

function buildClaudeCodeBaseCliArgs({
  model,
  verbose = false,
  inputFormat = "",
  outputFormat = "",
  maxTurns = 1
}) {
  const args = ["-p"];
  if (verbose) args.push("--verbose");
  args.push(
    "--no-session-persistence",
    "--strict-mcp-config",
    "--tools", "",
    "--plugin-dir", "",
    "--setting-sources", "project,local"
  );
  if (String(inputFormat || "").trim()) {
    args.push("--input-format", String(inputFormat).trim());
  }
  if (String(outputFormat || "").trim()) {
    args.push("--output-format", String(outputFormat).trim());
  }
  args.push("--model", model, "--max-turns", String(clampInt(maxTurns, 1, 10000)));
  return args;
}

function appendClaudeCodeOptionalCliArgs(args, {
  systemPrompt = "",
  jsonSchema = "",
  prompt = ""
}) {
  const normalizedSystemPrompt = String(systemPrompt || "").trim();
  if (normalizedSystemPrompt) {
    args.push("--system-prompt", normalizedSystemPrompt);
  }

  const normalizedSchema = String(jsonSchema || "").trim();
  if (normalizedSchema) {
    args.push("--json-schema", normalizedSchema);
  }

  const normalizedPrompt = String(prompt || "").trim();
  if (normalizedPrompt) {
    args.push(normalizedPrompt);
  }
}

function buildClaudeCodeParsedResult({ result, usage, resultText = "" }) {
  const errors = Array.isArray(result?.errors) ? result.errors : [];
  const normalizedResultText = String(resultText || "").trim();
  const errorMessage =
    normalizedResultText || errors.map((item) => String(item || "").trim()).filter(Boolean).join(" | ");
  return {
    text: normalizedResultText,
    isError: Boolean(result?.is_error),
    errorMessage,
    usage: {
      inputTokens: Number(usage.input_tokens || 0),
      outputTokens: Number(usage.output_tokens || 0),
      cacheWriteTokens: Number(usage.cache_creation_input_tokens || 0),
      cacheReadTokens: Number(usage.cache_read_input_tokens || 0)
    },
    costUsd: Number(result?.total_cost_usd || 0)
  };
}

export function normalizeClaudeCodeCliError(
  error,
  { timeoutPrefix = "claude-code timed out", timeoutMs = 30_000 } = {}
) {
  if (error?.killed || error?.signal === "SIGTERM") {
    return {
      isTimeout: true,
      message: `${timeoutPrefix} after ${Math.max(1, Math.floor(Number(timeoutMs) || 0) / 1000)}s.`
    };
  }

  const detail = String(error?.stderr || error?.stdout || "").trim();
  return {
    isTimeout: false,
    message: detail
      ? `claude-code CLI error: ${error?.message || error} | ${detail.slice(0, 300)}`
      : `claude-code CLI error: ${error?.message || error}`
  };
}
