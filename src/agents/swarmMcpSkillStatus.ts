import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

/**
 * Detects whether the bundled `swarm-mcp` skill is installed where Claude Code
 * subagents (or other compatible hosts) will discover it. Used by the dashboard
 * to prompt operators to install the skill before enabling the code agent.
 *
 * For each configured workspace root, walks up the directory tree (up to and
 * including the user's home dir) looking for `.claude/skills/swarm-mcp/SKILL.md`
 * or `.agents/skills/swarm-mcp/SKILL.md`. A workspace root is "covered" if a
 * skill install is found at any ancestor — this matches Claude Code's own skill
 * discovery, which honors `.claude/skills/` from cwd up through parent dirs and
 * the user-level `~/.claude/skills/`.
 *
 * The check is filesystem-only (existence of `SKILL.md`); it follows symlinks
 * transparently because `existsSync` resolves them.
 */

export type SwarmMcpSkillCheckScope = "user" | "workspace";

export type SwarmMcpSkillCheck = {
  scope: SwarmMcpSkillCheckScope;
  workspaceRoot: string | null;
  /** Directory containing the skill install, if found. */
  resolvedAt: string | null;
  /** Candidate paths searched (in order). */
  searched: string[];
  installed: boolean;
};

export type SwarmMcpSkillStatus = {
  available: boolean;
  userInstalled: boolean;
  checks: SwarmMcpSkillCheck[];
  /** Workspace roots where no install was found at the root or any ancestor. */
  missingWorkspaceRoots: string[];
  /** Operator-facing hint when the skill cannot be discovered. */
  hint?: string;
};

const SKILL_REL_PATHS = [".claude/skills/swarm-mcp", ".agents/skills/swarm-mcp"] as const;

function isInstalledAt(parent: string): { installed: boolean; resolvedAt: string | null; searched: string[] } {
  const searched: string[] = [];
  for (const rel of SKILL_REL_PATHS) {
    const dir = join(parent, rel);
    searched.push(dir);
    if (existsSync(join(dir, "SKILL.md"))) {
      return { installed: true, resolvedAt: dir, searched };
    }
  }
  return { installed: false, resolvedAt: null, searched };
}

function checkUserScope(): SwarmMcpSkillCheck {
  const result = isInstalledAt(homedir());
  return {
    scope: "user",
    workspaceRoot: null,
    resolvedAt: result.resolvedAt,
    searched: result.searched,
    installed: result.installed
  };
}

function checkWorkspaceWithAncestors(workspaceRoot: string): SwarmMcpSkillCheck {
  const home = homedir();
  const fsRoot = parse(workspaceRoot).root;
  const searched: string[] = [];
  let current = resolve(workspaceRoot);
  // Walk up to home if the workspace lives under it; otherwise to the filesystem root.
  const stopAt = current === home || current.startsWith(home + "/") ? home : fsRoot;

  while (true) {
    const at = isInstalledAt(current);
    searched.push(...at.searched);
    if (at.installed) {
      return {
        scope: "workspace",
        workspaceRoot,
        resolvedAt: at.resolvedAt,
        searched,
        installed: true
      };
    }
    if (current === stopAt) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return {
    scope: "workspace",
    workspaceRoot,
    resolvedAt: null,
    searched,
    installed: false
  };
}

export function getSwarmMcpSkillStatus(
  workspaceRoots: readonly string[]
): SwarmMcpSkillStatus {
  const userCheck = checkUserScope();
  const workspaceChecks: SwarmMcpSkillCheck[] = [];
  const missingWorkspaceRoots: string[] = [];

  for (const root of workspaceRoots) {
    const trimmed = root.trim();
    if (!trimmed) continue;
    const check = checkWorkspaceWithAncestors(trimmed);
    workspaceChecks.push(check);
    if (!check.installed) missingWorkspaceRoots.push(trimmed);
  }

  const allWorkspacesCovered =
    workspaceRoots.length > 0 && missingWorkspaceRoots.length === 0;
  const available = userCheck.installed || allWorkspacesCovered;
  const checks = [userCheck, ...workspaceChecks];

  if (available) {
    return {
      available,
      userInstalled: userCheck.installed,
      checks,
      missingWorkspaceRoots
    };
  }

  return {
    available,
    userInstalled: userCheck.installed,
    checks,
    missingWorkspaceRoots,
    hint: buildHint({ workspaceRoots, missingWorkspaceRoots })
  };
}

function buildHint({
  workspaceRoots,
  missingWorkspaceRoots
}: {
  workspaceRoots: readonly string[];
  missingWorkspaceRoots: string[];
}): string {
  const userInstall =
    "`mkdir -p ~/.agents/skills ~/.claude/skills && " +
    "ln -s /absolute/path/to/swarm-mcp/skills/swarm-mcp ~/.agents/skills/swarm-mcp && " +
    "ln -s ../../.agents/skills/swarm-mcp ~/.claude/skills/swarm-mcp`";
  if (workspaceRoots.length === 0) {
    return `swarm-mcp skill not found. Install it for the current user so Claude Code subagents can discover it: ${userInstall}.`;
  }
  const example = missingWorkspaceRoots[0] || workspaceRoots[0];
  return (
    "swarm-mcp skill not installed at any workspace root or ancestor. Pick a scope: " +
    `user-level (${userInstall}) ` +
    `or project-level — e.g. inside ${example}: ` +
    "`mkdir -p .agents/skills .claude/skills && " +
    "ln -s /absolute/path/to/swarm-mcp/skills/swarm-mcp .agents/skills/swarm-mcp && " +
    "ln -s ../../.agents/skills/swarm-mcp .claude/skills/swarm-mcp`."
  );
}
