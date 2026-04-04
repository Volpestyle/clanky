import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { safeJsonParseFromString } from "../normalization/valueParsers.ts";
import { createAbortError } from "../tools/abortError.ts";
import { estimateUsdCost } from "./pricing.ts";
import type { SubAgentProgressEvent } from "../agents/subAgentSession.ts";

type CodexCliResult = {
  stdout: string;
  stderr: string;
};

type CodexCliError = Error & {
  killed?: boolean;
  signal?: string | null;
  code?: number | null;
  stdout?: string;
  stderr?: string;
};

type CodexCliParsedUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
};

type CodexCliParsedResult = {
  text: string;
  isError: boolean;
  errorMessage: string;
  usage: CodexCliParsedUsage;
  costUsd: number;
  threadId: string;
};

export type CodexCliStreamSessionLike = {
  run: (payload: {
    input?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    onEvent?: (event: SubAgentProgressEvent) => void;
  }) => Promise<CodexCliResult>;
  close: () => void;
  isIdle: () => boolean;
};

type PendingJob = {
  input: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onEvent?: (event: SubAgentProgressEvent) => void;
  resolve: (result: CodexCliResult) => void;
  reject: (error: Error) => void;
};

type CodexCliEnv = Record<string, string>;

function safeJsonParse(value: string, fallback: unknown = null) {
  return safeJsonParseFromString(value, fallback);
}

function truncateProgressSummary(value: unknown, maxChars = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 3)).trim()}...`;
}

function extractCodexToolArguments(rawValue: unknown): Record<string, unknown> {
  if (!rawValue) return {};
  if (typeof rawValue === "object" && !Array.isArray(rawValue)) {
    return rawValue as Record<string, unknown>;
  }
  if (typeof rawValue === "string") {
    const parsed = safeJsonParse(rawValue, null);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }
  return {};
}

function extractCodexToolFilePath(argumentsValue: Record<string, unknown>): string {
  return String(
    argumentsValue.file_path ??
    argumentsValue.path ??
    argumentsValue.target_path ??
    argumentsValue.new_path ??
    argumentsValue.old_path ??
    argumentsValue.filename ??
    ""
  ).trim();
}

function isCodexFileEditTool(toolName: string, filePath: string): boolean {
  if (!filePath) return false;
  const normalized = String(toolName || "").trim().toLowerCase();
  return normalized.includes("write") ||
    normalized.includes("edit") ||
    normalized.includes("patch") ||
    normalized.includes("create") ||
    normalized.includes("append") ||
    normalized.includes("move") ||
    normalized.includes("rename");
}

function emitProgress(onEvent: PendingJob["onEvent"], event: SubAgentProgressEvent) {
  if (typeof onEvent !== "function") return;
  try {
    onEvent(event);
  } catch {
    // Best-effort: progress callbacks must not break CLI session execution.
  }
}

function emitProgressFromCodexJsonlLine({
  line,
  startedAtMs,
  onEvent
}: {
  line: string;
  startedAtMs: number;
  onEvent?: PendingJob["onEvent"];
}) {
  const parsed = safeJsonParse(line, null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const event = parsed as Record<string, unknown>;
  const now = Date.now();
  const elapsedMs = Math.max(0, now - Number(startedAtMs || now));
  const type = String(event.type || "").trim().toLowerCase();

  if (type === "item.completed") {
    const item = event.item && typeof event.item === "object" && !Array.isArray(event.item)
      ? event.item as Record<string, unknown>
      : null;
    if (!item) return;
    const itemType = String(item.type || "").trim().toLowerCase();
    if (itemType === "agent_message") {
      const summary = truncateProgressSummary(item.text || item.message || "Agent message received.");
      if (!summary) return;
      emitProgress(onEvent, {
        kind: "assistant_message",
        summary,
        elapsedMs,
        timestamp: now
      });
      return;
    }
    if (itemType === "tool_call") {
      const toolName = String(item.name || item.tool_name || "tool").trim() || "tool";
      const toolArgs = extractCodexToolArguments(item.arguments);
      const filePath = extractCodexToolFilePath(toolArgs);
      const kind = isCodexFileEditTool(toolName, filePath) ? "file_edit" as const : "tool_use" as const;
      const summary = truncateProgressSummary(
        filePath ? `Tool ${toolName} on ${filePath}` : `Tool ${toolName}`
      );
      emitProgress(onEvent, {
        kind,
        summary: summary || "Tool call executed.",
        elapsedMs,
        timestamp: now,
        filePath: filePath || undefined
      });
    }
    return;
  }

  if (type === "turn.completed") {
    emitProgress(onEvent, {
      kind: "turn_complete",
      summary: "Turn completed.",
      elapsedMs,
      timestamp: now
    });
    return;
  }

  if (type === "error") {
    const summary = truncateProgressSummary(event.message || event.error || "codex-cli error");
    emitProgress(onEvent, {
      kind: "error",
      summary: summary || "codex-cli error",
      elapsedMs,
      timestamp: now
    });
  }
}

export function runCodexCli({ args, input, timeoutMs, maxBufferBytes, cwd = "", env = {}, signal = undefined as AbortSignal | undefined, onStdoutLine = undefined as ((line: string) => void) | undefined }: {
  args: string[];
  input?: string;
  timeoutMs: number;
  maxBufferBytes: number;
  cwd?: string;
  env?: CodexCliEnv;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
}) {
  return new Promise<CodexCliResult>((resolve, reject) => {
    const spawnOptions: { stdio: ["pipe", "pipe", "pipe"]; cwd?: string; env?: NodeJS.ProcessEnv } = {
      stdio: ["pipe", "pipe", "pipe"]
    };
    const normalizedCwd = String(cwd || "").trim();
    if (normalizedCwd) spawnOptions.cwd = normalizedCwd;
    const normalizedEnv = env && typeof env === "object" ? env : undefined;
    if (normalizedEnv && Object.keys(normalizedEnv).length > 0) {
      spawnOptions.env = { ...process.env, ...normalizedEnv };
    }
    const child = spawn("codex", args, spawnOptions);
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let stdoutLineRemainder = "";

    if (signal?.aborted) {
      reject(createAbortError(signal.reason || "codex CLI cancelled"));
      return;
    }

    const finish = (error: Error | null, result?: CodexCliResult) => {
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
      if (typeof onStdoutLine === "function") {
        stdoutLineRemainder += buffer.toString("utf8");
        while (true) {
          const newlineIndex = stdoutLineRemainder.indexOf("\n");
          if (newlineIndex < 0) break;
          const line = stdoutLineRemainder.slice(0, newlineIndex);
          stdoutLineRemainder = stdoutLineRemainder.slice(newlineIndex + 1);
          onStdoutLine(line);
        }
      }
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
      if (typeof onStdoutLine === "function" && stdoutLineRemainder.length > 0) {
        const trailingLine = stdoutLineRemainder;
        stdoutLineRemainder = "";
        onStdoutLine(trailingLine);
      }
      if (aborted) {
        const error = createAbortError(signal || "codex CLI cancelled") as CodexCliError;
        error.killed = true;
        error.signal = signal || "SIGTERM";
        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        finish(error, undefined);
        return;
      }
      if (timedOut) {
        const error = new Error("codex CLI timeout") as CodexCliError;
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

      const error = new Error(`Command failed: codex ${args.join(" ")}`) as CodexCliError;
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

class CodexCliStreamSession implements CodexCliStreamSessionLike {
  private readonly model: string;
  private readonly maxBufferBytes: number;
  private readonly cwd: string;
  private readonly configOverrides: string[];
  private readonly env: CodexCliEnv;
  private closed: boolean;
  private running: boolean;
  private readonly queue: PendingJob[];
  private threadId: string;
  private activeRunAbortController: AbortController | null;

  constructor({
    model,
    maxBufferBytes,
    cwd = "",
    configOverrides = [],
    env = {}
  }: {
    model: string;
    maxBufferBytes: number;
    cwd?: string;
    configOverrides?: string[];
    env?: CodexCliEnv;
  }) {
    this.model = String(model || "").trim();
    this.maxBufferBytes = Math.max(4096, Math.floor(Number(maxBufferBytes) || 1024 * 1024));
    this.cwd = String(cwd || "").trim();
    this.configOverrides = Array.isArray(configOverrides)
      ? configOverrides.map((value) => String(value || "").trim()).filter(Boolean)
      : [];
    this.env = env && typeof env === "object" ? { ...env } : {};
    this.closed = false;
    this.running = false;
    this.queue = [];
    this.threadId = "";
    this.activeRunAbortController = null;
  }

  isIdle() {
    return !this.running && this.queue.length === 0;
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
      throw new Error("codex-cli session is closed");
    }
    if (signal?.aborted) {
      throw createAbortError(signal.reason || "codex-cli session cancelled");
    }

    return await new Promise<CodexCliResult>((resolve, reject) => {
      this.queue.push({
        input: String(input || ""),
        timeoutMs: Math.max(1, Math.floor(Number(timeoutMs) || 30_000)),
        signal,
        onEvent,
        resolve,
        reject
      });
      void this.pump();
    });
  }

  close() {
    this.closed = true;
    const error = new Error("codex-cli session closed");
    for (const job of this.queue.splice(0)) {
      job.reject(error);
    }
    try {
      this.activeRunAbortController?.abort("codex-cli session closed");
    } catch {
      // ignore
    }
  }

  private async pump() {
    if (this.closed || this.running || this.queue.length === 0) return;
    const job = this.queue.shift();
    if (!job) return;

    this.running = true;
    this.activeRunAbortController = new AbortController();
    try {
      const prompt = String(job.input || "").trim();
      const args = this.threadId
        ? buildCodexCliResumeArgs({
            model: this.model,
            threadId: this.threadId,
            prompt,
            configOverrides: this.configOverrides
          })
        : buildCodexCliBrainArgs({
            model: this.model,
            prompt,
            configOverrides: this.configOverrides
          });
      const signal = job.signal
        ? AbortSignal.any([this.activeRunAbortController.signal, job.signal])
        : this.activeRunAbortController.signal;
      const startedAtMs = Date.now();
      const result = await runCodexCli({
        args,
        input: "",
        timeoutMs: job.timeoutMs,
        maxBufferBytes: this.maxBufferBytes,
        cwd: this.cwd,
        env: this.env,
        signal,
        onStdoutLine: (line) =>
          emitProgressFromCodexJsonlLine({
            line,
            startedAtMs,
            onEvent: job.onEvent
          })
      });
      const parsed = parseCodexCliJsonlOutput(result.stdout, this.model);
      if (parsed?.threadId) {
        this.threadId = parsed.threadId;
      }
      job.resolve(result);
    } catch (error) {
      job.reject(error instanceof Error ? error : new Error(String(error || "codex CLI error")));
    } finally {
      this.activeRunAbortController = null;
      this.running = false;
      void this.pump();
    }
  }
}

export function createCodexCliStreamSession({
  model,
  maxBufferBytes = 1024 * 1024,
  cwd = "",
  configOverrides = [],
  env = {}
}: {
  model: string;
  maxBufferBytes?: number;
  cwd?: string;
  configOverrides?: string[];
  env?: CodexCliEnv;
}): CodexCliStreamSessionLike {
  const normalizedModel = String(model || "").trim();
  if (!normalizedModel) {
    throw new Error("codex-cli stream session requires a model");
  }
  return new CodexCliStreamSession({
    model: normalizedModel,
    maxBufferBytes,
    cwd,
    configOverrides,
    env
  });
}

function appendCodexConfigOverrides(args: string[], configOverrides: string[] = []) {
  for (const value of configOverrides) {
    const normalized = String(value || "").trim();
    if (!normalized) continue;
    args.push("-c", normalized);
  }
}

export function parseCodexCliJsonlOutput(rawOutput: string, model = ""): CodexCliParsedResult | null {
  const lines = String(rawOutput || "")
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);

  const textParts: string[] = [];
  let threadId = "";
  let turnUsage: Record<string, unknown> | null = null;
  let errorMessage = "";
  let isError = false;

  for (const line of lines) {
    const event = safeJsonParse(line, null) as Record<string, unknown> | null;
    if (!event || typeof event !== "object") continue;

    if (event.type === "thread.started") {
      threadId = String(event.thread_id || "").trim();
      continue;
    }

    if (event.type === "turn.completed" && event.usage && typeof event.usage === "object") {
      turnUsage = event.usage as Record<string, unknown>;
      continue;
    }

    if (event.type === "error") {
      isError = true;
      errorMessage = String(event.message || event.error || "codex-cli returned an error.").trim();
      continue;
    }

    if (event.type !== "item.completed") continue;
    const item = event.item && typeof event.item === "object" ? event.item as Record<string, unknown> : null;
    if (!item) continue;
    if (item.type !== "agent_message") continue;
    const text = String(item.text || "").trim();
    if (text) textParts.push(text);
  }

  const text = textParts.join("\n").trim();
  if (!text && !turnUsage && !threadId && !isError) return null;

  const inputTokens = Number(turnUsage?.input_tokens || 0);
  const outputTokens = Number(turnUsage?.output_tokens || 0);
  const cacheReadTokens = Number(turnUsage?.cached_input_tokens || 0);
  const costUsd = estimateUsdCost({
    provider: "codex-cli",
    model,
    inputTokens,
    outputTokens,
    cacheWriteTokens: 0,
    cacheReadTokens
  });

  return {
    text,
    isError,
    errorMessage: errorMessage || (isError ? text || "codex-cli returned an error." : ""),
    usage: {
      inputTokens,
      outputTokens,
      cacheWriteTokens: 0,
      cacheReadTokens
    },
    costUsd,
    threadId
  };
}

export function buildCodexCliBrainArgs({ model, prompt = "", outputSchemaPath = "", configOverrides = [] }: {
  model: string;
  prompt?: string;
  outputSchemaPath?: string;
  configOverrides?: string[];
}) {
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "-m", String(model || "gpt-5.4"),
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox"
  ];
  const normalizedOutputSchemaPath = String(outputSchemaPath || "").trim();
  if (normalizedOutputSchemaPath) {
    args.push("--output-schema", normalizedOutputSchemaPath);
  }
  appendCodexConfigOverrides(args, configOverrides);
  const normalizedPrompt = String(prompt || "").trim();
  if (normalizedPrompt) {
    args.push(normalizedPrompt);
  }
  return args;
}

export function buildCodexCliTextArgs({ model, prompt = "", outputSchemaPath = "", configOverrides = [] }: {
  model: string;
  prompt?: string;
  outputSchemaPath?: string;
  configOverrides?: string[];
}) {
  const args = [
    "exec",
    "--ephemeral",
    "-m", String(model || "gpt-5.4"),
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox"
  ];
  const normalizedOutputSchemaPath = String(outputSchemaPath || "").trim();
  if (normalizedOutputSchemaPath) {
    args.push("--output-schema", normalizedOutputSchemaPath);
  }
  appendCodexConfigOverrides(args, configOverrides);
  const normalizedPrompt = String(prompt || "").trim();
  if (normalizedPrompt) {
    args.push(normalizedPrompt);
  }
  return args;
}

export function buildCodexCliCodeAgentArgs({ model, cwd = "", instruction = "", configOverrides = [] }: {
  model: string;
  cwd?: string;
  instruction?: string;
  configOverrides?: string[];
}) {
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "-m", String(model || "gpt-5.4"),
    "-s", "workspace-write",
    "--dangerously-bypass-approvals-and-sandbox"
  ];
  const normalizedCwd = String(cwd || "").trim();
  if (normalizedCwd) {
    args.push("-C", normalizedCwd);
  }
  appendCodexConfigOverrides(args, configOverrides);
  const normalizedInstruction = String(instruction || "").trim();
  if (normalizedInstruction) {
    args.push(normalizedInstruction);
  }
  return args;
}

export function buildCodexCliResumeArgs({ model, threadId, prompt = "", outputSchemaPath = "", configOverrides = [] }: {
  model: string;
  threadId: string;
  prompt?: string;
  outputSchemaPath?: string;
  configOverrides?: string[];
}) {
  const args = [
    "exec",
    "resume",
    String(threadId || "").trim(),
    "--json",
    "-m", String(model || "gpt-5.4"),
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox"
  ];
  const normalizedOutputSchemaPath = String(outputSchemaPath || "").trim();
  if (normalizedOutputSchemaPath) {
    args.push("--output-schema", normalizedOutputSchemaPath);
  }
  appendCodexConfigOverrides(args, configOverrides);
  const normalizedPrompt = String(prompt || "").trim();
  if (normalizedPrompt) {
    args.push(normalizedPrompt);
  }
  return args;
}

export function createCodexCliOutputSchemaFile(jsonSchema: string) {
  const normalizedJsonSchema = String(jsonSchema || "").trim();
  if (!normalizedJsonSchema) {
    return null;
  }

  const dirPath = mkdtempSync(join(tmpdir(), "clanker-codex-schema-"));
  const filePath = join(dirPath, "schema.json");
  writeFileSync(filePath, normalizedJsonSchema, "utf8");
  return {
    path: filePath,
    cleanup() {
      rmSync(dirPath, { recursive: true, force: true });
    }
  };
}

export function normalizeCodexCliError(
  error: unknown,
  { timeoutPrefix = "codex-cli timed out", timeoutMs = 30_000 } = {}
) {
  const typedError = error as CodexCliError;
  if (typedError?.killed || typedError?.signal === "SIGTERM") {
    return {
      isTimeout: true,
      message: `${timeoutPrefix} after ${Math.max(1, Math.floor(Number(timeoutMs) || 0) / 1000)}s.`
    };
  }

  const detail = String(typedError?.stderr || typedError?.stdout || "").trim();
  return {
    isTimeout: false,
    message: detail
      ? `codex-cli error: ${typedError?.message || error} | ${detail.slice(0, 300)}`
      : `codex-cli error: ${typedError?.message || error}`
  };
}


