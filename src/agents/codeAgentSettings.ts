import path from "node:path";
import os from "node:os";
import {
  getDevTaskPermissions,
  getDevTeamRuntimeConfig,
  isDevTaskUserAllowed,
  resolveAgentStack
} from "../settings/agentStack.ts";
import { clamp } from "../utils.ts";
import {
  resolveCodeAgentSwarmRuntimeConfig,
  type CodeAgentSwarmRuntimeConfig
} from "./codeAgentSwarm.ts";

type CodeAgentProvider = "codex-cli" | "claude-code" | "auto";
export type CodeAgentRole = "design" | "implementation" | "review" | "research";

const CODE_AGENT_PROVIDER_VALUES = new Set<CodeAgentProvider>(["codex-cli", "claude-code", "auto"]);
const CODE_AGENT_ROLE_VALUES = new Set<CodeAgentRole>(["design", "implementation", "review", "research"]);

function normalizeCodeAgentProvider(value: unknown, fallback: CodeAgentProvider = "codex-cli"): CodeAgentProvider {
  const normalized = String(value || "")
    .trim()
    .toLowerCase() as CodeAgentProvider;
  if (CODE_AGENT_PROVIDER_VALUES.has(normalized)) return normalized;
  return fallback;
}

export function normalizeCodeAgentRole(value: unknown, fallback: CodeAgentRole = "implementation"): CodeAgentRole {
  const normalized = String(value || "")
    .trim()
    .toLowerCase() as CodeAgentRole;
  if (CODE_AGENT_ROLE_VALUES.has(normalized)) return normalized;
  return fallback;
}

export function isCodeAgentUserAllowed(userId: string, settings: Record<string, unknown>): boolean {
  const devRuntime = getDevTeamRuntimeConfig(settings);
  if (!devRuntime.codexCli?.enabled && !devRuntime.claudeCode?.enabled) return false;
  return isDevTaskUserAllowed(settings, userId);
}

function expandHomePath(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith(`~${path.sep}`) || value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function resolveCodeAgentCwd(settingsCwd: string, fallbackBaseDir: string): string {
  const raw = String(settingsCwd || "").trim();
  if (raw) return path.resolve(fallbackBaseDir, expandHomePath(raw));
  return path.resolve(fallbackBaseDir);
}

export function resolveAllowedCodeWorkspaceRoots(settings: Record<string, unknown>): string[] {
  const permissions = getDevTaskPermissions(settings);
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const value of permissions.allowedWorkspaceRoots || []) {
    const raw = String(value || "").trim();
    if (!raw) continue;
    const resolved = path.resolve(process.cwd(), expandHomePath(raw));
    const key = resolved.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(resolved);
  }
  return roots;
}

export function resolveCodeAgentLaunchCwd(
  settings: Record<string, unknown>,
  cwdOverride: string | undefined,
  configuredDefaultCwd: unknown
): string {
  const rawDefaultCwd = String(configuredDefaultCwd || "").trim();
  const fallbackBaseDir = rawDefaultCwd
    ? resolveCodeAgentCwd(rawDefaultCwd, process.cwd())
    : resolveAllowedCodeWorkspaceRoots(settings)[0] || process.cwd();
  const rawOverride = String(cwdOverride || "").trim();
  if (rawOverride) return resolveCodeAgentCwd(rawOverride, fallbackBaseDir);
  return fallbackBaseDir;
}

export interface CodeAgentConfig {
  role: CodeAgentRole;
  worker: "codex_cli" | "claude_code";
  cwd: string;
  swarm: CodeAgentSwarmRuntimeConfig | null;
  provider: CodeAgentProvider;
  model: string;
  codexCliModel: string;
  maxTurns: number;
  timeoutMs: number;
  maxBufferBytes: number;
  maxTasksPerHour: number;
  maxParallelTasks: number;
}

function getPreferredWorkerForRole(
  resolvedStack: ReturnType<typeof resolveAgentStack>,
  role: CodeAgentRole
): "codex_cli" | "claude_code" {
  if (role === "design") {
    return resolvedStack.devTeam.roles.design || resolvedStack.devTeam.codingWorkers[0] || "codex_cli";
  }
  if (role === "review") {
    return resolvedStack.devTeam.roles.review || resolvedStack.devTeam.codingWorkers[0] || "codex_cli";
  }
  if (role === "research") {
    return resolvedStack.devTeam.roles.research || resolvedStack.devTeam.codingWorkers[0] || "codex_cli";
  }
  return resolvedStack.devTeam.roles.implementation || resolvedStack.devTeam.codingWorkers[0] || "codex_cli";
}

export function resolveCodeAgentConfig(
  settings: Record<string, unknown>,
  cwdOverride?: string,
  requestedRole: CodeAgentRole = "implementation"
): CodeAgentConfig {
  const resolvedStack = resolveAgentStack(settings);
  const devRuntime = getDevTeamRuntimeConfig(settings);
  const role = normalizeCodeAgentRole(requestedRole);
  const preferredWorker = getPreferredWorkerForRole(resolvedStack, role);
  const primaryWorkerConfig =
    preferredWorker === "codex_cli"
      ? devRuntime.codexCli
      : devRuntime.claudeCode;
  const cwd = resolveCodeAgentLaunchCwd(settings, cwdOverride, primaryWorkerConfig?.defaultCwd);
  const swarm = resolveCodeAgentSwarmRuntimeConfig(devRuntime.swarm);
  const provider = normalizeCodeAgentProvider(
    preferredWorker === "codex_cli"
      ? "codex-cli"
      : "claude-code",
    "codex-cli"
  );
  const model = String(devRuntime.claudeCode?.model || "sonnet").trim();
  const codexCliModel = String(devRuntime.codexCli?.model || "gpt-5.4").trim() || "gpt-5.4";
  const maxTurns = clamp(Number(primaryWorkerConfig?.maxTurns) || 30, 1, 200);
  const timeoutMs = clamp(Number(primaryWorkerConfig?.timeoutMs) || 300_000, 10_000, 1_800_000);
  const maxBufferBytes = clamp(Number(primaryWorkerConfig?.maxBufferBytes) || 2 * 1024 * 1024, 4096, 10 * 1024 * 1024);
  const maxTasksPerHour = clamp(Number(primaryWorkerConfig?.maxTasksPerHour) || 10, 1, 500);
  const maxParallelTasks = clamp(Number(primaryWorkerConfig?.maxParallelTasks) || 2, 1, 32);

  return {
    role,
    worker: preferredWorker,
    cwd,
    swarm,
    provider,
    model,
    codexCliModel,
    maxTurns,
    timeoutMs,
    maxBufferBytes,
    maxTasksPerHour,
    maxParallelTasks
  };
}
