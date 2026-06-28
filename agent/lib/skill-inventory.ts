import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type ClankySkillScope = "agent" | "bundled";

export type ClankySkillInventoryEntry = {
	readonly name: string;
	readonly scope: ClankySkillScope;
	readonly path: string;
	readonly description: string;
	readonly whenToUse?: string;
};

type SkillCandidate = {
	readonly name: string;
	readonly scope: ClankySkillScope;
	readonly absolutePath: string;
	readonly displayPath: string;
};

type ParsedSkillDocument = {
	readonly frontmatter: ReadonlyMap<string, string>;
	readonly body: string;
};

export async function listClankySkills(repo: string): Promise<ClankySkillInventoryEntry[]> {
	const [agentSkills, bundledSkills] = await Promise.all([
		listSkillCandidates(repo, "agent", join("agent", "skills")),
		listSkillCandidates(repo, "bundled", "skills"),
	]);
	const entries = await Promise.all([...agentSkills, ...bundledSkills].map(readSkillEntry));
	return entries
		.filter((entry): entry is ClankySkillInventoryEntry => entry !== undefined)
		.sort(compareSkillEntries);
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
			});
			continue;
		}
		if (!entry.isDirectory()) continue;
		candidates.push({
			name: entry.name,
			scope,
			absolutePath: join(absoluteDir, entry.name, "SKILL.md"),
			displayPath: join(relativeDir, entry.name, "SKILL.md"),
		});
	}
	return candidates;
}

function isSkillFile(name: string): boolean {
	return name.endsWith(".md") || name.endsWith(".ts");
}

function skillNameFromFile(name: string): string {
	return name.replace(/\.(md|ts)$/u, "");
}

async function readSkillEntry(candidate: SkillCandidate): Promise<ClankySkillInventoryEntry | undefined> {
	const text = await readFile(candidate.absolutePath, "utf8").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (text === undefined) return undefined;
	const parsed = parseSkillDocument(text);
	const name = parsed.frontmatter.get("name") ?? candidate.name;
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

function compareSkillEntries(left: ClankySkillInventoryEntry, right: ClankySkillInventoryEntry): number {
	const nameOrder = left.name.localeCompare(right.name);
	if (nameOrder !== 0) return nameOrder;
	return left.path.localeCompare(right.path);
}
