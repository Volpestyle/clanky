import { existsSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { resolveAllowedCodeWorkspaceRoots } from "./codeAgentSettings.ts";

type GitHubRepoRef = {
  owner: string;
  repo: string;
  canonical: string;
};

export type CodeAgentRepoResolution = {
  cwd: string;
  githubRepo: string;
};

const MAX_REPO_SEARCH_DEPTH = 6;
const MAX_REPO_SEARCH_DIRS = 4000;
const SKIP_DIR_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".cache",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target"
]);

function repoRef(owner: string, repo: string): GitHubRepoRef | null {
  const normalizedOwner = String(owner || "").trim().toLowerCase();
  const normalizedRepo = String(repo || "")
    .trim()
    .replace(/\.git$/i, "")
    .toLowerCase();
  if (!normalizedOwner || !normalizedRepo) return null;
  return {
    owner: normalizedOwner,
    repo: normalizedRepo,
    canonical: `${normalizedOwner}/${normalizedRepo}`
  };
}

export function parseGitHubRepoRef(value: string): GitHubRepoRef | null {
  const text = String(value || "");
  const patterns = [
    /git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\.git)?/i,
    /ssh:\/\/git@github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\.git)?/i,
    /(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\.git)?(?:[/?#\s]|$)/i
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const ref = match ? repoRef(match[1], match[2]) : null;
    if (ref) return ref;
  }
  return null;
}

function uniqueRealDirs(values: string[]): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const value of values) {
    if (!existsSync(value)) continue;
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(value);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) continue;
    const real = realpathSync(value);
    const key = real.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    dirs.push(real);
  }
  return dirs;
}

function relativeInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function assertCodeAgentCwdAllowed(settings: Record<string, unknown>, cwd: string): string {
  const allowedRoots = uniqueRealDirs(resolveAllowedCodeWorkspaceRoots(settings));
  if (allowedRoots.length === 0) {
    throw new Error("Code workers require at least one allowed coding workspace root in settings.");
  }
  const realCwd = realpathSync(cwd);
  if (!allowedRoots.some((root) => relativeInside(root, realCwd))) {
    throw new Error(
      `Code worker directory is outside allowed coding workspace roots: ${realCwd}`
    );
  }
  return realCwd;
}

function hasGitMetadata(dir: string): boolean {
  return existsSync(path.join(dir, ".git"));
}

function gitRemoteOutput(dir: string): string {
  const result = spawnSync("git", ["remote", "-v"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 2500
  });
  if (result.error || result.status !== 0) return "";
  return String(result.stdout || "");
}

function gitHubRemotesForDir(dir: string): Set<string> {
  const remotes = new Set<string>();
  for (const line of gitRemoteOutput(dir).split("\n")) {
    const ref = parseGitHubRepoRef(line);
    if (ref) remotes.add(ref.canonical);
  }
  return remotes;
}

function findGitRepoDirs(root: string): string[] {
  const repos: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  const visited = new Set<string>();
  let inspected = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let realDir: string;
    try {
      realDir = realpathSync(current.dir);
    } catch {
      continue;
    }
    const key = realDir.toLowerCase();
    if (visited.has(key)) continue;
    visited.add(key);
    inspected += 1;
    if (inspected > MAX_REPO_SEARCH_DIRS) {
      throw new Error(`Coding workspace search exceeded ${MAX_REPO_SEARCH_DIRS} directories under ${root}.`);
    }

    if (hasGitMetadata(realDir)) {
      repos.push(realDir);
    }
    if (current.depth >= MAX_REPO_SEARCH_DEPTH) continue;

    let entries: Dirent[];
    try {
      entries = readdirSync(realDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      stack.push({ dir: path.join(realDir, entry.name), depth: current.depth + 1 });
    }
  }

  return repos;
}

export function resolveGitHubRepoCwdForCodeTask(args: {
  settings: Record<string, unknown>;
  task: string;
  githubUrl?: string | null;
}): CodeAgentRepoResolution | null {
  const ref = parseGitHubRepoRef(`${args.githubUrl || ""}\n${args.task || ""}`);
  if (!ref) return null;

  const allowedRoots = uniqueRealDirs(resolveAllowedCodeWorkspaceRoots(args.settings));
  if (allowedRoots.length === 0) {
    throw new Error(`No allowed coding workspace roots configured for GitHub repo ${ref.canonical}.`);
  }

  const matches: string[] = [];
  for (const root of allowedRoots) {
    for (const repoDir of findGitRepoDirs(root)) {
      if (gitHubRemotesForDir(repoDir).has(ref.canonical)) {
        matches.push(repoDir);
      }
    }
  }

  const uniqueMatches = uniqueRealDirs(matches);
  if (uniqueMatches.length === 0) {
    throw new Error(
      `No approved local clone found for GitHub repo ${ref.canonical} under allowed coding workspace roots.`
    );
  }
  if (uniqueMatches.length > 1) {
    throw new Error(
      `Multiple approved local clones found for GitHub repo ${ref.canonical}; pass cwd explicitly.`
    );
  }

  return {
    cwd: uniqueMatches[0],
    githubRepo: ref.canonical
  };
}
