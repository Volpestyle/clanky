import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Detects whether the bundled `swarm-mcp` skill is installed where Claude Code
 * subagents (or other compatible hosts) will discover it. Used by the dashboard
 * to prompt operators to install the skill before enabling the code agent —
 * without it, code workers still register against the swarm MCP server, but
 * agents lack the bundled coordination playbook.
 *
 * The skill is "available" if either:
 *   - it is installed globally (`~/.claude/skills/swarm-mcp` or
 *     `~/.agents/skills/swarm-mcp`), OR
 *   - every configured workspace root has a project-local install at
 *     `<root>/.claude/skills/swarm-mcp` or `<root>/.agents/skills/swarm-mcp`.
 *
 * The check is filesystem-only (existence of `SKILL.md`); it follows symlinks
 * transparently because `existsSync` resolves them.
 */

export type SwarmMcpSkillCheckScope = "global" | "workspace";

export type SwarmMcpSkillCheck = {
  scope: SwarmMcpSkillCheckScope;
  workspaceRoot: string | null;
  path: string;
  installed: boolean;
};

export type SwarmMcpSkillStatus = {
  available: boolean;
  globalInstalled: boolean;
  checks: SwarmMcpSkillCheck[];
  /** Workspace roots that lack a project-local install (only relevant when global is missing). */
  missingWorkspaceRoots: string[];
  /** Operator-facing hint when the skill cannot be discovered. */
  hint?: string;
};

const SKILL_REL_PATHS = [".claude/skills/swarm-mcp", ".agents/skills/swarm-mcp"] as const;

function checkAtRoot(root: string, scope: SwarmMcpSkillCheckScope): SwarmMcpSkillCheck[] {
  return SKILL_REL_PATHS.map((rel) => {
    const path = join(root, rel);
    return {
      scope,
      workspaceRoot: scope === "workspace" ? root : null,
      path,
      installed: existsSync(join(path, "SKILL.md"))
    };
  });
}

function rootHasInstall(checks: SwarmMcpSkillCheck[]): boolean {
  return checks.some((check) => check.installed);
}

export function getSwarmMcpSkillStatus(
  workspaceRoots: readonly string[]
): SwarmMcpSkillStatus {
  const home = homedir();
  const globalChecks = checkAtRoot(home, "global");
  const globalInstalled = rootHasInstall(globalChecks);

  const workspaceChecks: SwarmMcpSkillCheck[] = [];
  const missingWorkspaceRoots: string[] = [];
  for (const root of workspaceRoots) {
    const trimmed = root.trim();
    if (!trimmed) continue;
    const checks = checkAtRoot(trimmed, "workspace");
    workspaceChecks.push(...checks);
    if (!rootHasInstall(checks)) missingWorkspaceRoots.push(trimmed);
  }

  const allWorkspacesInstalled =
    workspaceRoots.length > 0 && missingWorkspaceRoots.length === 0;
  const available = globalInstalled || allWorkspacesInstalled;
  const checks = [...globalChecks, ...workspaceChecks];

  if (available) {
    return { available, globalInstalled, checks, missingWorkspaceRoots };
  }

  const hint = buildHint({ globalInstalled, workspaceRoots, missingWorkspaceRoots });
  return { available, globalInstalled, checks, missingWorkspaceRoots, hint };
}

function buildHint({
  globalInstalled,
  workspaceRoots,
  missingWorkspaceRoots
}: {
  globalInstalled: boolean;
  workspaceRoots: readonly string[];
  missingWorkspaceRoots: string[];
}): string {
  if (workspaceRoots.length === 0) {
    return (
      "swarm-mcp skill not found. Install it globally so Claude Code subagents can discover it: " +
      "`mkdir -p ~/.claude/skills && ln -s /absolute/path/to/swarm-mcp/skills/swarm-mcp ~/.claude/skills/swarm-mcp` " +
      "(or set up an allowed workspace root with a project-local symlink under `.claude/skills/swarm-mcp`)."
    );
  }

  const example = missingWorkspaceRoots[0] || workspaceRoots[0];
  const baseHint = globalInstalled
    ? "swarm-mcp skill found globally but missing in some configured workspace roots — install per-workspace or rely on the global copy."
    : "swarm-mcp skill not installed. Code workers can still run, but Claude Code subagents will not have the bundled coordination playbook.";

  return (
    `${baseHint} ` +
    `For each workspace root, e.g. ${example}: ` +
    "`mkdir -p .agents/skills .claude/skills && " +
    "ln -s /absolute/path/to/swarm-mcp/skills/swarm-mcp .agents/skills/swarm-mcp && " +
    "ln -s ../../.agents/skills/swarm-mcp .claude/skills/swarm-mcp`. " +
    "Or install once globally: " +
    "`mkdir -p ~/.claude/skills && ln -s /absolute/path/to/swarm-mcp/skills/swarm-mcp ~/.claude/skills/swarm-mcp`."
  );
}
