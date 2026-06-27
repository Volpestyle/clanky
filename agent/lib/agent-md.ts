import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

export const CLANKY_AGENT_MD_ENV = "CLANKY_AGENT_MD";
export const CLANKY_AGENT_MD_ROOT_ENV = "CLANKY_AGENT_MD_ROOT";
export const AGENT_MD_FILENAMES = ["AGENTS.md", "agent.md", "AGENT.md", "agents.md"] as const;

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
	for (const directory of ancestorDirectories(root).reverse()) {
		for (const name of names) {
			const candidate = join(directory, name);
			const file = await readAgentMdFile(candidate);
			if (file === undefined || seen.has(file.realPath)) continue;
			seen.add(file.realPath);
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
		const [realPath, content] = await Promise.all([realpath(path), readFile(path, "utf8")]);
		return content.trim().length === 0 ? undefined : { realPath, content };
	} catch {
		return undefined;
	}
}
