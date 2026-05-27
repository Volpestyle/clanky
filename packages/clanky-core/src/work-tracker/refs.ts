import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { ClankyPaths } from "../paths.ts";

export type WorkTrackerProviderKind = "native" | "linear" | "github-issues" | "jira" | "custom";

export interface WorkTrackerCreateIssueInput {
	providerId?: string;
	providerKind?: WorkTrackerProviderKind;
	title: string;
	description?: string;
	assigneeId?: string;
	projectId?: string;
	stateId?: string;
	teamId?: string;
	priority?: number;
	labelIds?: string[];
	metadata?: Record<string, unknown>;
}

export interface WorkTrackerIssueRef {
	providerId: string;
	providerKind: WorkTrackerProviderKind;
	issueId: string;
	identifier?: string;
	title?: string;
	url?: string;
	metadata?: Record<string, unknown>;
}

export interface CreateWorkTrackerRefInput {
	issueId: string;
	providerId?: string;
	providerKind?: WorkTrackerProviderKind;
	identifier?: string;
	title?: string;
	url?: string;
	sessionId?: string;
	taskId?: string;
	note?: string;
	metadata?: Record<string, unknown>;
}

export interface WorkTrackerRef extends WorkTrackerIssueRef {
	id: string;
	createdAt: string;
	updatedAt: string;
	sessionId?: string;
	taskId?: string;
	note?: string;
}

interface WorkTrackerRefsFile {
	refs: WorkTrackerRef[];
}

export class WorkTrackerRefStore {
	private readonly paths: ClankyPaths;

	constructor(paths: ClankyPaths) {
		this.paths = paths;
	}

	async list(): Promise<WorkTrackerRef[]> {
		const file = await this.readFile();
		return file.refs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	async link(input: CreateWorkTrackerRefInput, now = new Date()): Promise<WorkTrackerRef> {
		const normalized = normalizeWorkTrackerRefInput(input);
		const file = await this.readFile();
		const existing = file.refs.find(
			(ref) =>
				ref.providerId === normalized.providerId &&
				ref.providerKind === normalized.providerKind &&
				ref.issueId === normalized.issueId &&
				ref.sessionId === normalized.sessionId &&
				ref.taskId === normalized.taskId,
		);
		const timestamp = now.toISOString();
		if (existing !== undefined) {
			existing.updatedAt = timestamp;
			if (normalized.identifier !== undefined) existing.identifier = normalized.identifier;
			if (normalized.title !== undefined) existing.title = normalized.title;
			if (normalized.url !== undefined) existing.url = normalized.url;
			if (normalized.note !== undefined) existing.note = normalized.note;
			if (normalized.metadata !== undefined) existing.metadata = normalized.metadata;
			await this.writeFile(file);
			return existing;
		}

		const ref: WorkTrackerRef = {
			id: randomUUID(),
			providerId: normalized.providerId,
			providerKind: normalized.providerKind,
			issueId: normalized.issueId,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		if (normalized.identifier !== undefined) ref.identifier = normalized.identifier;
		if (normalized.title !== undefined) ref.title = normalized.title;
		if (normalized.url !== undefined) ref.url = normalized.url;
		if (normalized.sessionId !== undefined) ref.sessionId = normalized.sessionId;
		if (normalized.taskId !== undefined) ref.taskId = normalized.taskId;
		if (normalized.note !== undefined) ref.note = normalized.note;
		if (normalized.metadata !== undefined) ref.metadata = normalized.metadata;
		file.refs.push(ref);
		await this.writeFile(file);
		return ref;
	}

	private async readFile(): Promise<WorkTrackerRefsFile> {
		await mkdir(this.paths.workTrackersDir, { recursive: true, mode: 0o700 });
		try {
			const content = await readFile(this.paths.workTrackerRefsFile, "utf8");
			const parsed = JSON.parse(content) as unknown;
			if (!isWorkTrackerRefsFile(parsed))
				throw new Error(`Invalid work tracker refs file: ${this.paths.workTrackerRefsFile}`);
			return { refs: parsed.refs };
		} catch (error) {
			if (isNotFoundError(error)) return { refs: [] };
			throw error;
		}
	}

	private async writeFile(file: WorkTrackerRefsFile): Promise<void> {
		await mkdir(this.paths.workTrackersDir, { recursive: true, mode: 0o700 });
		const tempFile = `${this.paths.workTrackerRefsFile}.${process.pid}.tmp`;
		await writeFile(tempFile, `${JSON.stringify(file, null, "\t")}\n`, { mode: 0o600 });
		await rename(tempFile, this.paths.workTrackerRefsFile);
	}
}

export function normalizeWorkTrackerProviderKind(value: string | undefined): WorkTrackerProviderKind | undefined {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "native" || normalized === "linear" || normalized === "github-issues" || normalized === "jira") {
		return normalized;
	}
	if (normalized === "github" || normalized === "github_issues") return "github-issues";
	if (normalized === "custom") return "custom";
	return undefined;
}

export function normalizeWorkTrackerRefInput(
	input: CreateWorkTrackerRefInput,
): RequiredProvider<CreateWorkTrackerRefInput> {
	const issueId = input.issueId.trim();
	if (issueId.length === 0) throw new Error("Work tracker issue id must be a non-empty string");
	const providerKind = input.providerKind ?? "custom";
	const providerId = input.providerId?.trim() || providerKind;
	const sessionId = input.sessionId?.trim();
	const taskId = input.taskId?.trim();
	if (!sessionId && !taskId) throw new Error("Work tracker link requires a sessionId or taskId");
	const normalized: RequiredProvider<CreateWorkTrackerRefInput> = { issueId, providerId, providerKind };
	addTrimmed(normalized, "identifier", input.identifier);
	addTrimmed(normalized, "title", input.title);
	addTrimmed(normalized, "url", input.url);
	if (sessionId) normalized.sessionId = sessionId;
	if (taskId) normalized.taskId = taskId;
	addTrimmed(normalized, "note", input.note);
	if (input.metadata !== undefined) normalized.metadata = input.metadata;
	return normalized;
}

type RequiredProvider<T extends { providerId?: string; providerKind?: WorkTrackerProviderKind }> = Omit<
	T,
	"providerId" | "providerKind"
> & {
	providerId: string;
	providerKind: WorkTrackerProviderKind;
};

function addTrimmed<T extends Record<string, unknown>>(target: T, key: keyof T, value: string | undefined): void {
	const trimmed = value?.trim();
	if (trimmed !== undefined && trimmed.length > 0) target[key] = trimmed as T[keyof T];
}

function isWorkTrackerRefsFile(value: unknown): value is WorkTrackerRefsFile {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return Array.isArray(candidate.refs) && candidate.refs.every(isWorkTrackerRef);
}

function isWorkTrackerRef(value: unknown): value is WorkTrackerRef {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.id === "string" &&
		typeof candidate.providerId === "string" &&
		typeof candidate.providerKind === "string" &&
		typeof candidate.issueId === "string" &&
		typeof candidate.createdAt === "string" &&
		typeof candidate.updatedAt === "string"
	);
}

function isNotFoundError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
