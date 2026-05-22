import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClankyPaths } from "../paths.ts";
import { CronRunLedger } from "../state/index-db.ts";

export type CronDelivery = "stdout" | "file" | `session:${string}` | `swarm:${string}` | `linear:${string}`;

export type CronRunStatus = "ok" | "error";

export interface CronJob {
	id: string;
	schedule: string;
	prompt: string;
	deliver: CronDelivery;
	enabled: boolean;
	timeoutSeconds: number;
	createdAt: string;
	updatedAt: string;
	skill?: string;
	provider?: string;
	model?: string;
	workdir?: string;
	idempotencyKey?: string;
	nextFire?: string;
	lastFire?: string;
	lastStatus?: CronRunStatus;
	lastError?: string;
	lastOutputFile?: string;
}

export interface CreateCronJobInput {
	schedule: string;
	prompt: string;
	deliver?: CronDelivery;
	enabled?: boolean;
	timeoutSeconds?: number;
	skill?: string;
	provider?: string;
	model?: string;
	workdir?: string;
	idempotencyKey?: string;
}

export interface CronRunRecord {
	status: CronRunStatus;
	firedAt: Date;
	outputFile?: string;
	error?: string;
	advanceSchedule: boolean;
}

export interface CronIdempotencyRun {
	key: string;
	jobId: string;
	recordedAt: string;
}

interface CronJobsFile {
	jobs: CronJob[];
}

type OptionalCronJobStringKey =
	| "skill"
	| "provider"
	| "model"
	| "workdir"
	| "idempotencyKey"
	| "nextFire"
	| "lastFire"
	| "lastError"
	| "lastOutputFile";

const DEFAULT_TIMEOUT_SECONDS = 180;
const OUTPUTS_TO_KEEP = 3;

export class CronJobStore {
	private readonly paths: ClankyPaths;
	private readonly runs: CronRunLedger;

	constructor(paths: ClankyPaths) {
		this.paths = paths;
		this.runs = new CronRunLedger(paths);
	}

	async ensure(): Promise<void> {
		await mkdir(this.paths.cronDir, { recursive: true, mode: 0o700 });
		await mkdir(this.paths.cronOutputsDir, { recursive: true, mode: 0o700 });
		await this.runs.ensure();
	}

	async list(): Promise<CronJob[]> {
		const file = await this.readFile();
		return file.jobs.sort((a, b) => a.id.localeCompare(b.id));
	}

	async get(jobId: string): Promise<CronJob | undefined> {
		const jobs = await this.list();
		return jobs.find((job) => job.id === jobId);
	}

	async add(input: CreateCronJobInput, now = new Date()): Promise<CronJob> {
		const schedule = input.schedule.trim();
		const prompt = input.prompt.trim();
		if (!schedule) throw new Error("Cron schedule must be a non-empty string");
		if (!prompt) throw new Error("Cron prompt must be a non-empty string");

		const nextFire = computeNextFire(schedule, now);
		const timestamp = now.toISOString();
		const job: CronJob = {
			id: randomUUID(),
			schedule,
			prompt,
			deliver: input.deliver ?? "stdout",
			enabled: input.enabled ?? true,
			timeoutSeconds: input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		if (input.skill !== undefined) job.skill = input.skill;
		if (input.provider !== undefined) job.provider = input.provider;
		if (input.model !== undefined) job.model = input.model;
		if (input.workdir !== undefined) job.workdir = input.workdir;
		if (input.idempotencyKey !== undefined) job.idempotencyKey = input.idempotencyKey;
		if (nextFire !== undefined) job.nextFire = nextFire.toISOString();
		validateCronJob(job);

		const file = await this.readFile();
		file.jobs.push(job);
		await this.writeFile(file);
		return job;
	}

	async remove(jobId: string): Promise<boolean> {
		const file = await this.readFile();
		const remaining = file.jobs.filter((job) => job.id !== jobId);
		if (remaining.length === file.jobs.length) return false;
		await this.writeFile({ jobs: remaining });
		return true;
	}

	async setEnabled(jobId: string, enabled: boolean, now = new Date()): Promise<CronJob> {
		const file = await this.readFile();
		const job = findMutableJob(file.jobs, jobId);
		job.enabled = enabled;
		job.updatedAt = now.toISOString();
		if (enabled && job.nextFire === undefined) {
			const nextFire = computeNextFire(job.schedule, now);
			if (nextFire !== undefined) job.nextFire = nextFire.toISOString();
		}
		await this.writeFile(file);
		return job;
	}

	async dueJobs(now = new Date()): Promise<CronJob[]> {
		const jobs = await this.list();
		return jobs.filter((job) => {
			if (!job.enabled || job.nextFire === undefined) return false;
			return new Date(job.nextFire).getTime() <= now.getTime();
		});
	}

	async recordRun(jobId: string, record: CronRunRecord): Promise<CronJob> {
		const file = await this.readFile();
		const job = findMutableJob(file.jobs, jobId);
		job.lastFire = record.firedAt.toISOString();
		job.lastStatus = record.status;
		job.updatedAt = record.firedAt.toISOString();
		if (record.outputFile !== undefined) job.lastOutputFile = record.outputFile;
		if (record.error !== undefined) {
			job.lastError = record.error;
		} else {
			delete job.lastError;
		}
		if (record.advanceSchedule) {
			const nextFire = computeNextFire(job.schedule, new Date(record.firedAt.getTime() + 1000));
			if (nextFire === undefined) {
				delete job.nextFire;
				job.enabled = false;
			} else {
				job.nextFire = nextFire.toISOString();
			}
		}
		await this.writeFile(file);
		return job;
	}

	async hasIdempotencyKey(key: string): Promise<boolean> {
		return await this.runs.hasKey(key);
	}

	async recordIdempotencyKey(key: string, jobId: string, now = new Date()): Promise<void> {
		await this.runs.recordKey(key, jobId, now);
	}

	async listIdempotencyRuns(): Promise<CronIdempotencyRun[]> {
		return await this.runs.list();
	}

	async writeOutput(job: CronJob, output: string, now = new Date()): Promise<string> {
		await this.ensure();
		const safeTimestamp = now.toISOString().replaceAll(":", "-");
		const outputFile = join(this.paths.cronOutputsDir, `${job.id}-${safeTimestamp}.txt`);
		await writeFile(outputFile, output, { mode: 0o600 });
		await this.rotateOutputs(job.id);
		return outputFile;
	}

	private async readFile(): Promise<CronJobsFile> {
		await this.ensure();
		try {
			const content = await readFile(this.paths.cronJobsFile, "utf8");
			const parsed = JSON.parse(content) as unknown;
			const file = parseCronJobsFile(parsed);
			if (file === undefined) throw new Error(`Invalid cron jobs file: ${this.paths.cronJobsFile}`);
			return file;
		} catch (error) {
			if (isNotFoundError(error)) return { jobs: [] };
			throw error;
		}
	}

	private async writeFile(file: CronJobsFile): Promise<void> {
		await this.ensure();
		const tempFile = `${this.paths.cronJobsFile}.${process.pid}.tmp`;
		await writeFile(tempFile, `${JSON.stringify(file, null, "\t")}\n`, { mode: 0o600 });
		await rename(tempFile, this.paths.cronJobsFile);
	}

	private async rotateOutputs(jobId: string): Promise<void> {
		const files = await readdir(this.paths.cronOutputsDir).catch(() => []);
		const outputs = files
			.filter((file) => file.startsWith(`${jobId}-`) && file.endsWith(".txt"))
			.sort()
			.reverse();
		for (const file of outputs.slice(OUTPUTS_TO_KEEP)) {
			await unlink(join(this.paths.cronOutputsDir, file)).catch(() => undefined);
		}
	}

	close(): void {
		this.runs.close();
	}
}

export function computeNextFire(schedule: string, after: Date): Date | undefined {
	const interval = parseIntervalSchedule(schedule);
	if (interval !== undefined) return new Date(after.getTime() + interval);

	const timestamp = Date.parse(schedule);
	if (Number.isFinite(timestamp)) {
		return timestamp > after.getTime() ? new Date(timestamp) : undefined;
	}

	const fields = schedule.trim().split(/\s+/);
	if (fields.length !== 5) {
		throw new Error(`Unsupported cron schedule: ${schedule}`);
	}
	return findNextCronFire(fields, after);
}

export function buildCronIdempotencyKey(template: string, scheduledFor: Date): string {
	const year = `${scheduledFor.getFullYear()}`;
	const month = `${scheduledFor.getMonth() + 1}`.padStart(2, "0");
	const day = `${scheduledFor.getDate()}`.padStart(2, "0");
	return template
		.replaceAll(templateToken("YYYY"), year)
		.replaceAll(templateToken("MM"), month)
		.replaceAll(templateToken("DD"), day)
		.replaceAll(templateToken("YYYYMMDD"), `${year}${month}${day}`)
		.replaceAll(templateToken("YYYY-MM-DD"), `${year}-${month}-${day}`)
		.replaceAll(templateToken("ISO"), scheduledFor.toISOString());
}

function templateToken(name: string): string {
	return `$${"{"}${name}${"}"}`;
}

function parseIntervalSchedule(schedule: string): number | undefined {
	const match = /^every\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hour|hours|d|day|days)$/i.exec(
		schedule.trim(),
	);
	if (!match) return undefined;
	const amount = Number.parseInt(match[1] ?? "", 10);
	if (!Number.isInteger(amount) || amount <= 0) throw new Error(`Invalid interval schedule: ${schedule}`);
	const unit = (match[2] ?? "").toLowerCase();
	if (unit.startsWith("s")) return amount * 1000;
	if (unit.startsWith("m")) return amount * 60 * 1000;
	if (unit.startsWith("h")) return amount * 60 * 60 * 1000;
	return amount * 24 * 60 * 60 * 1000;
}

function findNextCronFire(fields: string[], after: Date): Date {
	const [minuteField, hourField, dayField, monthField, weekdayField] = fields;
	if (
		minuteField === undefined ||
		hourField === undefined ||
		dayField === undefined ||
		monthField === undefined ||
		weekdayField === undefined
	) {
		throw new Error("Cron schedule must have five fields");
	}
	const minutes = parseCronField(minuteField, 0, 59);
	const hours = parseCronField(hourField, 0, 23);
	const days = parseCronField(dayField, 1, 31);
	const months = parseCronField(monthField, 1, 12);
	const weekdays = parseCronField(weekdayField, 0, 7).map((day) => (day === 7 ? 0 : day));
	const candidate = new Date(after.getTime());
	candidate.setSeconds(0, 0);
	candidate.setMinutes(candidate.getMinutes() + 1);
	const end = new Date(after.getTime() + 366 * 24 * 60 * 60 * 1000);

	while (candidate.getTime() <= end.getTime()) {
		if (
			minutes.includes(candidate.getMinutes()) &&
			hours.includes(candidate.getHours()) &&
			days.includes(candidate.getDate()) &&
			months.includes(candidate.getMonth() + 1) &&
			weekdays.includes(candidate.getDay())
		) {
			return candidate;
		}
		candidate.setMinutes(candidate.getMinutes() + 1);
	}
	throw new Error(`No cron fire time found within one year for ${fields.join(" ")}`);
}

function parseCronField(field: string, min: number, max: number): number[] {
	const values = new Set<number>();
	for (const part of field.split(",")) {
		addCronPartValues(values, part, min, max);
	}
	return [...values].sort((a, b) => a - b);
}

function addCronPartValues(values: Set<number>, part: string, min: number, max: number): void {
	const [rangeText, stepText] = part.split("/");
	const step = stepText === undefined ? 1 : Number.parseInt(stepText, 10);
	if (!Number.isInteger(step) || step <= 0) throw new Error(`Invalid cron step: ${part}`);

	let start = min;
	let end = max;
	if (rangeText !== "*") {
		const rangeParts = (rangeText ?? "").split("-");
		start = Number.parseInt(rangeParts[0] ?? "", 10);
		end = rangeParts[1] === undefined ? start : Number.parseInt(rangeParts[1], 10);
	}
	if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
		throw new Error(`Invalid cron field: ${part}`);
	}
	for (let value = start; value <= end; value += step) values.add(value);
}

function findMutableJob(jobs: CronJob[], jobId: string): CronJob {
	const job = jobs.find((candidate) => candidate.id === jobId);
	if (job === undefined) throw new Error(`Unknown cron job: ${jobId}`);
	return job;
}

function validateCronJob(job: CronJob): void {
	if (!Number.isInteger(job.timeoutSeconds) || job.timeoutSeconds <= 0) {
		throw new Error("Cron timeout must be a positive integer number of seconds");
	}
	if (!isCronDelivery(job.deliver)) throw new Error(`Unsupported cron delivery target: ${job.deliver}`);
}

function parseCronJobsFile(value: unknown): CronJobsFile | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = value as Record<string, unknown>;
	if (!Array.isArray(candidate.jobs)) return undefined;
	const jobs: CronJob[] = [];
	const now = new Date();
	for (const item of candidate.jobs) {
		const job = normalizeCronJob(item, now);
		if (job === undefined) return undefined;
		jobs.push(job);
	}
	return { jobs };
}

function normalizeCronJob(value: unknown, now: Date): CronJob | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = value as Record<string, unknown>;
	const id = stringValue(candidate.id);
	const schedule = stringValue(candidate.schedule);
	const prompt = stringValue(candidate.prompt);
	if (id === undefined || schedule === undefined || prompt === undefined) return undefined;

	const deliverValue = candidate.deliver ?? "stdout";
	if (typeof deliverValue !== "string" || !isCronDelivery(deliverValue)) return undefined;
	const enabledValue = candidate.enabled ?? true;
	if (typeof enabledValue !== "boolean") return undefined;
	const timeoutSeconds = numberValue(candidate.timeoutSeconds ?? candidate.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS);
	if (timeoutSeconds === undefined) return undefined;

	const timestamp = now.toISOString();
	const createdAt = stringValue(candidate.createdAt ?? candidate.created_at) ?? timestamp;
	const updatedAt = stringValue(candidate.updatedAt ?? candidate.updated_at) ?? createdAt;
	const job: CronJob = {
		id,
		schedule,
		prompt,
		deliver: deliverValue,
		enabled: enabledValue,
		timeoutSeconds,
		createdAt,
		updatedAt,
	};
	addOptionalString(job, "skill", candidate.skill);
	addOptionalString(job, "provider", candidate.provider);
	addOptionalString(job, "model", candidate.model);
	addOptionalString(job, "workdir", candidate.workdir);
	addOptionalString(job, "idempotencyKey", candidate.idempotencyKey ?? candidate.idempotency_key);
	addOptionalString(job, "nextFire", candidate.nextFire ?? candidate.next_fire);
	addOptionalString(job, "lastFire", candidate.lastFire ?? candidate.last_fire);
	addOptionalString(job, "lastError", candidate.lastError ?? candidate.last_error);
	addOptionalString(job, "lastOutputFile", candidate.lastOutputFile ?? candidate.last_output_file);
	const lastStatus = candidate.lastStatus ?? candidate.last_status;
	if (lastStatus === "ok" || lastStatus === "error") job.lastStatus = lastStatus;

	try {
		validateCronJob(job);
		if (job.enabled && job.nextFire === undefined) {
			const nextFire = computeNextFire(job.schedule, now);
			if (nextFire !== undefined) job.nextFire = nextFire.toISOString();
		}
	} catch {
		return undefined;
	}
	return job;
}

function isCronDelivery(value: string): value is CronDelivery {
	return (
		value === "stdout" ||
		value === "file" ||
		value.startsWith("session:") ||
		value.startsWith("swarm:") ||
		value.startsWith("linear:")
	);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function addOptionalString(job: CronJob, key: OptionalCronJobStringKey, value: unknown): void {
	if (typeof value === "string" && value.trim().length > 0) {
		job[key] = value;
	}
}

function isNotFoundError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
