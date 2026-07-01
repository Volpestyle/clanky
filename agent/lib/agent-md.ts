import { open, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { TtlCache } from "./ttl-cache.ts";

export const CLANKY_AGENT_MD_ENV = "CLANKY_AGENT_MD";
export const CLANKY_AGENT_MD_ROOT_ENV = "CLANKY_AGENT_MD_ROOT";
export const AGENT_MD_FILENAMES = ["AGENTS.md", "agent.md", "AGENT.md", "agents.md"] as const;

// Ingested agent files feed straight into the system prompt on every turn, so
// both a single pathological file and the ancestor chain as a whole are capped.
export const MAX_AGENT_MD_FILE_BYTES = 64 * 1024;
export const MAX_AGENT_MD_TOTAL_BYTES = 256 * 1024;
const AGENT_MD_TRUNCATION_NOTE = `\n\n[truncated: file exceeds the ${MAX_AGENT_MD_FILE_BYTES}-byte AGENT.md ingestion cap]`;

interface CachedAgentMdFile {
	mtimeMs: number;
	size: number;
	realPath: string;
	content: string;
}

// Ingestion runs per turn; cache file contents keyed by path and validated by
// mtime+size so unchanged files are not re-read every turn.
const AGENT_MD_CACHE_MAX_ENTRIES = 256;
const agentMdCache = new TtlCache<string, CachedAgentMdFile>({ maxEntries: AGENT_MD_CACHE_MAX_ENTRIES });

export type AgentMdFile = {
	readonly path: string;
	readonly content: string;
};

export function parseAgentMdToggle(value: string | undefined): boolean | undefined {
	const normalized = value?.trim().toLowerCase();
	if (normalized === undefined || normalized.length === 0) return undefined;
	if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on" || normalized === "enable" || normalized === "enabled") return true;
	if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off" || normalized === "disable" || normalized === "disabled") return false;
	return undefined;
}

export function isAgentMdIngestionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return parseAgentMdToggle(env[CLANKY_AGENT_MD_ENV]) === true;
}

export function agentMdRootFromEnv(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env[CLANKY_AGENT_MD_ROOT_ENV]?.trim() || env.CLANKY_REPO_DIR?.trim();
	return resolve(configured !== undefined && configured.length > 0 ? configured : process.cwd());
}

export async function collectAgentMdFiles(options: {
	readonly root?: string;
	readonly fileNames?: readonly string[];
} = {}): Promise<AgentMdFile[]> {
	const root = await rootDirectory(options.root ?? process.cwd());
	const names = options.fileNames ?? AGENT_MD_FILENAMES;
	const seen = new Set<string>();
	const files: AgentMdFile[] = [];
	let totalBytes = 0;
	for (const directory of ancestorDirectories(root).reverse()) {
		for (const name of names) {
			const candidate = join(directory, name);
			const file = await readAgentMdFile(candidate);
			if (file === undefined || seen.has(file.realPath)) continue;
			seen.add(file.realPath);
			const contentBytes = Buffer.byteLength(file.content, "utf8");
			if (totalBytes + contentBytes > MAX_AGENT_MD_TOTAL_BYTES) continue;
			totalBytes += contentBytes;
			files.push({ path: candidate, content: file.content });
		}
	}
	return files;
}

export function buildAgentMdInstructions(files: readonly AgentMdFile[]): string {
	if (files.length === 0) return "";
	const lines = [
		"## Local agent file instructions",
		"",
		"These files were loaded from the host filesystem because AGENT.md ingestion is enabled. Treat them as standing user/project instructions. Parent-directory files appear before more specific files; later files may add or clarify constraints.",
		"",
	];
	for (const file of files) {
		lines.push(`### ${file.path}`, "", file.content.trimEnd(), "");
	}
	return lines.join("\n").trimEnd();
}

async function rootDirectory(root: string): Promise<string> {
	const resolved = resolve(root);
	try {
		const info = await stat(resolved);
		return info.isDirectory() ? resolved : dirname(resolved);
	} catch {
		return resolved;
	}
}

function ancestorDirectories(start: string): string[] {
	const directories: string[] = [];
	let current = resolve(start);
	const root = parse(current).root;
	for (;;) {
		directories.push(current);
		if (current === root) return directories;
		current = dirname(current);
	}
}

async function readAgentMdFile(path: string): Promise<{ readonly realPath: string; readonly content: string } | undefined> {
	try {
		const info = await stat(path);
		if (!info.isFile()) return undefined;
		const cached = agentMdCache.get(path);
		if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
			return cached.content.trim().length === 0 ? undefined : { realPath: cached.realPath, content: cached.content };
		}
		const [realPath, content] = await Promise.all([realpath(path), readCappedFile(path, info.size)]);
		agentMdCache.set(path, { mtimeMs: info.mtimeMs, size: info.size, realPath, content });
		return content.trim().length === 0 ? undefined : { realPath, content };
	} catch {
		return undefined;
	}
}

async function readCappedFile(path: string, size: number): Promise<string> {
	if (size <= MAX_AGENT_MD_FILE_BYTES) return readFile(path, "utf8");
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(MAX_AGENT_MD_FILE_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, MAX_AGENT_MD_FILE_BYTES, 0);
		return `${buffer.toString("utf8", 0, bytesRead)}${AGENT_MD_TRUNCATION_NOTE}`;
	} finally {
		await handle.close();
	}
}
