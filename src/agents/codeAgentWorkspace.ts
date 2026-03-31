import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ResolvedCodeAgentWorkspaceMode } from "../settings/codeAgentWorkspaceMode.ts";

const WORKTREE_PARENT_DIR = path.join(tmpdir(), "clanker-code-worktrees");

type CodeAgentWorkspaceLeaseBase = {
  readonly mode: ResolvedCodeAgentWorkspaceMode;
  readonly repoRoot: string;
  readonly cwd: string;
  readonly canonicalCwd: string;
  readonly relativeCwd: string;
  readonly worktreePath?: string;
  readonly branch?: string;
  readonly baseRef?: string;
  cleanup(): void;
};

export type SharedCheckoutCodeAgentWorkspaceLease = CodeAgentWorkspaceLeaseBase & {
  readonly mode: "shared_checkout";
};

export type IsolatedWorktreeCodeAgentWorkspaceLease = CodeAgentWorkspaceLeaseBase & {
  readonly mode: "isolated_worktree";
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseRef: string;
};

export type CodeAgentWorkspaceLease =
  | SharedCheckoutCodeAgentWorkspaceLease
  | IsolatedWorktreeCodeAgentWorkspaceLease;

type ProvisionCodeAgentWorkspaceOptions = {
  cwd: string;
  provider: "claude-code" | "codex-cli";
  scopeKey: string;
  mode: ResolvedCodeAgentWorkspaceMode;
};

function sanitizeSegment(value: string, fallback: string, maxLen = 48): string {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+/g, "")
    .replace(/-+$/g, "");
  if (!normalized) return fallback;
  return normalized.slice(0, maxLen);
}

function runGit(args: string[], cwd: string) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8"
  });
  const stdout = String(result.stdout || "").trim();
  const stderr = String(result.stderr || "").trim();
  const status = typeof result.status === "number" ? result.status : 1;
  return {
    stdout,
    stderr,
    status,
    error: result.error
  };
}

function runGitOrThrow(args: string[], cwd: string, message: string) {
  const result = runGit(args, cwd);
  if (!result.error && result.status === 0) return result;
  const detail = result.error?.message || result.stderr || result.stdout || `git ${args.join(" ")} failed`;
  throw new Error(`${message} ${detail}`.trim());
}

function resolveRepoRoot(targetCwd: string): string {
  const absoluteTargetCwd = path.resolve(String(targetCwd || "").trim() || process.cwd());
  let targetStats: ReturnType<typeof statSync>;
  try {
    targetStats = statSync(absoluteTargetCwd);
  } catch {
    throw new Error(`Code agent working directory does not exist: ${absoluteTargetCwd}`);
  }
  if (!targetStats.isDirectory()) {
    throw new Error(`Code agent working directory must be a directory: ${absoluteTargetCwd}`);
  }

  const resolvedTargetCwd = realpathSync(absoluteTargetCwd);
  const result = runGit(["rev-parse", "--show-toplevel"], resolvedTargetCwd);
  if (!result.error && result.status === 0 && result.stdout) {
    return realpathSync(result.stdout);
  }
  throw new Error(
    `Local code agents require a git repository checkout. '${resolvedTargetCwd}' is not inside a git repo.`
  );
}

function resolveBaseRef(repoRoot: string): string {
  const originHead = runGit(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], repoRoot);
  if (!originHead.error && originHead.status === 0 && originHead.stdout) {
    return originHead.stdout;
  }

  const currentBranch = runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], repoRoot);
  if (!currentBranch.error && currentBranch.status === 0 && currentBranch.stdout) {
    return currentBranch.stdout;
  }

  return "HEAD";
}

function resolveWorkspaceContext(cwd: string) {
  const absoluteRequestedCwd = path.resolve(String(cwd || "").trim() || process.cwd());
  const repoRoot = resolveRepoRoot(absoluteRequestedCwd);
  const resolvedRequestedCwd = realpathSync(absoluteRequestedCwd);
  const relativeCwd = path.relative(repoRoot, resolvedRequestedCwd);
  if (relativeCwd.startsWith("..") || path.isAbsolute(relativeCwd)) {
    throw new Error(`Code agent working directory must stay inside repo root: ${repoRoot}`);
  }

  return {
    repoRoot,
    resolvedRequestedCwd,
    relativeCwd
  };
}

export function provisionCodeAgentWorkspace({
  cwd,
  provider,
  scopeKey,
  mode
}: ProvisionCodeAgentWorkspaceOptions): CodeAgentWorkspaceLease {
  const { repoRoot, resolvedRequestedCwd, relativeCwd } = resolveWorkspaceContext(cwd);

  if (mode === "shared_checkout") {
    return {
      mode: "shared_checkout",
      repoRoot,
      cwd: resolvedRequestedCwd,
      canonicalCwd: resolvedRequestedCwd,
      relativeCwd,
      cleanup() {}
    };
  }

  mkdirSync(WORKTREE_PARENT_DIR, { recursive: true });

  const repoName = sanitizeSegment(path.basename(repoRoot), "repo");
  const scopeFragment = sanitizeSegment(scopeKey, "session");
  const nonce = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const branch = `clanker/${sanitizeSegment(provider, "worker")}/${scopeFragment}-${nonce}`;
  const worktreePath = path.join(WORKTREE_PARENT_DIR, `${repoName}-${nonce}`);
  const baseRef = resolveBaseRef(repoRoot);

  runGitOrThrow(
    ["worktree", "add", "-b", branch, worktreePath, baseRef],
    repoRoot,
    "Failed to create code-agent worktree."
  );

  const worktreeCwd = relativeCwd ? path.join(worktreePath, relativeCwd) : worktreePath;
  let cleanedUp = false;

  return {
    mode: "isolated_worktree",
    repoRoot,
    worktreePath,
    cwd: worktreeCwd,
    canonicalCwd: resolvedRequestedCwd,
    relativeCwd,
    branch,
    baseRef,
    cleanup() {
      if (cleanedUp) return;
      cleanedUp = true;

      try {
        runGit(["worktree", "remove", "--force", worktreePath], repoRoot);
      } catch {
        // ignore
      }
      try {
        rmSync(worktreePath, { recursive: true, force: true });
      } catch {
        // ignore
      }
      try {
        runGit(["worktree", "prune"], repoRoot);
      } catch {
        // ignore
      }
      try {
        runGit(["branch", "-D", branch], repoRoot);
      } catch {
        // ignore
      }
    }
  };
}
