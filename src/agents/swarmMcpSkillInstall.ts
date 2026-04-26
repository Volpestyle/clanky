import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Dashboard-driven installer for the bundled `swarm-mcp` skill. Symlinks the
 * vendored submodule copy at `mcp-servers/swarm-mcp/skills/swarm-mcp` into
 * either `~/.claude/skills/` (global) or a per-workspace `.claude/skills/`
 * + `.agents/skills/` pair (mirroring swarm-mcp's own dual-symlink convention).
 *
 * Idempotent: a correct symlink is left in place; a non-symlink at the target
 * path is treated as an error so we never overwrite operator-managed content.
 */

const SKILL_NAME = "swarm-mcp";
const CLAUDE_REL_TARGET = "../../.agents/skills/swarm-mcp";

export type SkillInstallScope = "global" | "workspace";

export type SkillInstallRequest = {
  scope: SkillInstallScope;
  workspaceRoot?: string;
};

export type SkillInstallResult = {
  ok: boolean;
  reason?: string;
  source?: string;
  created: string[];
  skipped: string[];
};

function getSkillSourcePath(): string {
  return resolve(
    import.meta.dir,
    "..",
    "..",
    "mcp-servers",
    "swarm-mcp",
    "skills",
    SKILL_NAME
  );
}

function symlinkMatches(linkPath: string, expectedTarget: string): boolean {
  try {
    const stat = lstatSync(linkPath);
    if (!stat.isSymbolicLink()) return false;
    return readlinkSync(linkPath) === expectedTarget;
  } catch {
    return false;
  }
}

function pathExistsAsAnything(linkPath: string): boolean {
  try {
    lstatSync(linkPath);
    return true;
  } catch {
    return false;
  }
}

function ensureSymlink(
  linkPath: string,
  target: string,
  created: string[],
  skipped: string[]
): { ok: boolean; reason?: string } {
  if (symlinkMatches(linkPath, target)) {
    skipped.push(linkPath);
    return { ok: true };
  }
  if (pathExistsAsAnything(linkPath)) {
    return {
      ok: false,
      reason: `${linkPath} already exists and is not the expected symlink — remove it manually before installing.`
    };
  }
  symlinkSync(target, linkPath);
  created.push(linkPath);
  return { ok: true };
}

export function installSwarmMcpSkill(
  request: SkillInstallRequest,
  allowedWorkspaceRoots: readonly string[] = []
): SkillInstallResult {
  const source = getSkillSourcePath();
  const created: string[] = [];
  const skipped: string[] = [];

  if (!existsSync(join(source, "SKILL.md"))) {
    return {
      ok: false,
      source,
      created,
      skipped,
      reason: `Skill source missing at ${source}. Initialize the submodule with: git submodule update --init mcp-servers/swarm-mcp`
    };
  }

  if (request.scope === "global") {
    const skillsDir = join(homedir(), ".claude", "skills");
    mkdirSync(skillsDir, { recursive: true });
    const linkPath = join(skillsDir, SKILL_NAME);
    const result = ensureSymlink(linkPath, source, created, skipped);
    if (!result.ok) return { ok: false, source, created, skipped, reason: result.reason };
    return { ok: true, source, created, skipped };
  }

  const root = (request.workspaceRoot || "").trim();
  if (!root) {
    return {
      ok: false,
      source,
      created,
      skipped,
      reason: "workspaceRoot is required for workspace scope"
    };
  }
  if (!allowedWorkspaceRoots.some((entry) => entry.trim() === root)) {
    return {
      ok: false,
      source,
      created,
      skipped,
      reason: `Workspace root not in allowed list: ${root}`
    };
  }
  if (!existsSync(root)) {
    return {
      ok: false,
      source,
      created,
      skipped,
      reason: `Workspace root does not exist on disk: ${root}`
    };
  }

  const agentsSkills = join(root, ".agents", "skills");
  const claudeSkills = join(root, ".claude", "skills");
  mkdirSync(agentsSkills, { recursive: true });
  mkdirSync(claudeSkills, { recursive: true });

  const agentsResult = ensureSymlink(
    join(agentsSkills, SKILL_NAME),
    source,
    created,
    skipped
  );
  if (!agentsResult.ok) {
    return { ok: false, source, created, skipped, reason: agentsResult.reason };
  }
  const claudeResult = ensureSymlink(
    join(claudeSkills, SKILL_NAME),
    CLAUDE_REL_TARGET,
    created,
    skipped
  );
  if (!claudeResult.ok) {
    return { ok: false, source, created, skipped, reason: claudeResult.reason };
  }

  return { ok: true, source, created, skipped };
}
