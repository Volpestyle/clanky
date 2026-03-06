import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { clampInt } from "../normalization/numbers.ts";
import { safeJsonParseFromString } from "../normalization/valueParsers.ts";

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
  run: (payload: { input?: string; timeoutMs?: number }) => Promise<CodexCliResult>;
  close: () => void;
  isIdle: () => boolean;
};

type PendingJob = {
  input: string;
  timeoutMs: number;
  resolve: (result: CodexCliResult) => void;
  reject: (error: Error) => void;
};

function safeJsonParse(value: string, fallback: unknown = null) {
  return safeJsonParseFromString(value, fallback);
}

export function runCodexCli({ args, input, timeoutMs, maxBufferBytes, cwd = "" }: {
  args: string[];
  input?: string;
  timeoutMs: number;
  maxBufferBytes: number;
  cwd?: string;
}) {
  return new Promise<CodexCliResult>((resolve, reject) => {
    const spawnOptions: { stdio: ["pipe", "pipe", "pipe"]; cwd?: string } = { stdio: ["pipe", "pipe", "pipe"] };
    const normalizedCwd = String(cwd || "").trim();
    if (normalizedCwd) spawnOptions.cwd = normalizedCwd;
    const child = spawn("codex", args, spawnOptions);
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;

    const finish = (error: Error | null, result?: CodexCliResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
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
  private closed: boolean;
  private running: boolean;
  private readonly queue: PendingJob[];
  private threadId: string;

  constructor({ model, maxBufferBytes, cwd = "" }: { model: string; maxBufferBytes: number; cwd?: string }) {
    this.model = String(model || "").trim();
    this.maxBufferBytes = Math.max(4096, Math.floor(Number(maxBufferBytes) || 1024 * 1024));
    this.cwd = String(cwd || "").trim();
    this.closed = false;
    this.running = false;
    this.queue = [];
    this.threadId = "";
  }

  isIdle() {
    return !this.running && this.queue.length === 0;
  }

  async run({ input = "", timeoutMs = 30_000 }: { input?: string; timeoutMs?: number }) {
    if (this.closed) {
      throw new Error("codex-cli session is closed");
    }

    return await new Promise<CodexCliResult>((resolve, reject) => {
      this.queue.push({
        input: String(input || ""),
        timeoutMs: Math.max(1, Math.floor(Number(timeoutMs) || 30_000)),
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
  }

  private async pump() {
    if (this.closed || this.running || this.queue.length === 0) return;
    const job = this.queue.shift();
    if (!job) return;

    this.running = true;
    try {
      const prompt = String(job.input || "").trim();
      const args = this.threadId
        ? buildCodexCliResumeArgs({ model: this.model, threadId: this.threadId, prompt })
        : buildCodexCliBrainArgs({ model: this.model, prompt });
      const result = await runCodexCli({
        args,
        input: "",
        timeoutMs: job.timeoutMs,
        maxBufferBytes: this.maxBufferBytes,
        cwd: this.cwd
      });
      const parsed = parseCodexCliJsonlOutput(result.stdout);
      if (parsed?.threadId) {
        this.threadId = parsed.threadId;
      }
      job.resolve(result);
    } catch (error) {
      job.reject(error instanceof Error ? error : new Error(String(error || "codex CLI error")));
    } finally {
      this.running = false;
      void this.pump();
    }
  }
}

export function createCodexCliStreamSession({
  model,
  maxBufferBytes = 1024 * 1024,
  cwd = ""
}: {
  model: string;
  maxBufferBytes?: number;
  cwd?: string;
}): CodexCliStreamSessionLike {
  const normalizedModel = String(model || "").trim();
  if (!normalizedModel) {
    throw new Error("codex-cli stream session requires a model");
  }
  return new CodexCliStreamSession({
    model: normalizedModel,
    maxBufferBytes,
    cwd
  });
}

export function parseCodexCliJsonlOutput(rawOutput: string): CodexCliParsedResult | null {
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

  return {
    text,
    isError,
    errorMessage: errorMessage || (isError ? text || "codex-cli returned an error." : ""),
    usage: {
      inputTokens: Number(turnUsage?.input_tokens || 0),
      outputTokens: Number(turnUsage?.output_tokens || 0),
      cacheWriteTokens: 0,
      cacheReadTokens: Number(turnUsage?.cached_input_tokens || 0)
    },
    costUsd: 0,
    threadId
  };
}

export function buildCodexCliBrainArgs({ model, prompt = "", outputSchemaPath = "" }: {
  model: string;
  prompt?: string;
  outputSchemaPath?: string;
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
  const normalizedPrompt = String(prompt || "").trim();
  if (normalizedPrompt) {
    args.push(normalizedPrompt);
  }
  return args;
}

export function buildCodexCliTextArgs({ model, prompt = "", outputSchemaPath = "" }: {
  model: string;
  prompt?: string;
  outputSchemaPath?: string;
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
  const normalizedPrompt = String(prompt || "").trim();
  if (normalizedPrompt) {
    args.push(normalizedPrompt);
  }
  return args;
}

export function buildCodexCliCodeAgentArgs({ model, cwd = "", instruction = "" }: {
  model: string;
  cwd?: string;
  instruction?: string;
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
  const normalizedInstruction = String(instruction || "").trim();
  if (normalizedInstruction) {
    args.push(normalizedInstruction);
  }
  return args;
}

export function buildCodexCliResumeArgs({ model, threadId, prompt = "", outputSchemaPath = "" }: {
  model: string;
  threadId: string;
  prompt?: string;
  outputSchemaPath?: string;
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

export function buildCodexCliMemoryExtractionPrompt({ systemPrompt = "", userPrompt = "" }: {
  systemPrompt?: string;
  userPrompt?: string;
}) {
  return [String(systemPrompt || "").trim(), String(userPrompt || "").trim()].filter(Boolean).join("\n\n");
}

export function clampCodexCliMaxTurns(value: unknown, fallback = 30) {
  return clampInt(value, 1, Math.max(1, clampInt(fallback, 1, 10_000)));
}
