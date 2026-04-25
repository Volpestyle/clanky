import type { CodeAgentWorkspaceLease } from "./codeAgentWorkspace.ts";

export type CodeAgentSwarmRuntimeConfig = {
  enabled: boolean;
  serverName: string;
  command: string;
  args: string[];
  dbPath: string;
  appendCoordinationPrompt: boolean;
};

export type CodeAgentSwarmSessionConfig = {
  serverName: string;
  scope: string;
  fileRoot: string;
  label: string;
  env: Record<string, string>;
  codexConfigOverrides: string[];
  claudeMcpConfig: string;
  firstTurnPreamble: string;
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

function tomlLiteralString(value: string) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function tomlLiteralArray(values: string[]) {
  return `[${values.map((value) => tomlLiteralString(value)).join(", ")}]`;
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

function buildSwarmLabel({
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

export function buildCodeAgentSwarmSessionConfig({
  runtime,
  workspace,
  provider,
  role,
  thread,
  user
}: {
  runtime: CodeAgentSwarmRuntimeConfig | null;
  workspace: CodeAgentWorkspaceLease;
  provider: "claude-code" | "codex-cli";
  role?: string | null;
  thread?: string | null;
  user?: string | null;
}): CodeAgentSwarmSessionConfig | null {
  if (!runtime?.enabled) return null;
  if (!runtime.command) {
    throw new Error("Code-agent swarm is enabled, but agentStack.runtimeConfig.devTeam.swarm.command is empty.");
  }

  const label = buildSwarmLabel({ provider, role, thread, user });
  const env = runtime.dbPath
    ? {
        SWARM_DB_PATH: runtime.dbPath
      }
    : {};
  const registerPayload = {
    directory: workspace.cwd,
    scope: workspace.repoRoot,
    file_root: workspace.canonicalCwd,
    label
  };
  const workspaceSummary =
    workspace.mode === "shared_checkout"
      ? "This session is running in the shared checkout. Register this live repo path before using other swarm tools so locks, annotations, and task file references point at the same workspace other local agents can see."
      : "This session is running inside a disposable git worktree. Register against the canonical repo paths before using other swarm tools so locks, annotations, and task file references stay stable across worktrees.";
  const firstTurnPreamble = runtime.appendCoordinationPrompt
    ? [
        `Swarm coordination is available through the MCP server \`${runtime.serverName}\`.`,
        workspaceSummary,
        "Use the swarm register tool with this payload:",
        `\`\`\`json\n${JSON.stringify(registerPayload, null, 2)}\n\`\`\``,
        "After registration, normal relative paths from your current working directory are valid for swarm file tools. When choosing collaborators, inspect swarm instance labels for machine-readable tokens like `role:planner`, `role:reviewer`, or `role:implementer`. If a session has no `role:` token, treat it as a generalist. Use swarm messages/tasks when collaboration is useful, lock files before editing, unlock them when finished, and annotate important findings or hazards when they would help other agents."
      ].join("\n\n")
    : "";

  return {
    serverName: runtime.serverName,
    scope: workspace.repoRoot,
    fileRoot: workspace.canonicalCwd,
    label,
    env,
    codexConfigOverrides: [
      `mcp_servers.${runtime.serverName}.command=${tomlLiteralString(runtime.command)}`,
      `mcp_servers.${runtime.serverName}.args=${tomlLiteralArray(runtime.args)}`
    ],
    claudeMcpConfig: JSON.stringify({
      [runtime.serverName]: {
        type: "stdio",
        command: runtime.command,
        args: runtime.args,
        env
      }
    }),
    firstTurnPreamble
  };
}

export function applyCodeAgentFirstTurnPreamble(input: string, preamble?: string | null) {
  const normalizedInput = String(input || "").trim();
  const normalizedPreamble = String(preamble || "").trim();
  if (!normalizedPreamble) return normalizedInput;
  if (!normalizedInput) return normalizedPreamble;
  return `${normalizedPreamble}\n\nTask:\n${normalizedInput}`;
}
