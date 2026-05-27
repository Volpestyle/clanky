import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { ClankyPaths } from "../paths.ts";
import type { WorkTrackerProviderKind } from "./refs.ts";

export type WorkTrackerOutboxStatus = "pending" | "posted" | "skipped" | "error";
export type WorkTrackerOutboxKind = "cron_output" | "comment";

export interface CreateWorkTrackerOutboxEntryInput {
	issueId: string;
	body: string;
	providerId?: string;
	providerKind?: WorkTrackerProviderKind;
	kind?: WorkTrackerOutboxKind;
	outputFile?: string;
	jobId?: string;
	sessionId?: string;
	taskId?: string;
	note?: string;
}

export interface WorkTrackerOutboxEntry {
	id: string;
	providerId: string;
	providerKind: WorkTrackerProviderKind;
	issueId: string;
	kind: WorkTrackerOutboxKind;
	status: WorkTrackerOutboxStatus;
	body: string;
	createdAt: string;
	updatedAt: string;
	outputFile?: string;
	jobId?: string;
	sessionId?: string;
	taskId?: string;
	note?: string;
	postedAt?: string;
	commentId?: string;
	commentUrl?: string;
	error?: string;
	errorAt?: string;
}

export interface MarkWorkTrackerOutboxPostedInput {
	commentId: string;
	commentUrl?: string;
}

interface WorkTrackerOutboxFile {
	entries: WorkTrackerOutboxEntry[];
}

export class WorkTrackerOutboxStore {
	private readonly paths: ClankyPaths;

	constructor(paths: ClankyPaths) {
		this.paths = paths;
	}

	async list(): Promise<WorkTrackerOutboxEntry[]> {
		const file = await this.readFile();
		return file.entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	async pending(): Promise<WorkTrackerOutboxEntry[]> {
		const entries = await this.list();
		return entries.filter((entry) => entry.status === "pending");
	}

	async add(input: CreateWorkTrackerOutboxEntryInput, now = new Date()): Promise<WorkTrackerOutboxEntry> {
		const normalized = normalizeWorkTrackerOutboxInput(input);
		const timestamp = now.toISOString();
		const entry: WorkTrackerOutboxEntry = {
			id: randomUUID(),
			providerId: normalized.providerId,
			providerKind: normalized.providerKind,
			issueId: normalized.issueId,
			kind: normalized.kind ?? "comment",
			status: "pending",
			body: normalized.body,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		if (normalized.outputFile !== undefined) entry.outputFile = normalized.outputFile;
		if (normalized.jobId !== undefined) entry.jobId = normalized.jobId;
		if (normalized.sessionId !== undefined) entry.sessionId = normalized.sessionId;
		if (normalized.taskId !== undefined) entry.taskId = normalized.taskId;
		if (normalized.note !== undefined) entry.note = normalized.note;

		const file = await this.readFile();
		file.entries.push(entry);
		await this.writeFile(file);
		return entry;
	}

	async markPosted(
		entryId: string,
		input: MarkWorkTrackerOutboxPostedInput,
		now = new Date(),
	): Promise<WorkTrackerOutboxEntry> {
		return await this.updateEntry(entryId, (entry) => {
			const timestamp = now.toISOString();
			entry.status = "posted";
			entry.updatedAt = timestamp;
			entry.postedAt = timestamp;
			entry.commentId = input.commentId;
			if (input.commentUrl !== undefined) entry.commentUrl = input.commentUrl;
			delete entry.error;
			delete entry.errorAt;
		});
	}

	async markError(entryId: string, error: string, now = new Date()): Promise<WorkTrackerOutboxEntry> {
		return await this.updateEntry(entryId, (entry) => {
			const timestamp = now.toISOString();
			entry.status = "error";
			entry.updatedAt = timestamp;
			entry.error = error;
			entry.errorAt = timestamp;
		});
	}

	async markPending(entryId: string, now = new Date()): Promise<WorkTrackerOutboxEntry> {
		return await this.updateEntry(entryId, (entry) => {
			entry.status = "pending";
			entry.updatedAt = now.toISOString();
			delete entry.error;
			delete entry.errorAt;
		});
	}

	private async updateEntry(
		entryId: string,
		update: (entry: WorkTrackerOutboxEntry) => void,
	): Promise<WorkTrackerOutboxEntry> {
		const file = await this.readFile();
		const entry = file.entries.find((candidate) => candidate.id === entryId);
		if (entry === undefined) throw new Error(`Unknown work tracker outbox entry: ${entryId}`);
		update(entry);
		await this.writeFile(file);
		return entry;
	}

	private async readFile(): Promise<WorkTrackerOutboxFile> {
		await mkdir(this.paths.workTrackersDir, { recursive: true, mode: 0o700 });
		try {
			const content = await readFile(this.paths.workTrackerOutboxFile, "utf8");
			const parsed = JSON.parse(content) as unknown;
			if (!isWorkTrackerOutboxFile(parsed)) {
				throw new Error(`Invalid work tracker outbox file: ${this.paths.workTrackerOutboxFile}`);
			}
			return { entries: parsed.entries };
		} catch (error) {
			if (isNotFoundError(error)) return { entries: [] };
			throw error;
		}
	}

	private async writeFile(file: WorkTrackerOutboxFile): Promise<void> {
		await mkdir(this.paths.workTrackersDir, { recursive: true, mode: 0o700 });
		const tempFile = `${this.paths.workTrackerOutboxFile}.${process.pid}.tmp`;
		await writeFile(tempFile, `${JSON.stringify(file, null, "\t")}\n`, { mode: 0o600 });
		await rename(tempFile, this.paths.workTrackerOutboxFile);
	}
}

type NormalizedWorkTrackerOutboxInput = Omit<CreateWorkTrackerOutboxEntryInput, "providerId" | "providerKind"> & {
	providerId: string;
	providerKind: WorkTrackerProviderKind;
};

function normalizeWorkTrackerOutboxInput(input: CreateWorkTrackerOutboxEntryInput): NormalizedWorkTrackerOutboxInput {
	const issueId = input.issueId.trim();
	if (issueId.length === 0) throw new Error("Work tracker issue id must be a non-empty string");
	const body = input.body.trim();
	if (body.length === 0) throw new Error("Work tracker outbox body must be a non-empty string");
	const providerKind = input.providerKind ?? "custom";
	const providerId = input.providerId?.trim() || providerKind;
	const normalized: NormalizedWorkTrackerOutboxInput = { providerId, providerKind, issueId, body };
	if (input.kind !== undefined) normalized.kind = input.kind;
	addTrimmed(normalized, "outputFile", input.outputFile);
	addTrimmed(normalized, "jobId", input.jobId);
	addTrimmed(normalized, "sessionId", input.sessionId);
	addTrimmed(normalized, "taskId", input.taskId);
	addTrimmed(normalized, "note", input.note);
	return normalized;
}

function addTrimmed<T extends Record<string, unknown>>(target: T, key: keyof T, value: string | undefined): void {
	const trimmed = value?.trim();
	if (trimmed !== undefined && trimmed.length > 0) target[key] = trimmed as T[keyof T];
}

function isWorkTrackerOutboxFile(value: unknown): value is WorkTrackerOutboxFile {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return Array.isArray(candidate.entries) && candidate.entries.every(isWorkTrackerOutboxEntry);
}

function isWorkTrackerOutboxEntry(value: unknown): value is WorkTrackerOutboxEntry {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.id === "string" &&
		typeof candidate.providerId === "string" &&
		typeof candidate.providerKind === "string" &&
		typeof candidate.issueId === "string" &&
		typeof candidate.kind === "string" &&
		typeof candidate.status === "string" &&
		typeof candidate.body === "string" &&
		typeof candidate.createdAt === "string" &&
		typeof candidate.updatedAt === "string"
	);
}

function isNotFoundError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
