import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	buildCronIdempotencyKey,
	CronJobStore,
	CronScheduler,
	type CronTickResult,
	DEFAULT_CRON_TICK_INTERVAL_MS,
	resolveClankyPaths,
	SessionRegistry,
} from "@clanky/core";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

if (DEFAULT_CRON_TICK_INTERVAL_MS !== 60_000) {
	throw new Error(`Default cron tick interval drifted from 60s: ${DEFAULT_CRON_TICK_INTERVAL_MS}`);
}

const homeDir = await mkdtemp(join(tmpdir(), "clanky-cron-"));
const registry = new SessionRegistry({ homeDir });
await registry.start();
const store = new CronJobStore(registry.paths);
const idempotencyTemplate = ["cron-", "$", "{ISO}"].join("");
const dailyIdempotencyTemplate = ["daily-digest-", "$", "{YYYYMMDD}", "-", "$", "{YYYY-MM-DD}"].join("");
const manualIdempotencyTemplate = ["manual-digest-", "$", "{YYYYMMDD}"].join("");
const timeoutHomeDir = await mkdtemp(join(tmpdir(), "clanky-cron-timeout-"));
const timeoutProvider = "clanky-cron-timeout-faux";
const timeoutModel = "clanky-cron-timeout-faux-model";
const timeoutApi = "clanky-cron-timeout-faux-api";
const timeoutState = { callCount: 0 };
const timeoutRegistry = new SessionRegistry({
	homeDir: timeoutHomeDir,
	configureModelRegistry: (modelRegistry) => {
		modelRegistry.registerProvider(timeoutProvider, {
			api: timeoutApi,
			baseUrl: "http://localhost:0",
			apiKey: "test-key",
			streamSimple: (streamModel, _context, options) => createTimeoutStream(streamModel, options, timeoutState),
			models: [
				{
					id: timeoutModel,
					name: "Clanky Cron Timeout Faux Model",
					reasoning: false,
					input: ["text"],
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
					},
					contextWindow: 128_000,
					maxTokens: 4_096,
				},
			],
		});
	},
});
const timeoutStore = new CronJobStore(timeoutRegistry.paths);
const timeoutScheduler = new CronScheduler({ registry: timeoutRegistry, store: timeoutStore });
const bootReplayHomeDir = await mkdtemp(join(tmpdir(), "clanky-cron-boot-replay-"));
const bootReplayProvider = "clanky-cron-boot-replay-faux";
const bootReplayModel = "clanky-cron-boot-replay-faux-model";
const bootReplayApi = "clanky-cron-boot-replay-faux-api";
const bootReplayText = "boot replay cron response";
const bootReplayState = { callCount: 0 };
const bootReplayRegistry = new SessionRegistry({
	homeDir: bootReplayHomeDir,
	configureModelRegistry: (modelRegistry) => {
		modelRegistry.registerProvider(bootReplayProvider, {
			api: bootReplayApi,
			baseUrl: "http://localhost:0",
			apiKey: "test-key",
			streamSimple: (streamModel) => createImmediateStream(streamModel, bootReplayText, bootReplayState),
			models: [
				{
					id: bootReplayModel,
					name: "Clanky Cron Boot Replay Faux Model",
					reasoning: false,
					input: ["text"],
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
					},
					contextWindow: 128_000,
					maxTokens: 4_096,
				},
			],
		});
	},
});
const bootReplayStore = new CronJobStore(bootReplayRegistry.paths);
const bootReplayScheduler = new CronScheduler({
	registry: bootReplayRegistry,
	store: bootReplayStore,
	tickIntervalMs: 60_000,
});
const intervalHomeDir = await mkdtemp(join(tmpdir(), "clanky-cron-interval-"));
const intervalProvider = "clanky-cron-interval-faux";
const intervalModel = "clanky-cron-interval-faux-model";
const intervalApi = "clanky-cron-interval-faux-api";
const intervalText = "interval cron response";
const intervalState = { callCount: 0 };
const intervalRegistry = new SessionRegistry({
	homeDir: intervalHomeDir,
	configureModelRegistry: (modelRegistry) => {
		modelRegistry.registerProvider(intervalProvider, {
			api: intervalApi,
			baseUrl: "http://localhost:0",
			apiKey: "test-key",
			streamSimple: (streamModel) => createImmediateStream(streamModel, intervalText, intervalState),
			models: [
				{
					id: intervalModel,
					name: "Clanky Cron Interval Faux Model",
					reasoning: false,
					input: ["text"],
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
					},
					contextWindow: 128_000,
					maxTokens: 4_096,
				},
			],
		});
	},
});
const intervalStore = new CronJobStore(intervalRegistry.paths);
const intervalScheduler = new CronScheduler({
	registry: intervalRegistry,
	store: intervalStore,
	tickIntervalMs: 25,
});
const swarmDeliveryHomeDir = await mkdtemp(join(tmpdir(), "clanky-cron-swarm-delivery-"));
const swarmDeliveryProvider = "clanky-cron-swarm-delivery-faux";
const swarmDeliveryModel = "clanky-cron-swarm-delivery-faux-model";
const swarmDeliveryApi = "clanky-cron-swarm-delivery-faux-api";
const swarmDeliveryText = "swarm delivery cron response";
const swarmDeliveryState: { callCount: number } = { callCount: 0 };
const swarmDeliveryRegistry = new SessionRegistry({
	homeDir: swarmDeliveryHomeDir,
	configureModelRegistry: (modelRegistry) => {
		modelRegistry.registerProvider(swarmDeliveryProvider, {
			api: swarmDeliveryApi,
			baseUrl: "http://localhost:0",
			apiKey: "test-key",
			streamSimple: (streamModel) => createImmediateStream(streamModel, swarmDeliveryText, swarmDeliveryState),
			models: [
				{
					id: swarmDeliveryModel,
					name: "Clanky Cron Swarm Delivery Faux Model",
					reasoning: false,
					input: ["text"],
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
					},
					contextWindow: 128_000,
					maxTokens: 4_096,
				},
			],
		});
	},
});
const swarmDeliveryStore = new CronJobStore(swarmDeliveryRegistry.paths);
const swarmDeliveryScheduler = new CronScheduler({
	registry: swarmDeliveryRegistry,
	store: swarmDeliveryStore,
});
const noAuthHomeDir = await mkdtemp(join(tmpdir(), "clanky-cron-noauth-"));
const noAuthProvider = "openai";
const noAuthModel = "clanky-cron-noauth-openai";
const noAuthPaths = resolveClankyPaths({ homeDir: noAuthHomeDir });
await mkdir(dirname(noAuthPaths.modelsFile), { recursive: true, mode: 0o700 });
await writeFile(
	noAuthPaths.modelsFile,
	JSON.stringify(
		{
			providers: {
				[noAuthProvider]: {
					baseUrl: "http://localhost:0",
					models: [
						{
							id: noAuthModel,
							name: "Clanky Cron OpenAI Without Auth",
							input: ["text"],
							reasoning: false,
						},
					],
				},
			},
		},
		null,
		"\t",
	),
	{ mode: 0o600 },
);
const noAuthRegistry = new SessionRegistry({ homeDir: noAuthHomeDir });
const noAuthStore = new CronJobStore(noAuthRegistry.paths);
const noAuthScheduler = new CronScheduler({ registry: noAuthRegistry, store: noAuthStore });
const manualHomeDir = await mkdtemp(join(tmpdir(), "clanky-cron-manual-"));
const manualPaths = resolveClankyPaths({ homeDir: manualHomeDir });
const manualStore = new CronJobStore(manualPaths);

try {
	const addedAt = new Date("2026-01-01T00:00:00.000Z");
	const scheduledAt = new Date("2026-01-01T00:00:01.000Z");
	const dailyIdempotencyKey = buildCronIdempotencyKey(dailyIdempotencyTemplate, new Date(2026, 4, 21, 9, 30));
	if (dailyIdempotencyKey !== "daily-digest-20260521-2026-05-21") {
		throw new Error(`Cron date-token idempotency key expanded unexpectedly: ${dailyIdempotencyKey}`);
	}
	await mkdir(dirname(manualPaths.cronJobsFile), { recursive: true, mode: 0o700 });
	await writeFile(
		manualPaths.cronJobsFile,
		`${JSON.stringify(
			{
				jobs: [
					{
						id: "manual-snake-case-cron",
						schedule: "every 1h",
						prompt: "Human-edited cron job from the plan.",
						deliver: "file",
						enabled: true,
						timeout_seconds: 600,
						idempotency_key: manualIdempotencyTemplate,
					},
				],
			},
			null,
			"\t",
		)}\n`,
		{ mode: 0o600 },
	);
	const [manualJob] = await manualStore.list();
	if (
		manualJob === undefined ||
		manualJob.id !== "manual-snake-case-cron" ||
		manualJob.timeoutSeconds !== 600 ||
		manualJob.idempotencyKey !== manualIdempotencyTemplate ||
		manualJob.createdAt === undefined ||
		manualJob.updatedAt === undefined ||
		manualJob.nextFire === undefined
	) {
		throw new Error(`Human-edited snake_case cron job did not normalize correctly: ${JSON.stringify(manualJob)}`);
	}
	const job = await store.add(
		{
			schedule: scheduledAt.toISOString(),
			prompt: "This should not run because the idempotency key already exists.",
			deliver: "file",
			idempotencyKey: idempotencyTemplate,
		},
		addedAt,
	);
	if (job.nextFire === undefined || job.idempotencyKey === undefined) {
		throw new Error("Cron job was not scheduled with an idempotency key");
	}
	if (job.timeoutSeconds !== 180) {
		throw new Error(`Cron job did not use the 3-minute default timeout: ${JSON.stringify(job)}`);
	}

	const idempotencyKey = buildCronIdempotencyKey(job.idempotencyKey, new Date(job.nextFire));
	await store.recordIdempotencyKey(idempotencyKey, job.id, addedAt);
	const [recordedRun] = await store.listIdempotencyRuns();
	if (
		recordedRun === undefined ||
		recordedRun.key === idempotencyKey ||
		!/^sha256:[0-9a-f]{64}$/.test(recordedRun.key) ||
		recordedRun.jobId !== job.id
	) {
		throw new Error(`Cron idempotency key was not hashed and recorded in index.db: ${JSON.stringify(recordedRun)}`);
	}
	await readFile(registry.paths.cronRunsFile, "utf8").then(
		() => {
			throw new Error("Cron idempotency should be recorded in index.db, not cron/runs.json");
		},
		() => undefined,
	);

	const scheduler = new CronScheduler({ registry, store });
	const tick = await scheduler.tick(new Date("2026-01-01T00:00:02.000Z"));
	if (tick.skipped || tick.ran.length !== 1) {
		throw new Error("Expected one due cron job to be processed");
	}
	const run = tick.ran[0];
	if (run === undefined || !run.ok || run.skipped !== true || run.idempotencyKey !== idempotencyKey) {
		throw new Error("Expected cron job to be skipped by idempotency");
	}
	if (registry.list().length !== 0) {
		throw new Error("Idempotent cron skip should not create an agent session");
	}

	const [updatedJob] = await store.list();
	if (
		updatedJob === undefined ||
		updatedJob.enabled ||
		updatedJob.nextFire !== undefined ||
		updatedJob.lastStatus !== "ok"
	) {
		throw new Error("One-shot idempotent cron job was not advanced cleanly");
	}

	const cronFieldJob = await store.add(
		{
			schedule: "30 9 * * 1",
			prompt: "Five-field cron schedule smoke.",
			deliver: "file",
		},
		new Date(2026, 0, 5, 9, 29),
	);
	const expectedCronFieldNextFire = new Date(2026, 0, 5, 9, 30).toISOString();
	if (cronFieldJob.nextFire !== expectedCronFieldNextFire) {
		throw new Error(`Five-field cron schedule resolved unexpectedly: ${JSON.stringify(cronFieldJob)}`);
	}
	const everyTwoHoursJob = await store.add(
		{
			schedule: "every 2h",
			prompt: "Plan literal interval schedule smoke.",
			deliver: "file",
		},
		new Date("2026-01-01T00:00:00.000Z"),
	);
	if (everyTwoHoursJob.nextFire !== "2026-01-01T02:00:00.000Z") {
		throw new Error(`Plan interval cron schedule resolved unexpectedly: ${JSON.stringify(everyTwoHoursJob)}`);
	}

	for (let index = 0; index < 4; index += 1) {
		await store.writeOutput(job, `output-${index}`, new Date(2026, 0, 1, 0, 0, index + 3));
	}
	const outputs = (await readdir(registry.paths.cronOutputsDir))
		.filter((file) => file.startsWith(`${job.id}-`) && file.endsWith(".txt"))
		.sort();
	if (outputs.length !== 3) {
		throw new Error(`Expected cron output rotation to keep 3 files, got ${outputs.length}`);
	}
	const newestOutput = await readFile(join(registry.paths.cronOutputsDir, outputs[2] ?? ""), "utf8");
	if (newestOutput !== "output-3") {
		throw new Error("Cron output rotation did not keep the newest output");
	}

	await writeFile(registry.paths.cronTickLockFile, `${process.pid}\n`, { mode: 0o600 });
	const lockedTick = await scheduler.tick(new Date("2026-01-01T00:00:06.000Z"));
	if (!lockedTick.skipped || lockedTick.ran.length !== 0) {
		throw new Error("Cron tick should skip when another live daemon owns the tick lock");
	}

	const stalePid = findUnusedPid();
	await writeFile(registry.paths.cronTickLockFile, `${stalePid}\n`, { mode: 0o600 });
	const recoveredTick = await scheduler.tick(new Date("2026-01-01T00:00:07.000Z"));
	if (recoveredTick.skipped || recoveredTick.ran.length !== 0) {
		throw new Error("Cron tick should reclaim stale tick locks without running disabled jobs");
	}
	await readFile(registry.paths.cronTickLockFile, "utf8").then(
		() => {
			throw new Error("Cron tick lock should be released after reclaiming a stale lock");
		},
		() => undefined,
	);

	const racingStalePid = findUnusedPid();
	await writeFile(registry.paths.cronTickLockFile, `${racingStalePid}\n`, { mode: 0o600 });
	const racingTicks = await Promise.allSettled(
		Array.from({ length: 8 }, () => scheduler.tick(new Date("2026-01-01T00:00:08.000Z"))),
	);
	const rejectedRacingTick = racingTicks.find(
		(result): result is PromiseRejectedResult => result.status === "rejected",
	);
	if (rejectedRacingTick !== undefined) {
		throw new Error(
			`Concurrent stale cron lock reclaim should skip or acquire, not throw: ${rejectedRacingTick.reason}`,
		);
	}
	const fulfilledRacingTicks = racingTicks
		.filter((result): result is PromiseFulfilledResult<CronTickResult> => result.status === "fulfilled")
		.map((result) => result.value);
	if (!fulfilledRacingTicks.some((tick) => !tick.skipped)) {
		throw new Error(`Concurrent stale cron lock reclaim never acquired the tick lock: ${JSON.stringify(racingTicks)}`);
	}
	await readFile(registry.paths.cronTickLockFile, "utf8").then(
		() => {
			throw new Error("Cron tick lock should be released after concurrent stale lock reclaim");
		},
		() => undefined,
	);

	await timeoutRegistry.start();
	const timeoutJob = await timeoutStore.add(
		{
			schedule: "2026-01-01T00:00:01.000Z",
			prompt: "This cron job should time out.",
			deliver: "file",
			provider: timeoutProvider,
			model: timeoutModel,
			timeoutSeconds: 1,
		},
		new Date("2026-01-01T00:00:00.000Z"),
	);
	const timeoutTick = await timeoutScheduler.tick(new Date("2026-01-01T00:00:02.000Z"));
	const timeoutRun = timeoutTick.ran[0];
	if (
		timeoutTick.skipped ||
		timeoutTick.ran.length !== 1 ||
		timeoutRun === undefined ||
		timeoutRun.ok ||
		timeoutRun.error !== "Cron job timed out after 1s"
	) {
		throw new Error(`Cron timeout did not return the expected error result: ${JSON.stringify(timeoutTick)}`);
	}
	const [updatedTimeoutJob] = await timeoutStore.list();
	if (
		updatedTimeoutJob?.id !== timeoutJob.id ||
		updatedTimeoutJob.lastStatus !== "error" ||
		updatedTimeoutJob.lastError !== "Cron job timed out after 1s"
	) {
		throw new Error(`Cron timeout was not persisted on the job: ${JSON.stringify(updatedTimeoutJob)}`);
	}
	if (timeoutState.callCount !== 1) {
		throw new Error(`Cron timeout should have called the faux model once, got ${timeoutState.callCount}`);
	}
	if (timeoutRegistry.list().length !== 0) {
		throw new Error(`Timed-out cron run leaked a live session: ${JSON.stringify(timeoutRegistry.list())}`);
	}

	await bootReplayRegistry.start();
	const bootReplayJob = await bootReplayStore.add(
		{
			schedule: "2026-01-01T00:00:01.000Z",
			prompt: "This due cron job should run when the scheduler starts.",
			deliver: "file",
			provider: bootReplayProvider,
			model: bootReplayModel,
		},
		new Date("2026-01-01T00:00:00.000Z"),
	);
	await bootReplayScheduler.start();
	const bootReplayRun = await waitForCronOk(bootReplayStore, bootReplayJob.id);
	if (bootReplayRun.lastOutputFile === undefined) {
		throw new Error(`Boot replay did not persist an output file: ${JSON.stringify(bootReplayRun)}`);
	}
	if ((await readFile(bootReplayRun.lastOutputFile, "utf8")) !== bootReplayText) {
		throw new Error("Boot replay output file did not contain the faux model response");
	}
	if (bootReplayState.callCount !== 1) {
		throw new Error(`Boot replay should have called the faux model once, got ${bootReplayState.callCount}`);
	}

	await intervalRegistry.start();
	await intervalScheduler.start();
	const intervalJob = await intervalStore.add(
		{
			schedule: new Date(Date.now() + 75).toISOString(),
			prompt: "This cron job should be picked up by the in-process timer after startup.",
			deliver: "file",
			provider: intervalProvider,
			model: intervalModel,
		},
		new Date(),
	);
	const intervalRun = await waitForCronOk(intervalStore, intervalJob.id);
	if (intervalRun.lastOutputFile === undefined) {
		throw new Error(`Interval cron run did not persist an output file: ${JSON.stringify(intervalRun)}`);
	}
	if ((await readFile(intervalRun.lastOutputFile, "utf8")) !== intervalText) {
		throw new Error("Interval cron output file did not contain the faux model response");
	}
	if (intervalState.callCount !== 1) {
		throw new Error(`Interval cron should have called the faux model once, got ${intervalState.callCount}`);
	}

	await swarmDeliveryRegistry.start();
	const fileDeliveryJob = await swarmDeliveryStore.add(
		{
			schedule: "2026-01-01T00:00:03.000Z",
			prompt: "This cron job should deliver to a file.",
			deliver: "file",
			provider: swarmDeliveryProvider,
			model: swarmDeliveryModel,
		},
		new Date("2026-01-01T00:00:02.000Z"),
	);
	const fileDeliveryTick = await swarmDeliveryScheduler.tick(new Date("2026-01-01T00:00:04.000Z"));
	const fileDeliveryRun = fileDeliveryTick.ran[0];
	if (
		fileDeliveryTick.skipped ||
		fileDeliveryTick.ran.length !== 1 ||
		fileDeliveryRun === undefined ||
		!fileDeliveryRun.ok ||
		fileDeliveryRun.text !== swarmDeliveryText ||
		fileDeliveryRun.outputFile === undefined ||
		fileDeliveryRun.deliveredTo !== fileDeliveryRun.outputFile
	) {
		throw new Error(`Cron file delivery returned unexpected result: ${JSON.stringify(fileDeliveryTick)}`);
	}
	if ((await readFile(fileDeliveryRun.outputFile, "utf8")) !== swarmDeliveryText) {
		throw new Error("Cron file delivery output file did not contain the model response");
	}
	const [updatedFileDeliveryJob] = (await swarmDeliveryStore.list()).filter(
		(candidate) => candidate.id === fileDeliveryJob.id,
	);
	if (updatedFileDeliveryJob?.id !== fileDeliveryJob.id || updatedFileDeliveryJob.enabled) {
		throw new Error(`Cron file delivery job was not advanced cleanly: ${JSON.stringify(updatedFileDeliveryJob)}`);
	}
	if (Number(swarmDeliveryState.callCount) !== 1) {
		throw new Error(
			`Cron file delivery should have made the first faux model call, got ${swarmDeliveryState.callCount}`,
		);
	}
	const stdoutDeliveryJob = await swarmDeliveryStore.add(
		{
			schedule: "2026-01-01T00:00:05.000Z",
			prompt: "This cron job should deliver to stdout.",
			deliver: "stdout",
			provider: swarmDeliveryProvider,
			model: swarmDeliveryModel,
		},
		new Date("2026-01-01T00:00:04.000Z"),
	);
	const stdoutLogs: string[] = [];
	const originalConsoleLog = console.log;
	let stdoutDeliveryTick: CronTickResult;
	try {
		console.log = (...values: unknown[]) => {
			stdoutLogs.push(values.map(String).join(" "));
		};
		stdoutDeliveryTick = await swarmDeliveryScheduler.tick(new Date("2026-01-01T00:00:06.000Z"));
	} finally {
		console.log = originalConsoleLog;
	}
	const stdoutDeliveryRun = stdoutDeliveryTick.ran[0];
	if (
		stdoutDeliveryTick.skipped ||
		stdoutDeliveryTick.ran.length !== 1 ||
		stdoutDeliveryRun === undefined ||
		!stdoutDeliveryRun.ok ||
		stdoutDeliveryRun.text !== swarmDeliveryText ||
		stdoutDeliveryRun.outputFile === undefined ||
		stdoutDeliveryRun.deliveredTo !== "stdout"
	) {
		throw new Error(`Cron stdout delivery returned unexpected result: ${JSON.stringify(stdoutDeliveryTick)}`);
	}
	if ((await readFile(stdoutDeliveryRun.outputFile, "utf8")) !== swarmDeliveryText) {
		throw new Error("Cron stdout delivery output file did not contain the model response");
	}
	if (stdoutLogs.length !== 1 || stdoutLogs[0] !== swarmDeliveryText) {
		throw new Error(`Cron stdout delivery did not write the model response to stdout: ${JSON.stringify(stdoutLogs)}`);
	}
	const [updatedStdoutDeliveryJob] = (await swarmDeliveryStore.list()).filter(
		(candidate) => candidate.id === stdoutDeliveryJob.id,
	);
	if (updatedStdoutDeliveryJob?.id !== stdoutDeliveryJob.id || updatedStdoutDeliveryJob.enabled) {
		throw new Error(`Cron stdout delivery job was not advanced cleanly: ${JSON.stringify(updatedStdoutDeliveryJob)}`);
	}
	if (Number(swarmDeliveryState.callCount) !== 2) {
		throw new Error(
			`Cron stdout delivery should have made the second faux model call, got ${swarmDeliveryState.callCount}`,
		);
	}

	await noAuthRegistry.start();
	const noAuthJob = await noAuthStore.add(
		{
			schedule: "2026-01-01T00:00:01.000Z",
			prompt: "This cron job should fail before calling a model.",
			deliver: "file",
			provider: noAuthProvider,
			model: noAuthModel,
		},
		new Date("2026-01-01T00:00:00.000Z"),
	);
	const previousOpenAiKey = process.env.OPENAI_API_KEY;
	delete process.env.OPENAI_API_KEY;
	let noAuthTick: CronTickResult;
	try {
		noAuthTick = await noAuthScheduler.tick(new Date("2026-01-01T00:00:02.000Z"));
	} finally {
		if (previousOpenAiKey === undefined) {
			delete process.env.OPENAI_API_KEY;
		} else {
			process.env.OPENAI_API_KEY = previousOpenAiKey;
		}
	}
	const noAuthRun = noAuthTick.ran[0];
	if (
		noAuthTick.skipped ||
		noAuthTick.ran.length !== 1 ||
		noAuthRun === undefined ||
		noAuthRun.ok ||
		noAuthRun.error !==
			"No configured Pi model is available. Run `pi /login` or set provider API keys before running cron jobs."
	) {
		throw new Error(`Cron missing-auth run did not fail with the expected error: ${JSON.stringify(noAuthTick)}`);
	}
	const [updatedNoAuthJob] = await noAuthStore.list();
	if (updatedNoAuthJob?.id !== noAuthJob.id || updatedNoAuthJob.lastStatus !== "error") {
		throw new Error(`Cron missing-auth error was not persisted on the job: ${JSON.stringify(updatedNoAuthJob)}`);
	}
	if (updatedNoAuthJob.lastError !== noAuthRun.error) {
		throw new Error(`Cron missing-auth persisted unexpected error: ${JSON.stringify(updatedNoAuthJob)}`);
	}
	if (noAuthRegistry.list().length !== 0) {
		throw new Error(`Missing-auth cron run leaked a live session: ${JSON.stringify(noAuthRegistry.list())}`);
	}

	console.log(
		JSON.stringify({
			jobId: job.id,
			skipped: true,
			outputs: outputs.length,
			stalePid,
			racingStalePid,
			timeoutJobId: timeoutJob.id,
			cronFieldJobId: cronFieldJob.id,
			everyTwoHoursJobId: everyTwoHoursJob.id,
			manualJobId: manualJob.id,
			bootReplayJobId: bootReplayJob.id,
			intervalJobId: intervalJob.id,
			fileDeliveryJobId: fileDeliveryJob.id,
			stdoutDeliveryJobId: stdoutDeliveryJob.id,
			noAuthJobId: noAuthJob.id,
		}),
	);
} finally {
	bootReplayScheduler.stop();
	intervalScheduler.stop();
	await registry.dispose();
	await timeoutRegistry.dispose();
	await bootReplayRegistry.dispose();
	await intervalRegistry.dispose();
	await swarmDeliveryRegistry.dispose();
	await noAuthRegistry.dispose();
	manualStore.close();
	await Promise.all(
		[
			homeDir,
			timeoutHomeDir,
			bootReplayHomeDir,
			intervalHomeDir,
			swarmDeliveryHomeDir,
			noAuthHomeDir,
			manualHomeDir,
		].map((dir) => rm(dir, { force: true, recursive: true })),
	);
}

function findUnusedPid(): number {
	for (let pid = 999_999; pid > 100_000; pid -= 1) {
		try {
			process.kill(pid, 0);
		} catch {
			return pid;
		}
	}
	throw new Error("Could not find an unused PID for stale lock smoke test");
}

function createTimeoutStream(
	streamModel: Model<Api>,
	options: SimpleStreamOptions | undefined,
	state: { callCount: number },
) {
	state.callCount += 1;
	const stream = createAssistantMessageEventStream();
	const pending = createAssistantMessage(streamModel, "", "stop");
	let closed = false;

	queueMicrotask(() => {
		stream.push({ type: "start", partial: { ...pending, content: [] } });
		const timeout = setTimeout(() => {
			if (closed) return;
			closed = true;
			const completed = createAssistantMessage(streamModel, "late cron response", "stop");
			stream.push({ type: "text_start", contentIndex: 0, partial: { ...completed, content: [] } });
			stream.push({ type: "text_delta", contentIndex: 0, delta: "late cron response", partial: completed });
			stream.push({ type: "text_end", contentIndex: 0, content: "late cron response", partial: completed });
			stream.push({ type: "done", reason: "stop", message: completed });
			stream.end(completed);
		}, 5000);
		const abort = () => {
			if (closed) return;
			closed = true;
			clearTimeout(timeout);
			const aborted = createAssistantMessage(streamModel, "", "aborted");
			stream.push({ type: "error", reason: "aborted", error: aborted });
			stream.end(aborted);
		};
		if (options?.signal?.aborted) {
			abort();
			return;
		}
		options?.signal?.addEventListener("abort", abort, { once: true });
	});

	return stream;
}

function createImmediateStream(streamModel: Model<Api>, text: string, state: { callCount: number }) {
	state.callCount += 1;
	const message = createAssistantMessage(streamModel, text, "stop");
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		stream.push({ type: "text_start", contentIndex: 0, partial: message });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
	});
	return stream;
}

async function waitForCronOk(store: CronJobStore, jobId: string) {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const job = (await store.list()).find((candidate) => candidate.id === jobId);
		if (job?.lastStatus === "ok") return job;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`Timed out waiting for cron job ${jobId}`);
}

function createAssistantMessage(
	streamModel: Model<Api>,
	text: string,
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		provider: streamModel.provider,
		api: streamModel.api,
		model: streamModel.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}
