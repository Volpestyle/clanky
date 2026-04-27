export type CodeAgentSwarmRuntimeConfig = {
  enabled: boolean;
  serverName: string;
  command: string;
  args: string[];
  dbPath: string;
  appendCoordinationPrompt: boolean;
  allowDirectChildFallback: boolean;
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
    appendCoordinationPrompt: rawValue.appendCoordinationPrompt !== false,
    allowDirectChildFallback: rawValue.allowDirectChildFallback === true
  };
}

export function applySwarmLauncherFirstTurnPreamble(input: string, preamble?: string | null) {
  const normalizedInput = String(input || "").trim();
  const normalizedPreamble = String(preamble || "").trim();
  if (!normalizedPreamble) return normalizedInput;
  if (!normalizedInput) return normalizedPreamble;
  return `${normalizedPreamble}\n\nTask:\n${normalizedInput}`;
}

/**
 * Default seconds the worker should spend listening for follow-up messages
 * after `update_task(done)` before exiting. Sized to comfortably cover a
 * typical Discord follow-up cadence (user reads result, reacts, asks a
 * follow-up within a few minutes) so the orchestrator can reuse the live
 * worker rather than re-spawning fresh each turn.
 *
 * Tradeoff: idle listening workers count against `maxParallelTasks` for
 * the duration. Operators with tight worker-count budgets should either
 * bump that cap or shorten this window.
 */
export const SWARM_LAUNCHER_FOLLOWUP_LISTEN_SECONDS = 300;

/**
 * Behavioral preamble for swarm-launcher workers. Their instance row is already
 * reserved with `adopted=0` and the worker's swarm-mcp child auto-adopts via
 * `SWARM_MCP_INSTANCE_ID` on boot — no `register` call needed.
 *
 * Aligned with the worker contract at docs/architecture/swarm-worker-contract.md:
 * - usage/cost telemetry travels as a sibling `annotate(kind="usage")` call,
 *   not as `update_task.metadata`. The task waiter reads from the `context`
 *   table, not from task metadata.
 * - every worker has a brief follow-up listen window after the assigned task
 *   completes. The orchestrator decides per-turn whether to follow up; the
 *   worker just stays available briefly. There is no worker-mode decision —
 *   if no follow-up arrives in the window, exit cleanly.
 * - `appendCoordinationPrompt=false` disables both installed-skill discovery
 *   and the inlined generic skill fallback. The Clanky-specific
 *   identity/task/result/follow-up overlays always remain, because workers
 *   need them to interoperate with the launcher.
 */
export function buildSwarmLauncherFirstTurnPreamble({
  serverName = "swarm",
  taskId,
  coordinationSkill = "",
  skillReachableAt = null
}: {
  serverName?: string;
  taskId?: string | null;
  /**
   * Inlined role-specific swarm-mcp skill (`SKILL.md` + role reference) loaded
   * from the vendored submodule. Used as a fallback ONLY when the skill isn't
   * reachable on disk for the worker harness's discovery (see
   * `skillReachableAt`). When set, the full text is appended so the worker
   * has the canonical playbook in-context from turn 1.
   *
   * Prefer leaving this empty and providing `skillReachableAt` instead — the
   * harness will auto-load the on-disk skill, saving ~3 KB of preamble tokens.
   *
   * The skill is the source of truth for general coordination patterns (when
   * to register, claim, lock, annotate). The preamble keeps only the deltas
   * Clanky imposes on top of that — auto-adoption, the assigned task id, the
   * usage-annotation shape, and the plain-text result override.
   */
  coordinationSkill?: string;
  /**
   * Path where the swarm-mcp skill is installed on disk (e.g.
   * `~/.agents/skills/swarm-mcp` or `<workspace>/.claude/skills/swarm-mcp`).
   * When set AND `coordinationSkill` is empty, the preamble emits a short
   * directive pointing the worker at on-disk discovery instead of inlining
   * the full skill text.
   */
  skillReachableAt?: string | null;
} = {}): string {
  const lines: string[] = [
    `You are running as a Clanky-spawned swarm peer. Your identity has been reserved and your swarm-mcp server (\`${serverName}\`) auto-adopted you on boot — do not call \`register\`.`
  ];

  const trimmedTaskId = String(taskId || "").trim();
  if (trimmedTaskId) {
    lines.push(
      "",
      `Your assigned task is \`${trimmedTaskId}\`. Read and follow the coordination playbook below, but the Clanky-specific rules in this preamble override any conflicting generic skill guidance.`
    );
  } else {
    lines.push(
      "",
      "No task is pre-assigned. Read and follow the coordination playbook below, but the Clanky-specific rules in this preamble override any conflicting generic skill guidance."
    );
  }

  lines.push(
    "",
    "1. **Registration override.** Do not call `register`, even if the generic swarm-mcp skill says to register early. Use `whoami` if you need to confirm identity; your MCP server already adopted the reserved row.",
    "",
    "2. **Cost/usage telemetry.** Report token/cost numbers as a sibling annotation, not in `update_task.metadata`:",
    "   `annotate(file=<task_id>, kind=\"usage\", content=JSON.stringify({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd }))`",
    "   Clanky reads usage from this annotation; anything in `update_task.metadata` is ignored.",
    "",
    "3. **Result format override.** Post the final user-facing output text directly in `update_task(status=\"done\", result=<text>)` as plain text — not structured JSON — even if the generic skill prefers JSON results. Clanky uses this text as input to its final synthesis step.",
    "",
    "4. **Git authority.** Do not commit, push, create pull requests, or rewrite git history unless the user explicitly asked for that in the task. You may inspect git status/diff and leave changes in the working tree.",
    "",
    `5. **Follow-up listen window.** After \`update_task(done)\`, wait roughly ${SWARM_LAUNCHER_FOLLOWUP_LISTEN_SECONDS}s for follow-up messages via \`wait_for_activity\` / \`list_messages\`. If a \`send_message\` arrives in that window, treat it as a follow-up instruction — claim or create the appropriate follow-up task, execute, and report again with \`update_task\` + \`annotate(kind="usage")\`, then return to listening. If no follow-up arrives in the window, or you receive an explicit termination message, exit cleanly. The orchestrator decides per-turn whether to drive more work; you just stay briefly available.`
  );

  const trimmedSkill = String(coordinationSkill || "").trim();
  const trimmedSkillPath = String(skillReachableAt || "").trim();
  if (trimmedSkill) {
    // Fallback path: skill not reachable on disk for the harness — inline the
    // full text so the worker still has the playbook from turn 1.
    lines.push(
      "",
      "---",
      "",
      "## Swarm coordination skill",
      "",
      trimmedSkill
    );
  } else if (trimmedSkillPath) {
    // Discovery path: skill is installed on disk and the harness should
    // surface it as the `swarm-mcp` skill. Tiny directive instead of ~3 KB
    // of inlined text. The Clanky overrides above still take precedence
    // over any conflicting generic guidance in the skill.
    lines.push(
      "",
      "---",
      "",
      `**Coordination playbook.** The swarm-mcp skill is installed at \`${trimmedSkillPath}\`. Load it on your first turn via your harness's skill mechanism (e.g. \`/skills swarm-mcp\` in Claude Code, or read \`SKILL.md\` and the matching \`references/<role>.md\` directly with your file-read tool). The Clanky-specific overrides above take precedence over any conflicting generic guidance in the skill.`
    );
  }

  return lines.join("\n");
}
