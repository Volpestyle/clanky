import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionRegistry } from "../session-registry.ts";
import { formatSkillPrompt } from "../skills/injector.ts";
import { deliverCronOutput } from "./delivery.ts";
import { buildCronIdempotencyKey, type CreateCronJobInput, type CronJob, CronJobStore } from "./jobs.ts";

export interface CronRunResult {
	ok: boolean;
	jobId: string;
	startedAt: string;
	finishedAt: string;
	sessionId?: string;
	sessionFile?: string;
	text?: string;
	outputFile?: string;
	deliveredTo?: string;
	linearOutboxId?: string;
	idempotencyKey?: string;
	skipped?: boolean;
	error?: string;
}

export interface CronTickResult {
	ran: CronRunResult[];
	skipped: boolean;
}

export interface CronSchedulerOptions {
	registry: SessionRegistry;
	store?: CronJobStore;
	tickIntervalMs?: number;
	onTickRun?: (result: CronRunResult) => void;
}

export const DEFAULT_CRON_TICK_INTERVAL_MS = 60_000;

export class CronScheduler {
	readonly store: CronJobStore;

	private readonly registry: SessionRegistry;
	private readonly tickIntervalMs: number;
	private readonly onTickRun: ((result: CronRunResult) => void) | undefined;
	private readonly runningJobs = new Set<string>();
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(options: CronSchedulerOptions) {
		this.registry = options.registry;
		this.store = options.store ?? new CronJobStore(options.registry.paths);
		this.tickIntervalMs = options.tickIntervalMs ?? DEFAULT_CRON_TICK_INTERVAL_MS;
		this.onTickRun = options.onTickRun;
	}

	async start(): Promise<void> {
		await this.store.ensure();
		if (this.timer !== undefined) return;
		const runTick = () => {
			void this.tick().catch((error: unknown) => {
				console.error(error instanceof Error ? error.message : String(error));
			});
		};
		runTick();
		this.timer = setInterval(runTick, this.tickIntervalMs);
	}

	stop(): void {
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.store.close();
	}

	async listJobs(): Promise<CronJob[]> {
		return await this.store.list();
	}

	async addJob(input: CreateCronJobInput): Promise<CronJob> {
		return await this.store.add(input);
	}

	async removeJob(jobId: string): Promise<boolean> {
		return await this.store.remove(jobId);
	}

	async setJobEnabled(jobId: string, enabled: boolean): Promise<CronJob> {
		return await this.store.setEnabled(jobId, enabled);
	}

	async runNow(jobId: string): Promise<CronRunResult> {
		const job = await this.store.get(jobId);
		if (job === undefined) throw new Error(`Unknown cron job: ${jobId}`);
		return await this.executeJob(job, false);
	}

	async tick(now = new Date()): Promise<CronTickResult> {
		const releaseLock = await acquireTickLock(this.registry.paths.cronTickLockFile);
		if (releaseLock === undefined) return { ran: [], skipped: true };
		try {
			const dueJobs = await this.store.dueJobs(now);
			const ran: CronRunResult[] = [];
			for (const job of dueJobs) {
				if (this.runningJobs.has(job.id)) continue;
				const result = await this.executeJob(job, true);
				ran.push(result);
				this.publishTickRun(result);
			}
			return { ran, skipped: false };
		} finally {
			await releaseLock();
		}
	}

	private async executeJob(job: CronJob, advanceSchedule: boolean): Promise<CronRunResult> {
		const startedAt = new Date();
		if (this.runningJobs.has(job.id)) {
			return {
				ok: false,
				jobId: job.id,
				startedAt: startedAt.toISOString(),
				finishedAt: new Date().toISOString(),
				error: `Cron job is already running: ${job.id}`,
			};
		}

		this.runningJobs.add(job.id);
		let cronSessionId: string | undefined;
		try {
			const idempotencyKey = advanceSchedule ? scheduledIdempotencyKey(job, startedAt) : undefined;
			if (idempotencyKey !== undefined && (await this.store.hasIdempotencyKey(idempotencyKey))) {
				await this.store.recordRun(job.id, {
					status: "ok",
					firedAt: startedAt,
					advanceSchedule,
				});
				return {
					ok: true,
					jobId: job.id,
					startedAt: startedAt.toISOString(),
					finishedAt: new Date().toISOString(),
					idempotencyKey,
					skipped: true,
				};
			}

			const createOptions: Parameters<SessionRegistry["createSession"]>[0] = {};
			if (job.workdir !== undefined) createOptions.cwd = job.workdir;
			if (job.provider !== undefined) createOptions.provider = job.provider;
			if (job.model !== undefined) createOptions.model = job.model;
			const registered = await this.registry.createSession(createOptions);
			cronSessionId = registered.id;
			if (!registered.hasUsableModel) {
				throw new Error(
					"No configured Pi model is available. Run `pi /login` or set provider API keys before running cron jobs.",
				);
			}
			if (job.skill !== undefined) {
				await this.registry.recordSkillUsage({
					name: job.skill,
					source: "cron",
					sessionId: registered.id,
					jobId: job.id,
				});
			}
			const checkpointId = registered.session.sessionManager.appendCustomEntry("clanky.prompt_checkpoint", {
				source: "cron",
				status: "started",
				jobId: job.id,
				prompt: job.prompt,
				...(job.skill === undefined ? {} : { skill: job.skill }),
				timestamp: new Date().toISOString(),
			});
			const pendingPrompt: Parameters<SessionRegistry["recordPendingPrompt"]>[0] = {
				sessionId: registered.id,
				cwd: registered.cwd,
				source: "cron",
				jobId: job.id,
				prompt: job.prompt,
				...(job.skill === undefined ? {} : { skill: job.skill }),
			};
			const sessionFile = registered.session.sessionManager.getSessionFile();
			if (sessionFile !== undefined) pendingPrompt.sessionFile = sessionFile;
			await this.registry.recordPendingPrompt(pendingPrompt);
			await this.registry.refreshSessionFile(registered.id);

			const chunks: string[] = [];
			const unsubscribe = registered.session.subscribe((event) => {
				if (event.type !== "message_update") return;
				if (event.assistantMessageEvent.type !== "text_delta") return;
				chunks.push(event.assistantMessageEvent.delta);
			});
			try {
				await promptWithTimeout(
					registered.session.prompt(formatSkillPrompt(job)),
					() => registered.session.abort(),
					job.timeoutSeconds,
				);
				registered.session.sessionManager.appendCustomEntry("clanky.prompt_checkpoint", {
					source: "cron",
					status: "completed",
					checkpointId,
					jobId: job.id,
					timestamp: new Date().toISOString(),
				});
				await this.registry.clearPendingPrompt(registered.id);
				await this.registry.refreshSessionFile(registered.id);
			} finally {
				unsubscribe();
			}

			const finishedAt = new Date();
			const streamedText = chunks.join("");
			const text = streamedText.length > 0 ? streamedText : (registered.session.getLastAssistantText() ?? "");
			const deliveryOptions: Parameters<typeof deliverCronOutput>[0] = {
				registry: this.registry,
				store: this.store,
				job,
				output: text,
				finishedAt,
			};
			const delivery = await deliverCronOutput(deliveryOptions);
			if (idempotencyKey !== undefined) await this.store.recordIdempotencyKey(idempotencyKey, job.id, finishedAt);
			await this.store.recordRun(job.id, {
				status: "ok",
				firedAt: finishedAt,
				outputFile: delivery.outputFile,
				advanceSchedule,
			});
			const result: CronRunResult = {
				ok: true,
				jobId: job.id,
				startedAt: startedAt.toISOString(),
				finishedAt: finishedAt.toISOString(),
				sessionId: registered.id,
				text,
				outputFile: delivery.outputFile,
				deliveredTo: delivery.deliveredTo,
			};
			if (idempotencyKey !== undefined) result.idempotencyKey = idempotencyKey;
			if (registered.sessionFile !== undefined) result.sessionFile = registered.sessionFile;
			if (delivery.linearOutboxId !== undefined) result.linearOutboxId = delivery.linearOutboxId;
			return result;
		} catch (error) {
			const finishedAt = new Date();
			const message = error instanceof Error ? error.message : String(error);
			await this.store.recordRun(job.id, {
				status: "error",
				firedAt: finishedAt,
				error: message,
				advanceSchedule,
			});
			return {
				ok: false,
				jobId: job.id,
				startedAt: startedAt.toISOString(),
				finishedAt: finishedAt.toISOString(),
				error: message,
			};
		} finally {
			if (cronSessionId !== undefined) await this.registry.disposeSession(cronSessionId);
			this.runningJobs.delete(job.id);
		}
	}

	private publishTickRun(result: CronRunResult): void {
		try {
			this.onTickRun?.(result);
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
		}
	}
}

function scheduledIdempotencyKey(job: CronJob, fallback: Date): string | undefined {
	if (job.idempotencyKey === undefined) return undefined;
	const scheduledFor = job.nextFire === undefined ? fallback : new Date(job.nextFire);
	return buildCronIdempotencyKey(job.idempotencyKey, scheduledFor);
}

async function promptWithTimeout(
	promptPromise: Promise<void>,
	abort: () => Promise<void>,
	timeoutSeconds: number,
): Promise<void> {
	let timedOut = false;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeout = setTimeout(() => {
			timedOut = true;
			void abort();
			reject(new Error(`Cron job timed out after ${timeoutSeconds}s`));
		}, timeoutSeconds * 1000);
	});
	try {
		await Promise.race([promptPromise, timeoutPromise]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
		if (timedOut) await promptPromise.catch(() => undefined);
	}
}

async function acquireTickLock(lockFile: string): Promise<(() => Promise<void>) | undefined> {
	await mkdir(dirname(lockFile), { recursive: true, mode: 0o700 });
	try {
		await writeFile(lockFile, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
		return async () => {
			await unlink(lockFile).catch(() => undefined);
		};
	} catch (error) {
		if (!isFileExistsError(error)) throw error;
	}

	const existingPid = await readExistingPid(lockFile);
	if (existingPid !== undefined && isProcessAlive(existingPid)) return undefined;
	await unlink(lockFile).catch(() => undefined);
	try {
		await writeFile(lockFile, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
	} catch (error) {
		if (isFileExistsError(error)) return undefined;
		throw error;
	}
	return async () => {
		await unlink(lockFile).catch(() => undefined);
	};
}

async function readExistingPid(lockFile: string): Promise<number | undefined> {
	try {
		const content = await readFile(lockFile, "utf8");
		const pid = Number.parseInt(content.trim(), 10);
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function isFileExistsError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
