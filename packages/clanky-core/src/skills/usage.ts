import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ClankyPaths } from "../paths.ts";
import { validateSkillName } from "./loader.ts";

export interface SkillUsageRecordInput {
	name: string;
	source?: string;
	sessionId?: string;
	jobId?: string;
}

export interface SkillUsageRecord {
	name: string;
	useCount: number;
	lastUsedAt: string;
	source?: string;
	sessionId?: string;
	jobId?: string;
}

interface SkillUsageFile {
	skills: SkillUsageRecord[];
}

export class SkillUsageStore {
	private readonly paths: ClankyPaths;

	constructor(paths: ClankyPaths) {
		this.paths = paths;
	}

	async list(): Promise<SkillUsageRecord[]> {
		const file = await this.readFile();
		return file.skills.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
	}

	async record(input: SkillUsageRecordInput, now = new Date()): Promise<SkillUsageRecord> {
		const name = validateSkillName(input.name);
		const file = await this.readFile();
		const timestamp = now.toISOString();
		let record = file.skills.find((candidate) => candidate.name === name);
		if (record === undefined) {
			record = {
				name,
				useCount: 0,
				lastUsedAt: timestamp,
			};
			file.skills.push(record);
		}
		record.useCount += 1;
		record.lastUsedAt = timestamp;
		if (input.source !== undefined) record.source = input.source;
		if (input.sessionId !== undefined) record.sessionId = input.sessionId;
		if (input.jobId !== undefined) record.jobId = input.jobId;
		await this.writeFile(file);
		return record;
	}

	private async readFile(): Promise<SkillUsageFile> {
		await mkdir(dirname(this.paths.skillUsageFile), { recursive: true, mode: 0o700 });
		try {
			const content = await readFile(this.paths.skillUsageFile, "utf8");
			const parsed = JSON.parse(content) as unknown;
			if (!isSkillUsageFile(parsed)) throw new Error(`Invalid skill usage file: ${this.paths.skillUsageFile}`);
			return { skills: parsed.skills };
		} catch (error) {
			if (isNotFoundError(error)) return { skills: [] };
			throw error;
		}
	}

	private async writeFile(file: SkillUsageFile): Promise<void> {
		await mkdir(dirname(this.paths.skillUsageFile), { recursive: true, mode: 0o700 });
		const tempFile = `${this.paths.skillUsageFile}.${process.pid}.tmp`;
		await writeFile(tempFile, `${JSON.stringify(file, null, "\t")}\n`, { mode: 0o600 });
		await rename(tempFile, this.paths.skillUsageFile);
	}
}

function isSkillUsageFile(value: unknown): value is SkillUsageFile {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return Array.isArray(candidate.skills) && candidate.skills.every(isSkillUsageRecord);
}

function isSkillUsageRecord(value: unknown): value is SkillUsageRecord {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.name === "string" &&
		typeof candidate.useCount === "number" &&
		Number.isInteger(candidate.useCount) &&
		typeof candidate.lastUsedAt === "string"
	);
}

function isNotFoundError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
