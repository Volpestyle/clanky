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
  workerMode = "one_shot",
  coordinationSkill = ""
}: {
  serverName?: string;
  taskId?: string | null;
  workerMode?: SwarmLauncherWorkerMode;
  /**
   * Optional role-specific swarm-mcp skill (`SKILL.md` + role reference)
   * loaded from the vendored submodule. Appended after the Clanky-specific
   * overlays so the worker has the canonical playbook in-context from turn 1
   * without relying on the host harness's on-disk skill discovery.
   *
   * The skill is the source of truth for general coordination patterns
   * (when to register, claim, lock, annotate). The preamble keeps only the
   * deltas Clanky imposes on top of that — auto-adoption, the assigned task
   * id, the usage-annotation shape, and the plain-text result override.
   */
  coordinationSkill?: string;
} = {}): string {
  const lines: string[] = [
    `You are running as a Clanky-spawned swarm peer. Your identity has been reserved and your swarm-mcp server (\`${serverName}\`) auto-adopted you on boot — do not call \`register\`.`
  ];

  const trimmedTaskId = String(taskId || "").trim();
  if (trimmedTaskId) {
    lines.push(
      "",
      `Your assigned task is \`${trimmedTaskId}\`. The full coordination playbook follows in the swarm-mcp skill below — read and follow it. Two Clanky-specific overlays apply on top of the skill:`
    );
  } else {
    lines.push(
      "",
      "No task is pre-assigned. The full coordination playbook follows in the swarm-mcp skill below — read and follow it. Two Clanky-specific overlays apply on top of the skill:"
    );
  }

  lines.push(
    "",
    "1. **Cost/usage telemetry.** Report token/cost numbers as a sibling annotation, not in `update_task.metadata`:",
    "   `annotate(file=<task_id>, kind=\"usage\", content=JSON.stringify({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd }))`",
    "   Clanky reads usage from this annotation; anything in `update_task.metadata` is ignored.",
    "",
    "2. **Result format.** Post the final user-facing output text directly in `update_task(status=\"done\", result=<text>)` as plain text — not structured JSON. Clanky surfaces this verbatim to the requesting user."
  );

  if (workerMode === "inbox_loop") {
    lines.push(
      "",
      "**Inbox-loop mode.** After `update_task(done)`, do not exit. Poll your inbox via `wait_for_activity` and `list_messages`. Treat each `send_message` you receive as a follow-up instruction; claim or create the appropriate follow-up task, execute, and report again with `update_task` + `annotate(kind=\"usage\")`. Exit when you receive an explicit termination message or your idle timeout elapses."
    );
  }

  const trimmedSkill = String(coordinationSkill || "").trim();
  if (trimmedSkill) {
    lines.push(
      "",
      "---",
      "",
      "## Swarm coordination skill",
      "",
      trimmedSkill
    );
  }

  return lines.join("\n");
}
