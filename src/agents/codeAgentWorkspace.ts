import { realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

export type CodeAgentWorkspace = {
  readonly repoRoot: string;
  readonly cwd: string;
  readonly canonicalCwd: string;
  readonly relativeCwd: string;
};

type ResolveCodeAgentWorkspaceOptions = {
  cwd: string;
};

function runGit(args: string[], cwd: string) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8"
  });
  return {
    stdout: String(result.stdout || "").trim(),
    status: typeof result.status === "number" ? result.status : 1,
    error: result.error
  };
}

function resolveRepoRoot(targetCwd: string): string {
  const absoluteTargetCwd = path.resolve(String(targetCwd || "").trim() || process.cwd());
  let targetStats: ReturnType<typeof statSync>;
  try {
    targetStats = statSync(absoluteTargetCwd);
  } catch {
    throw new Error(`Code worker directory does not exist: ${absoluteTargetCwd}`);
  }
  if (!targetStats.isDirectory()) {
    throw new Error(`Code worker directory must be a directory: ${absoluteTargetCwd}`);
  }

  const resolvedTargetCwd = realpathSync(absoluteTargetCwd);
  const result = runGit(["rev-parse", "--show-toplevel"], resolvedTargetCwd);
  if (!result.error && result.status === 0 && result.stdout) {
    return realpathSync(result.stdout);
  }
  throw new Error(`Code workers require a git repository checkout. '${resolvedTargetCwd}' is not inside a git repo.`);
}

export function resolveCodeAgentWorkspace({ cwd }: ResolveCodeAgentWorkspaceOptions): CodeAgentWorkspace {
  const absoluteRequestedCwd = path.resolve(String(cwd || "").trim() || process.cwd());
  const repoRoot = resolveRepoRoot(absoluteRequestedCwd);
  const resolvedRequestedCwd = realpathSync(absoluteRequestedCwd);
  const relativeCwd = path.relative(repoRoot, resolvedRequestedCwd);
  if (relativeCwd.startsWith("..") || path.isAbsolute(relativeCwd)) {
    throw new Error(`Code worker directory must stay inside repo root: ${repoRoot}`);
  }

  return {
    repoRoot,
    cwd: resolvedRequestedCwd,
    canonicalCwd: resolvedRequestedCwd,
    relativeCwd
  };
}
