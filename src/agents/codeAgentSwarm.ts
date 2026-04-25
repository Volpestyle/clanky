export type CodeAgentSwarmRuntimeConfig = {
  enabled: boolean;
  serverName: string;
  command: string;
  args: string[];
  dbPath: string;
  appendCoordinationPrompt: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeServerName(value: unknown, fallback = "swarm") {
  const normalized = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/g, "")
    .replace(/-+$/g, "");
  return normalized || fallback;
}

function normalizeStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function normalizeSwarmRoleToken(role?: string | null) {
  const normalized = String(role || "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  if (normalized === "design") return "planner";
  if (normalized === "implementation") return "implementer";
  if (normalized === "review") return "reviewer";
  if (normalized === "research") return "researcher";
  const sanitized = normalized
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/g, "")
    .replace(/-+$/g, "");
  return sanitized || null;
}

function normalizeLabelToken(value: unknown, fallback: string) {
  const sanitized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/g, "")
    .replace(/-+$/g, "");
  return sanitized || fallback;
}

export function buildSwarmLabel({
  provider,
  role,
  thread,
  user
}: {
  provider: "claude-code" | "codex-cli";
  role?: string | null;
  thread?: string | null;
  user?: string | null;
}) {
  const tokens = [`origin:clanky`, `provider:${provider}`];
  const roleToken = normalizeSwarmRoleToken(role);
  if (roleToken) {
    tokens.push(`role:${roleToken}`);
  }
  tokens.push(`thread:${normalizeLabelToken(thread, "dm")}`);
  tokens.push(`user:${normalizeLabelToken(user, "anon")}`);
  return tokens.join(" ");
}

export function resolveCodeAgentSwarmRuntimeConfig(rawValue: unknown): CodeAgentSwarmRuntimeConfig | null {
  if (!isRecord(rawValue)) return null;
  const enabled = rawValue.enabled === true;
  if (!enabled) return null;
  return {
    enabled: true,
    serverName: normalizeServerName(rawValue.serverName),
    command: String(rawValue.command || "").trim(),
    args: normalizeStringArray(rawValue.args),
    dbPath: String(rawValue.dbPath || "").trim(),
    appendCoordinationPrompt: rawValue.appendCoordinationPrompt !== false
  };
}

export function applySwarmLauncherFirstTurnPreamble(input: string, preamble?: string | null) {
  const normalizedInput = String(input || "").trim();
  const normalizedPreamble = String(preamble || "").trim();
  if (!normalizedPreamble) return normalizedInput;
  if (!normalizedInput) return normalizedPreamble;
  return `${normalizedPreamble}\n\nTask:\n${normalizedInput}`;
}

export type SwarmLauncherWorkerMode = "one_shot" | "inbox_loop";

/**
 * Behavioral-only preamble for swarm-launcher workers. Their instance row is
 * already reserved with `adopted=0` and the worker's swarm-mcp child auto-
 * adopts via `SWARM_MCP_INSTANCE_ID` on boot — no `register` call needed.
 *
 * Aligned with the worker contract at docs/architecture/swarm-worker-contract.md:
 * - usage/cost telemetry travels as a sibling `annotate(kind="usage")` call,
 *   not as `update_task.metadata`. The task waiter reads from the `context`
 *   table, not from task metadata.
 * - workerMode toggles §2a one-shot vs inbox-loop semantics. Default one-shot.
 *
 */
export function buildSwarmLauncherFirstTurnPreamble({
  serverName = "swarm",
  taskId,
  workerMode = "one_shot"
}: {
  serverName?: string;
  taskId?: string | null;
  workerMode?: SwarmLauncherWorkerMode;
} = {}): string {
  const lines: string[] = [
    `You are running as a swarm peer. Your identity has been reserved and your swarm-mcp server (\`${serverName}\`) auto-adopted you on boot — do not call \`register\`.`,
    "",
    "Coordination contract:"
  ];
  const trimmedTaskId = String(taskId || "").trim();
  if (trimmedTaskId) {
    lines.push(
      `- Your task is reserved as id \`${trimmedTaskId}\`. Use \`claim_task\` on it before starting work, then complete the task below.`
    );
  } else {
    lines.push("- Read the task below and execute it directly.");
  }
  lines.push(
    "- When complete, call `update_task` on your assigned task with status=\"done\" and a `result` field containing the final user-facing output text.",
    "- Report cost/usage as a sibling annotation on the same task: `annotate(file=<task_id>, kind=\"usage\", content=JSON.stringify({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd }))`. Do not pack usage into `update_task.metadata` — Clanky reads it from the annotation.",
    "- On unrecoverable error, call `update_task` with status=\"failed\" and a clear error message in `result`.",
    "- Other peers in this scope are visible via `list_instances`. Use `lock_file` before editing shared files, `unlock_file` when done, and `annotate` hazards or progress notes that would help collaborators."
  );

  if (workerMode === "inbox_loop") {
    lines.push(
      "",
      "Inbox-loop mode:",
      "- After `update_task(done)`, do not exit. Poll your inbox via `wait_for_activity` and `list_messages`.",
      "- Treat each `send_message` you receive as a follow-up instruction. Claim or create the appropriate follow-up task, execute, and report again with `update_task` + `annotate(kind=\"usage\")`.",
      "- Exit when you receive an explicit termination message in your inbox or when your idle timeout elapses."
    );
  }

  return lines.join("\n");
}
