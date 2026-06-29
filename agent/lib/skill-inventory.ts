import { homedir } from "node:os";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

export type ClankySkillScope = "agent" | "bundled" | "inherited";
export type ClankySkillSource = "codex" | "codex-system" | "claude";

export type ClankySkillInventoryEntry = {
	readonly name: string;
	readonly scope: ClankySkillScope;
	readonly path: string;
	readonly description: string;
	readonly whenToUse?: string;
	readonly source?: ClankySkillSource;
	readonly runtimeName?: string;
};

type SkillCandidate = {
	readonly name: string;
	readonly scope: ClankySkillScope;
	readonly absolutePath: string;
	readonly displayPath: string;
	readonly source?: ClankySkillSource;
	readonly packaged: boolean;
};

type ParsedSkillDocument = {
	readonly frontmatter: ReadonlyMap<string, string>;
	readonly body: string;
};

export type ClankyInheritedSkillPackage = ClankySkillInventoryEntry & {
	readonly scope: "inherited";
	readonly markdown: string;
	readonly files: Readonly<Record<string, string>>;
};

export type ListClankySkillsOptions = {
	readonly includeInherited?: boolean;
};

type InheritedSkillRoot = {
	readonly root: string;
	readonly source: ClankySkillSource;
	readonly allowDotEntries: boolean;
};

type SkillFileRead = {
	readonly realPath: string;
	readonly text: string;
};

const MAX_INHERITED_SKILL_PACKAGE_FILES = 64;
const MAX_INHERITED_SKILL_PACKAGE_FILE_BYTES = 256 * 1024;
const MAX_INHERITED_SKILL_PACKAGE_BYTES = 2 * 1024 * 1024;
const INHERITED_SKILL_PACKAGE_DIRS = new Set(["references", "scripts", "assets"]);
const SKIPPED_PACKAGE_DIRS = new Set([".git", "node_modules", ".venv", "dist", "build", ".build"]);

export async function listClankySkills(
	repo: string,
	options: ListClankySkillsOptions = {},
): Promise<ClankySkillInventoryEntry[]> {
	const [agentSkills, bundledSkills] = await Promise.all([
		listSkillCandidates(repo, "agent", join("agent", "skills")),
		listSkillCandidates(repo, "bundled", "skills"),
	]);
	const localEntries = (await Promise.all([...agentSkills, ...bundledSkills].map(readSkillEntry)))
		.filter((entry): entry is ClankySkillInventoryEntry => entry !== undefined);
	if (options.includeInherited !== true) {
		return localEntries.sort(compareSkillEntries);
	}

	const reservedNames = new Set(localEntries.map((entry) => entry.name));
	const inheritedEntries = await listInheritedAgentSkills({ reservedNames });
	return [...localEntries, ...inheritedEntries].sort(compareSkillEntries);
}

export async function listInheritedAgentSkills(options: {
	readonly reservedNames?: ReadonlySet<string>;
} = {}): Promise<ClankySkillInventoryEntry[]> {
	const candidates = await listInheritedSkillCandidates();
	const seenRealPaths = new Set<string>();
	const seenNames = new Set<string>();
	const entries: ClankySkillInventoryEntry[] = [];
	for (const candidate of candidates) {
		const skill = await readSkillFile(candidate.absolutePath);
		if (skill === undefined || seenRealPaths.has(skill.realPath)) continue;
		seenRealPaths.add(skill.realPath);
		const parsed = parseSkillDocument(skill.text);
		const name = parsed.frontmatter.get("name") ?? candidate.name;
		if (seenNames.has(name)) continue;
		seenNames.add(name);
		const entry = skillEntryFromParsed(candidate, parsed, skill.text, name);
		entries.push({
			...entry,
			runtimeName: inheritedSkillRuntimeName(entry.name, options.reservedNames ?? new Set()),
		});
	}
	return entries.sort(compareSkillEntries);
}

export async function listInheritedAgentSkillPackages(options: {
	readonly reservedNames?: ReadonlySet<string>;
} = {}): Promise<ClankyInheritedSkillPackage[]> {
	const candidates = await listInheritedSkillCandidates();
	const seenRealPaths = new Set<string>();
	const seenNames = new Set<string>();
	const packages: ClankyInheritedSkillPackage[] = [];
	for (const candidate of candidates) {
		const skill = await readSkillFile(candidate.absolutePath);
		if (skill === undefined || seenRealPaths.has(skill.realPath)) continue;
		seenRealPaths.add(skill.realPath);
		const parsed = parseSkillDocument(skill.text);
		const name = parsed.frontmatter.get("name") ?? candidate.name;
		if (seenNames.has(name)) continue;
		seenNames.add(name);
		const entry = skillEntryFromParsed(candidate, parsed, skill.text, name);
		if (entry.scope !== "inherited") continue;
		const runtimeName = inheritedSkillRuntimeName(entry.name, options.reservedNames ?? new Set());
		const markdown = parsed.body.trim().length > 0 ? parsed.body.trim() : skill.text.trim();
		packages.push({
			...entry,
			scope: "inherited",
			runtimeName,
			markdown,
			files: candidate.packaged ? await collectInheritedSkillPackageFiles(dirname(skill.realPath)) : {},
		});
	}
	return packages.sort(compareSkillEntries);
}

export function inheritedSkillRuntimeName(name: string, reservedNames: ReadonlySet<string>): string {
	return reservedNames.has(name) ? `inherited__${name}` : name;
}

async function listSkillCandidates(
	repo: string,
	scope: ClankySkillScope,
	relativeDir: string,
): Promise<SkillCandidate[]> {
	const absoluteDir = join(repo, relativeDir);
	const entries = await readdir(absoluteDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return [];
		throw error;
	});
	const candidates: SkillCandidate[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		if (entry.isFile() && isSkillFile(entry.name)) {
			candidates.push({
				name: skillNameFromFile(entry.name),
				scope,
				absolutePath: join(absoluteDir, entry.name),
				displayPath: join(relativeDir, entry.name),
				packaged: false,
			});
			continue;
		}
		if (!entry.isDirectory()) continue;
		candidates.push({
			name: entry.name,
			scope,
			absolutePath: join(absoluteDir, entry.name, "SKILL.md"),
			displayPath: join(relativeDir, entry.name, "SKILL.md"),
			packaged: true,
		});
	}
	return candidates;
}

async function listInheritedSkillCandidates(): Promise<SkillCandidate[]> {
	const roots = inheritedSkillRoots();
	const rootCandidates = await Promise.all(roots.map(listInheritedSkillCandidatesFromRoot));
	return rootCandidates.flat();
}

function inheritedSkillRoots(): InheritedSkillRoot[] {
	const home = homedir();
	return [
		{ root: join(home, ".codex", "skills"), source: "codex", allowDotEntries: false },
		{ root: join(home, ".codex", "skills", ".system"), source: "codex-system", allowDotEntries: true },
		{ root: join(home, ".claude", "skills"), source: "claude", allowDotEntries: false },
	];
}

async function listInheritedSkillCandidatesFromRoot(root: InheritedSkillRoot): Promise<SkillCandidate[]> {
	const entries = await readdir(root.root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return [];
		throw error;
	});
	const candidates: SkillCandidate[] = [];
	for (const entry of entries) {
		if (!root.allowDotEntries && entry.name.startsWith(".")) continue;
		const absolutePath = join(root.root, entry.name);
		const candidate = await inheritedSkillCandidateFromEntry(root, absolutePath, entry.name);
		if (candidate !== undefined) candidates.push(candidate);
	}
	return candidates;
}

async function inheritedSkillCandidateFromEntry(
	root: InheritedSkillRoot,
	absolutePath: string,
	entryName: string,
): Promise<SkillCandidate | undefined> {
	const info = await lstat(absolutePath).catch(() => undefined);
	if (info === undefined) return undefined;
	if (info.isFile() && entryName.toLowerCase().endsWith(".md")) {
		return {
			name: skillNameFromFile(entryName),
			scope: "inherited",
			source: root.source,
			absolutePath,
			displayPath: displayPathForInheritedSkill(absolutePath),
			packaged: false,
		};
	}

	const targetInfo = info.isSymbolicLink() ? await stat(absolutePath).catch(() => undefined) : info;
	if (targetInfo?.isDirectory() !== true) return undefined;
	return {
		name: entryName,
		scope: "inherited",
		source: root.source,
		absolutePath: join(absolutePath, "SKILL.md"),
		displayPath: displayPathForInheritedSkill(join(absolutePath, "SKILL.md")),
		packaged: true,
	};
}

function displayPathForInheritedSkill(path: string): string {
	const home = homedir();
	const relativeToHome = relative(home, path);
	return relativeToHome.startsWith("..") ? path : `~/${relativeToHome}`;
}

function isSkillFile(name: string): boolean {
	return name.endsWith(".md") || name.endsWith(".ts");
}

function skillNameFromFile(name: string): string {
	return name.replace(/\.(md|ts)$/u, "");
}

async function readSkillEntry(candidate: SkillCandidate): Promise<ClankySkillInventoryEntry | undefined> {
	const skill = await readSkillFile(candidate.absolutePath);
	if (skill === undefined) return undefined;
	const parsed = parseSkillDocument(skill.text);
	return skillEntryFromParsed(candidate, parsed, skill.text, parsed.frontmatter.get("name") ?? candidate.name);
}

async function readSkillFile(path: string): Promise<SkillFileRead | undefined> {
	const result = await Promise.all([
		realpath(path),
		readFile(path, "utf8"),
	]).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (result === undefined) return undefined;
	const [resolvedPath, text] = result;
	return { realPath: resolvedPath, text };
}

function skillEntryFromParsed(
	candidate: SkillCandidate,
	parsed: ParsedSkillDocument,
	text: string,
	name: string,
): ClankySkillInventoryEntry {
	const description =
		parsed.frontmatter.get("description") ??
		parseTypeScriptDescription(text) ??
		firstMeaningfulSkillLine(parsed.body) ??
		`Instructions for the ${name} skill.`;
	const whenToUse = parsed.frontmatter.get("when_to_use") ?? parsed.frontmatter.get("whenToUse");
	return {
		name,
		scope: candidate.scope,
		path: candidate.displayPath,
		description,
		...(candidate.source === undefined ? {} : { source: candidate.source }),
		...(whenToUse === undefined ? {} : { whenToUse }),
	};
}

function parseSkillDocument(text: string): ParsedSkillDocument {
	if (!text.startsWith("---")) return { frontmatter: new Map(), body: text };
	const end = text.indexOf("\n---", 3);
	if (end < 0) return { frontmatter: new Map(), body: text };
	const frontmatterText = text.slice(3, end);
	const body = text.slice(end + "\n---".length);
	return {
		frontmatter: parseFrontmatter(frontmatterText),
		body,
	};
}

function parseFrontmatter(text: string): ReadonlyMap<string, string> {
	const fields = new Map<string, string>();
	for (const line of text.split(/\r?\n/u)) {
		const match = /^([A-Za-z0-9_-]+):\s*(.*)$/u.exec(line.trim());
		if (match === null) continue;
		const key = match[1];
		const rawValue = match[2];
		if (key === undefined || rawValue === undefined) continue;
		const value = unquoteScalar(rawValue.trim());
		if (value.length > 0) fields.set(key, value);
	}
	return fields;
}

function unquoteScalar(value: string): string {
	if (value.length < 2) return value;
	const quote = value[0];
	if ((quote !== "\"" && quote !== "'") || value[value.length - 1] !== quote) return value;
	return value.slice(1, -1);
}

function parseTypeScriptDescription(text: string): string | undefined {
	const match = /description\s*:\s*(["'`])([\s\S]*?)\1/u.exec(text);
	const description = match?.[2]?.trim().replace(/\s+/gu, " ");
	return description === undefined || description.length === 0 ? undefined : description;
}

function firstMeaningfulSkillLine(text: string): string | undefined {
	for (const rawLine of text.split(/\r?\n/u)) {
		const line = rawLine.trim().replace(/^[#>*\-\s]+/u, "").trim();
		if (line.length > 0) return line;
	}
	return undefined;
}

async function collectInheritedSkillPackageFiles(root: string): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	let fileCount = 0;
	let totalBytes = 0;
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (!entry.isDirectory() || !INHERITED_SKILL_PACKAGE_DIRS.has(entry.name)) continue;
		await collectPackageFiles(join(root, entry.name), entry.name);
	}
	return files;

	async function collectPackageFiles(directory: string, relativeDirectory: string): Promise<void> {
		if (fileCount >= MAX_INHERITED_SKILL_PACKAGE_FILES || totalBytes >= MAX_INHERITED_SKILL_PACKAGE_BYTES) return;
		const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (fileCount >= MAX_INHERITED_SKILL_PACKAGE_FILES || totalBytes >= MAX_INHERITED_SKILL_PACKAGE_BYTES) return;
			if (entry.name.startsWith(".") || SKIPPED_PACKAGE_DIRS.has(entry.name)) continue;
			const path = join(directory, entry.name);
			const relativePath = join(relativeDirectory, entry.name);
			if (entry.isDirectory()) {
				await collectPackageFiles(path, relativePath);
				continue;
			}
			if (!entry.isFile() || basename(path).toLowerCase() === "skill.md") continue;
			const info = await stat(path).catch(() => undefined);
			if (info === undefined || !info.isFile() || info.size > MAX_INHERITED_SKILL_PACKAGE_FILE_BYTES) continue;
			if (totalBytes + info.size > MAX_INHERITED_SKILL_PACKAGE_BYTES) continue;
			const text = await readFile(path, "utf8").catch(() => undefined);
			if (text === undefined || text.includes("\u0000")) continue;
			files[relativePath] = text;
			fileCount += 1;
			totalBytes += info.size;
		}
	}
}

function compareSkillEntries(left: ClankySkillInventoryEntry, right: ClankySkillInventoryEntry): number {
	const nameOrder = left.name.localeCompare(right.name);
	if (nameOrder !== 0) return nameOrder;
	return left.path.localeCompare(right.path);
}
