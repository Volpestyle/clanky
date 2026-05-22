import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGatewayServer } from "@clanky/gateway";
import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";

const homeDir = await mkdtemp(join(tmpdir(), "clanky-cli-gateway-"));
const provider = "clanky-cli-gateway-faux";
const model = "clanky-cli-gateway-faux-model";
const api = "clanky-cli-gateway-faux-api";
const sendText = "CLI gateway send response.";
const resumeText = "CLI gateway resume response.";
const httpSendText = "CLI gateway HTTP send response.";
const skillSendText = "CLI gateway skill send response.";
const cronRunText = "CLI gateway cron run-now response.";
const fauxState = {
	callCount: 0,
	responses: [sendText, resumeText, httpSendText, skillSendText, cronRunText],
};
const swarmCallsFile = join(homeDir, "swarm-calls.txt");
const previousEnv = captureEnv(
	"CLANKY_SWARM_ENABLED",
	"CLANKY_SWARM_COMMAND",
	"CLANKY_SWARM_ARGS_JSON",
	"SWARM_HARNESS_FAUX_SWARM_CALLS_FILE",
	"HERDR_PANE_ID",
	"HERDR_SOCKET",
	"HERDR_SOCKET_PATH",
	"LINEAR_API_KEY",
	"LINEAR_ACCESS_TOKEN",
	"LINEAR_GRAPHQL_ENDPOINT",
);
process.env.CLANKY_SWARM_ENABLED = "1";
process.env.CLANKY_SWARM_COMMAND = process.execPath;
process.env.CLANKY_SWARM_ARGS_JSON = JSON.stringify([
	"--import",
	"tsx",
	"packages/clanky-swarm/test/faux-swarm-mcp.ts",
]);
process.env.SWARM_HARNESS_FAUX_SWARM_CALLS_FILE = swarmCallsFile;
process.env.HERDR_PANE_ID = "pane-cli-gateway-smoke";
process.env.HERDR_SOCKET = "/tmp/legacy-herdr-cli-gateway-smoke.sock";
process.env.HERDR_SOCKET_PATH = "/tmp/herdr-cli-gateway-smoke.sock";
delete process.env.LINEAR_API_KEY;
delete process.env.LINEAR_ACCESS_TOKEN;
delete process.env.LINEAR_GRAPHQL_ENDPOINT;
const linear = await startLinearServer("team-cli");
const httpPort = await freeTcpPort();
const httpAddress = `127.0.0.1:${httpPort}`;

const server = await startGatewayServer({
	homeDir,
	http: { hostname: "127.0.0.1", port: httpPort },
	configureModelRegistry: (modelRegistry) => {
		type RegisterConfig = Parameters<typeof modelRegistry.registerProvider>[1];
		type StreamSimple = NonNullable<RegisterConfig["streamSimple"]>;
		const streamSimple: StreamSimple = ((streamModel) =>
			createFauxStream(
				streamModel as unknown as Model<Api>,
				fauxState,
			) as unknown as ReturnType<StreamSimple>) as StreamSimple;
		modelRegistry.registerProvider(provider, {
			api,
			baseUrl: "http://localhost:0",
			apiKey: "test-key",
			streamSimple,
			models: [
				{
					id: model,
					name: "Clanky CLI Gateway Faux Model",
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

try {
	const status = await runClanky(["status", "--home", homeDir]);
	assertCommandSucceeded("status", status);
	assertIncludes(status.stdout, "running: true");
	assertIncludes(status.stdout, "cron_jobs: 0");
	assertIncludes(status.stdout, "enabled_cron_jobs: 0");
	assertIncludes(status.stdout, "swarm_state: booted");
	assertIncludes(status.stdout, "swarm_peers: 2");
	assertIncludes(status.stdout, "swarm_tasks: 1");

	const httpStatus = await runClanky(["status", "--home", homeDir, "--http", httpAddress]);
	assertCommandSucceeded("http status", httpStatus);
	assertIncludes(httpStatus.stdout, "running: true");
	assertIncludes(httpStatus.stdout, "swarm_state: booted");
	assertIncludes(httpStatus.stdout, "external_mcp_servers: 0");

	const swarmStatus = await runClanky(["swarm", "status", "--home", homeDir]);
	assertCommandSucceeded("swarm status", swarmStatus);
	assertIncludes(swarmStatus.stdout, "state: booted");
	assertIncludes(swarmStatus.stdout, "workspace_backend: herdr");
	assertIncludes(swarmStatus.stdout, "workspace_handle_kind: pane");
	assertIncludes(swarmStatus.stdout, "workspace_handle: pane-cli-gateway-smoke");
	assertIncludes(swarmStatus.stdout, "workspace_socket: /tmp/herdr-cli-gateway-smoke.sock");

	const swarmPeers = await runClanky(["swarm", "peers", "--home", homeDir]);
	assertCommandSucceeded("swarm peers", swarmPeers);
	assertIncludes(swarmPeers.stdout, "clanky-faux-worker");

	const swarmTasks = await runClanky(["swarm", "tasks", "--home", homeDir]);
	assertCommandSucceeded("swarm tasks", swarmTasks);
	assertIncludes(swarmTasks.stdout, "task-1");

	const swarmDispatch = await runClanky([
		"swarm",
		"dispatch",
		"--home",
		homeDir,
		"--type",
		"research",
		"--provider",
		provider,
		"--model",
		model,
		"--files",
		"README.md,package.json",
		"--no-spawn",
		"--idempotency-key",
		"cli-gateway-no-spawn",
		"CLI gateway no-spawn dispatch",
	]);
	assertCommandSucceeded("swarm dispatch", swarmDispatch);
	assertIncludes(swarmDispatch.stdout, "ok: true");
	assertIncludes(swarmDispatch.stdout, "task_id: task-1");
	assertIncludes(swarmDispatch.stdout, "dispatch_status: no_worker");

	const swarmMessage = await runClanky([
		"swarm",
		"message",
		"--home",
		homeDir,
		"clanky-faux-worker",
		"CLI gateway peer message",
	]);
	assertCommandSucceeded("swarm message", swarmMessage);
	assertIncludes(swarmMessage.stdout, "ok: true");
	assertIncludes(swarmMessage.stdout, "recipient: clanky-faux-worker");

	const swarmComplete = await runClanky([
		"swarm",
		"complete",
		"--home",
		homeDir,
		"--description",
		"CLI gateway task complete.",
		"task-1",
	]);
	assertCommandSucceeded("swarm complete", swarmComplete);
	assertIncludes(swarmComplete.stdout, "ok: true");
	assertIncludes(swarmComplete.stdout, "task_id: task-1");

	const swarmLock = await runClanky(["swarm", "lock", "--home", homeDir, "locked-file.ts"]);
	if (swarmLock.code !== 1) {
		throw new Error(
			`swarm lock should exit with a blocked status\nstdout:\n${swarmLock.stdout}\nstderr:\n${swarmLock.stderr}`,
		);
	}
	assertIncludes(swarmLock.stdout, "blocked: true");
	assertIncludes(swarmLock.stdout, "owner_id: clanky-faux-worker");

	const send = await runClanky([
		"send",
		"--home",
		homeDir,
		"--provider",
		provider,
		"--model",
		model,
		"CLI gateway initial prompt",
	]);
	assertCommandSucceeded("send", send);

	const sessionList = await runClanky(["session", "list", "--home", homeDir]);
	assertCommandSucceeded("session list", sessionList);
	const sessionId = firstSessionId(sessionList.stdout);

	const sessionResume = await runClanky([
		"session",
		"resume",
		"--home",
		homeDir,
		"--provider",
		provider,
		"--model",
		model,
		sessionId,
		"CLI gateway resume prompt",
	]);
	assertCommandSucceeded("session resume", sessionResume);

	const tuiSession = await runClankyInteractive(["tui", "--home", homeDir, "--session", sessionId], "/exit\n");
	assertCommandSucceeded("tui --session", tuiSession);
	assertIncludes(tuiSession.stdout, `Clanky Chat (${sessionId})`);
	assertIncludes(tuiSession.stdout, "clanky> ");

	const httpSend = await runClanky([
		"send",
		"--home",
		homeDir,
		"--http",
		httpAddress,
		"--provider",
		provider,
		"--model",
		model,
		"CLI gateway HTTP prompt",
	]);
	assertCommandSucceeded("http send", httpSend);
	assertIncludes(httpSend.stdout, httpSendText);

	const sessionSearch = await runClanky(["session", "search", "--home", homeDir, "resume prompt"]);
	assertCommandSucceeded("session search", sessionSearch);
	assertIncludes(sessionSearch.stdout, sessionId);
	assertIncludes(sessionSearch.stdout, "resume prompt");

	const sessionFork = await runClanky(["session", "fork", "--home", homeDir, sessionId]);
	assertCommandSucceeded("session fork", sessionFork);
	assertIncludes(sessionFork.stdout, `parent_session: ${sessionId}`);
	assertIncludes(sessionFork.stdout, "session_file:");
	await waitForFauxCallCount(3);

	const skillSend = await runClanky([
		"send",
		"--home",
		homeDir,
		"--provider",
		provider,
		"--model",
		model,
		"--skill",
		"daily-digest",
		"CLI gateway skill prompt",
	]);
	assertCommandSucceeded("send --skill", skillSend);
	assertIncludes(skillSend.stdout, skillSendText);

	const skillUsage = await runClanky(["skill", "usage", "--home", homeDir]);
	assertCommandSucceeded("skill usage", skillUsage);
	assertIncludes(skillUsage.stdout, "daily-digest\t1\t");
	assertIncludes(skillUsage.stdout, "\tsession");

	const skillName = "release-notes";
	const skillAdd = await runClanky([
		"skill",
		"add",
		"--home",
		homeDir,
		"--description",
		"Use for release note drafting.",
		"--prompt",
		"Draft concise release notes.",
		skillName,
	]);
	assertCommandSucceeded("skill add", skillAdd);
	assertIncludes(skillAdd.stdout, `skill: ${skillName}`);

	const skillList = await runClanky(["skill", "list", "--home", homeDir]);
	assertCommandSucceeded("skill list", skillList);
	assertIncludes(skillList.stdout, `${skillName}\tUse for release note drafting.`);

	const skillRemove = await runClanky(["skill", "remove", "--home", homeDir, skillName]);
	assertCommandSucceeded("skill remove", skillRemove);
	assertIncludes(skillRemove.stdout, `removed: ${skillName}`);

	const skillListAfterRemove = await runClanky(["skill", "list", "--home", homeDir]);
	assertCommandSucceeded("skill list after remove", skillListAfterRemove);
	assertNotIncludes(skillListAfterRemove.stdout, `${skillName}\tUse for release note drafting.`);

	const memoryStatus = await runClanky(["memory", "status", "--home", homeDir]);
	assertCommandSucceeded("memory status", memoryStatus);
	assertIncludes(memoryStatus.stdout, "self_file:");
	assertIncludes(memoryStatus.stdout, "atoms: 0");
	const memoryConsent = await runClanky([
		"memory",
		"consent",
		"--home",
		homeDir,
		"--scope",
		"channel",
		"--subject",
		"cli-channel",
		"on",
	]);
	assertCommandSucceeded("memory consent", memoryConsent);
	assertIncludes(memoryConsent.stdout, `"enabled": true`);
	const memoryRemember = await runClanky([
		"memory",
		"remember",
		"--home",
		homeDir,
		"--scope",
		"project",
		"--subject",
		process.cwd(),
		"--type",
		"decision",
		"--confidence",
		"0.86",
		"CLI gateway memory smoke stores source-grounded decisions.",
	]);
	assertCommandSucceeded("memory remember", memoryRemember);
	assertIncludes(memoryRemember.stdout, "memory:");
	assertIncludes(memoryRemember.stdout, "type: decision");
	const memoryId = extractLineValue(memoryRemember.stdout, "memory");
	const memorySearch = await runClanky([
		"memory",
		"search",
		"--home",
		homeDir,
		"--scope",
		"project",
		"--subject",
		process.cwd(),
		"source-grounded decisions",
	]);
	assertCommandSucceeded("memory search", memorySearch);
	assertIncludes(memorySearch.stdout, memoryId);
	const memoryExport = await runClanky(["memory", "export", "--home", homeDir]);
	assertCommandSucceeded("memory export", memoryExport);
	assertIncludes(memoryExport.stdout, memoryId);
	assertIncludes(memoryExport.stdout, "Clanky Self");
	const memoryForget = await runClanky(["memory", "forget", "--home", homeDir, memoryId]);
	assertCommandSucceeded("memory forget", memoryForget);
	assertIncludes(memoryForget.stdout, "forgotten: 1");
	const memorySearchAfterForget = await runClanky([
		"memory",
		"search",
		"--home",
		homeDir,
		"--scope",
		"project",
		"--subject",
		process.cwd(),
		"source-grounded decisions",
	]);
	assertCommandSucceeded("memory search after forget", memorySearchAfterForget);
	assertNotIncludes(memorySearchAfterForget.stdout, memoryId);

	const taskAdd = await runClanky([
		"task",
		"add",
		"--home",
		homeDir,
		"--session",
		sessionId,
		"--linear-issue",
		"PROJ-TASK",
		"--status",
		"in_progress",
		"--priority",
		"high",
		"--description",
		"Created from CLI gateway smoke.",
		"CLI gateway local task",
	]);
	assertCommandSucceeded("task add", taskAdd);
	assertIncludes(taskAdd.stdout, "status: in_progress");
	assertIncludes(taskAdd.stdout, "priority: high");
	assertIncludes(taskAdd.stdout, `session: ${sessionId}`);
	assertIncludes(taskAdd.stdout, "linear: PROJ-TASK");
	const taskId = extractLineValue(taskAdd.stdout, "task");

	const taskList = await runClanky([
		"task",
		"list",
		"--home",
		homeDir,
		"--status",
		"in_progress",
		"--priority",
		"high",
		"--linear-issue",
		"PROJ-TASK",
		"--limit",
		"5",
	]);
	assertCommandSucceeded("task list", taskList);
	assertIncludes(taskList.stdout, taskId);
	assertIncludes(taskList.stdout, "in_progress\thigh");
	assertIncludes(taskList.stdout, `session:${sessionId}`);
	assertIncludes(taskList.stdout, "linear:PROJ-TASK");

	const taskUpdate = await runClanky([
		"task",
		"update",
		"--home",
		homeDir,
		"--status",
		"done",
		"--priority",
		"normal",
		taskId,
		"CLI gateway completed task",
	]);
	assertCommandSucceeded("task update", taskUpdate);
	assertIncludes(taskUpdate.stdout, `task: ${taskId}`);
	assertIncludes(taskUpdate.stdout, "status: done");
	assertIncludes(taskUpdate.stdout, "priority: normal");
	assertIncludes(taskUpdate.stdout, "title: CLI gateway completed task");

	const taskDoneList = await runClanky([
		"task",
		"list",
		"--home",
		homeDir,
		"--status",
		"done",
		"--priority",
		"normal",
		"--linear-issue",
		"PROJ-TASK",
	]);
	assertCommandSucceeded("task done list", taskDoneList);
	assertIncludes(taskDoneList.stdout, taskId);
	assertIncludes(taskDoneList.stdout, "done\tnormal");

	const taskOldStatusList = await runClanky([
		"task",
		"list",
		"--home",
		homeDir,
		"--status",
		"in_progress",
		"--priority",
		"high",
		"--linear-issue",
		"PROJ-TASK",
	]);
	assertCommandSucceeded("task old status list", taskOldStatusList);
	assertNotIncludes(taskOldStatusList.stdout, taskId);

	const cronAdd = await runClanky([
		"cron",
		"add",
		"--home",
		homeDir,
		"--cwd",
		process.cwd(),
		"--deliver",
		"stdout",
		"--skill",
		"daily-digest",
		"--provider",
		provider,
		"--model",
		model,
		"--idempotency-key",
		"cli-cron-smoke-1",
		"--timeout",
		"12",
		"2026-01-01T00:00:01.000Z",
		"CLI cron prompt",
	]);
	assertCommandSucceeded("cron add", cronAdd);
	const cronJobId = extractLineValue(cronAdd.stdout, "cron_job");
	const [createdCronJob] = (await server.cron.listJobs()).filter((job) => job.id === cronJobId);
	if (
		createdCronJob === undefined ||
		createdCronJob.deliver !== "stdout" ||
		createdCronJob.skill !== "daily-digest" ||
		createdCronJob.provider !== provider ||
		createdCronJob.model !== model ||
		createdCronJob.timeoutSeconds !== 12 ||
		createdCronJob.workdir !== process.cwd() ||
		createdCronJob.idempotencyKey !== "cli-cron-smoke-1"
	) {
		throw new Error(`CLI cron add did not persist expected options: ${JSON.stringify(createdCronJob)}`);
	}

	const cronList = await runClanky(["cron", "list", "--home", homeDir]);
	assertCommandSucceeded("cron list", cronList);
	assertIncludes(cronList.stdout, `${cronJobId}\tenabled`);
	assertIncludes(cronList.stdout, "CLI cron prompt");
	const statusAfterCronAdd = await runClanky(["status", "--home", homeDir]);
	assertCommandSucceeded("status after cron add", statusAfterCronAdd);
	assertIncludes(statusAfterCronAdd.stdout, "cron_jobs: 1");
	assertIncludes(statusAfterCronAdd.stdout, "enabled_cron_jobs: 1");

	const cronDisable = await runClanky(["cron", "disable", "--home", homeDir, cronJobId]);
	assertCommandSucceeded("cron disable", cronDisable);
	assertIncludes(cronDisable.stdout, `${cronJobId}\tdisabled`);
	const statusAfterCronDisable = await runClanky(["status", "--home", homeDir]);
	assertCommandSucceeded("status after cron disable", statusAfterCronDisable);
	assertIncludes(statusAfterCronDisable.stdout, "cron_jobs: 1");
	assertIncludes(statusAfterCronDisable.stdout, "enabled_cron_jobs: 0");

	const cronEnable = await runClanky(["cron", "enable", "--home", homeDir, cronJobId]);
	assertCommandSucceeded("cron enable", cronEnable);
	assertIncludes(cronEnable.stdout, `${cronJobId}\tenabled`);
	const statusAfterCronEnable = await runClanky(["status", "--home", homeDir]);
	assertCommandSucceeded("status after cron enable", statusAfterCronEnable);
	assertIncludes(statusAfterCronEnable.stdout, "cron_jobs: 1");
	assertIncludes(statusAfterCronEnable.stdout, "enabled_cron_jobs: 1");

	const cronRunNow = await runClanky(["cron", "run-now", "--home", homeDir, cronJobId]);
	assertCommandSucceeded("cron run-now", cronRunNow);
	assertIncludes(cronRunNow.stdout, cronRunText);
	const [ranCronJob] = (await server.cron.listJobs()).filter((job) => job.id === cronJobId);
	if (ranCronJob?.id !== cronJobId || ranCronJob.lastStatus !== "ok" || ranCronJob.lastOutputFile === undefined) {
		throw new Error(`CLI cron run-now did not persist stdout delivery metadata: ${JSON.stringify(ranCronJob)}`);
	}
	if ((await readFile(ranCronJob.lastOutputFile, "utf8")) !== cronRunText) {
		throw new Error("CLI cron run-now stdout delivery did not persist the model response output file");
	}

	const cronRemove = await runClanky(["cron", "rm", "--home", homeDir, cronJobId]);
	assertCommandSucceeded("cron rm", cronRemove);
	assertIncludes(cronRemove.stdout, "cron job removed");

	const cronListAfterRemove = await runClanky(["cron", "list", "--home", homeDir]);
	assertCommandSucceeded("cron list after remove", cronListAfterRemove);
	assertNotIncludes(cronListAfterRemove.stdout, cronJobId);
	const statusAfterCronRemove = await runClanky(["status", "--home", homeDir]);
	assertCommandSucceeded("status after cron remove", statusAfterCronRemove);
	assertIncludes(statusAfterCronRemove.stdout, "cron_jobs: 0");
	assertIncludes(statusAfterCronRemove.stdout, "enabled_cron_jobs: 0");

	const swarmCronAdd = await runClanky([
		"cron",
		"add",
		"--home",
		homeDir,
		"--deliver",
		"swarm:clanky-faux-worker",
		"every 1h",
		"CLI cron swarm delivery prompt",
	]);
	assertCommandSucceeded("cron add swarm delivery", swarmCronAdd);
	const swarmCronJobId = extractLineValue(swarmCronAdd.stdout, "cron_job");
	const linearCronAdd = await runClanky([
		"cron",
		"add",
		"--home",
		homeDir,
		"--deliver",
		"linear:PROJ-CRON",
		"every 1h",
		"CLI cron Linear delivery prompt",
	]);
	assertCommandSucceeded("cron add Linear delivery", linearCronAdd);
	const linearCronJobId = extractLineValue(linearCronAdd.stdout, "cron_job");
	const deliveryCronJobs = await server.cron.listJobs();
	const createdSwarmCronJob = deliveryCronJobs.find((job) => job.id === swarmCronJobId);
	const createdLinearCronJob = deliveryCronJobs.find((job) => job.id === linearCronJobId);
	if (
		createdSwarmCronJob === undefined ||
		createdSwarmCronJob.deliver !== "swarm:clanky-faux-worker" ||
		createdSwarmCronJob.schedule !== "every 1h"
	) {
		throw new Error(`CLI cron add did not persist swarm delivery: ${JSON.stringify(createdSwarmCronJob)}`);
	}
	if (
		createdLinearCronJob === undefined ||
		createdLinearCronJob.deliver !== "linear:PROJ-CRON" ||
		createdLinearCronJob.schedule !== "every 1h"
	) {
		throw new Error(`CLI cron add did not persist Linear delivery: ${JSON.stringify(createdLinearCronJob)}`);
	}
	const statusAfterDeliveryCronAdd = await runClanky(["status", "--home", homeDir]);
	assertCommandSucceeded("status after delivery cron add", statusAfterDeliveryCronAdd);
	assertIncludes(statusAfterDeliveryCronAdd.stdout, "cron_jobs: 2");
	assertIncludes(statusAfterDeliveryCronAdd.stdout, "enabled_cron_jobs: 2");
	const swarmCronRemove = await runClanky(["cron", "rm", "--home", homeDir, swarmCronJobId]);
	assertCommandSucceeded("cron rm swarm delivery", swarmCronRemove);
	const linearCronRemove = await runClanky(["cron", "rm", "--home", homeDir, linearCronJobId]);
	assertCommandSucceeded("cron rm Linear delivery", linearCronRemove);
	const statusAfterDeliveryCronRemove = await runClanky(["status", "--home", homeDir]);
	assertCommandSucceeded("status after delivery cron remove", statusAfterDeliveryCronRemove);
	assertIncludes(statusAfterDeliveryCronRemove.stdout, "cron_jobs: 0");
	assertIncludes(statusAfterDeliveryCronRemove.stdout, "enabled_cron_jobs: 0");

	process.env.LINEAR_API_KEY = "linear-key";
	process.env.LINEAR_GRAPHQL_ENDPOINT = linear.endpoint;
	const linearCreate = await runClanky([
		"linear",
		"create",
		"--home",
		homeDir,
		"--description",
		"Created from CLI gateway smoke",
		"team-cli",
		"Created through CLI smoke",
	]);
	assertCommandSucceeded("linear create", linearCreate);
	assertIncludes(linearCreate.stdout, "identifier: CLI-100");
	delete process.env.LINEAR_API_KEY;
	delete process.env.LINEAR_GRAPHQL_ENDPOINT;

	const linearLink = await runClanky([
		"linear",
		"link",
		"--home",
		homeDir,
		"--task",
		"task-cli",
		"--description",
		"linked from CLI smoke",
		"PROJ-789",
	]);
	assertCommandSucceeded("linear link", linearLink);
	assertIncludes(linearLink.stdout, "issue: PROJ-789");
	assertIncludes(linearLink.stdout, "task: task-cli");

	const linearList = await runClanky(["linear", "list", "--home", homeDir]);
	assertCommandSucceeded("linear list", linearList);
	assertIncludes(linearList.stdout, "PROJ-789\tsession:-\ttask:task-cli\tlinked from CLI smoke");

	const linearOutbox = await runClanky(["linear", "outbox", "--home", homeDir]);
	assertCommandSucceeded("linear outbox", linearOutbox);
	assertIncludes(linearOutbox.stdout, "No Linear outbox entries.");

	process.env.LINEAR_API_KEY = "linear-key";
	process.env.LINEAR_GRAPHQL_ENDPOINT = linear.endpoint;
	const linearFlush = await runClanky(["linear", "flush", "--home", homeDir]);
	assertCommandSucceeded("linear flush", linearFlush);
	assertIncludes(linearFlush.stdout, "posted: 0");
	assertIncludes(linearFlush.stdout, "failed: 0");
	delete process.env.LINEAR_API_KEY;
	delete process.env.LINEAR_GRAPHQL_ENDPOINT;

	const linkedStatus = await runClanky(["status", "--home", homeDir]);
	assertCommandSucceeded("linked status", linkedStatus);
	assertIncludes(
		linkedStatus.stdout,
		"warning: Linear links exist but LINEAR_API_KEY or LINEAR_ACCESS_TOKEN is not set",
	);

	const stop = await runClanky(["stop", "--home", homeDir]);
	assertCommandSucceeded("stop", stop);
	assertIncludes(stop.stdout, "clanky daemon stopped");
	await waitForClosed(server.closed);
	const swarmCalls = await readFile(swarmCallsFile, "utf8");
	assertIncludes(swarmCalls, "deregister");

	console.log(
		JSON.stringify({
			statusBytes: status.stdout.length,
			cronJobId,
			linearCreated: linear.requests.length,
			linearBytes: linearList.stdout.length,
			sessionId,
			stopped: true,
		}),
	);
} finally {
	await server.close();
	await linear.close();
	restoreEnv(previousEnv);
	await rm(homeDir, { force: true, recursive: true });
}

interface CommandResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

async function runClanky(args: string[]): Promise<CommandResult> {
	const child = spawn(process.execPath, ["--import", "tsx", "packages/clanky-cli/src/bin.ts", ...args], {
		cwd: process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString("utf8");
	});
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		child.kill("SIGTERM");
	}, 10_000);
	const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => {
			resolve({ code, signal });
		});
	});
	clearTimeout(timeout);
	if (timedOut) {
		throw new Error(`clanky ${args.join(" ")} timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`);
	}
	return { ...result, stdout, stderr };
}

async function runClankyInteractive(args: string[], input: string): Promise<CommandResult> {
	const child = spawn(process.execPath, ["--import", "tsx", "packages/clanky-cli/src/bin.ts", ...args], {
		cwd: process.cwd(),
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	let sentInput = false;
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString("utf8");
		if (!sentInput && stdout.includes("clanky> ")) {
			sentInput = true;
			child.stdin.write(input);
			child.stdin.end();
		}
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString("utf8");
	});
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		child.kill("SIGTERM");
	}, 10_000);
	const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => {
			resolve({ code, signal });
		});
	});
	clearTimeout(timeout);
	if (timedOut) {
		throw new Error(`interactive clanky ${args.join(" ")} timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`);
	}
	return { ...result, stdout, stderr };
}

function extractLineValue(output: string, key: string): string {
	for (const line of output.split("\n")) {
		const prefix = `${key}: `;
		if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
	}
	throw new Error(`Missing ${key} line in output:\n${output}`);
}

function assertIncludes(value: string, expected: string): void {
	if (!value.includes(expected)) throw new Error(`Missing expected output: ${expected}\nActual:\n${value}`);
}

function assertNotIncludes(value: string, unexpected: string): void {
	if (value.includes(unexpected)) throw new Error(`Unexpected output: ${unexpected}\nActual:\n${value}`);
}

function firstSessionId(output: string): string {
	for (const line of output.split("\n")) {
		if (line.trim().length === 0) continue;
		const [firstColumn] = line.split("\t");
		if (firstColumn !== undefined && firstColumn.length > 0) return firstColumn;
	}
	throw new Error(`Missing session row\nActual:\n${output}`);
}

async function waitForFauxCallCount(expected: number): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (fauxState.callCount >= expected) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`Expected at least ${expected} faux model calls, got ${fauxState.callCount}`);
}

function createFauxStream(streamModel: Model<Api>, state: { callCount: number; responses: string[] }) {
	const text = state.responses[state.callCount] ?? "Unexpected extra CLI gateway faux response.";
	state.callCount += 1;
	const message = createAssistantMessage(streamModel, text);
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

function createAssistantMessage(streamModel: Model<Api>, text: string): AssistantMessage {
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
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function assertCommandSucceeded(label: string, result: CommandResult): void {
	if (result.code === 0) return;
	throw new Error(`${label} failed with ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

async function waitForClosed(closed: Promise<void>): Promise<void> {
	await Promise.race([
		closed,
		new Promise<never>((_resolve, reject) => {
			setTimeout(() => {
				reject(new Error("Timed out waiting for daemon to stop"));
			}, 5000);
		}),
	]);
}

function captureEnv(...keys: string[]): Map<string, string | undefined> {
	const values = new Map<string, string | undefined>();
	for (const key of keys) values.set(key, process.env[key]);
	return values;
}

interface LinearRequest {
	body: string;
}

interface LinearServer {
	endpoint: string;
	requests: LinearRequest[];
	close(): Promise<void>;
}

async function startLinearServer(expectedTeamId: string): Promise<LinearServer> {
	const requests: LinearRequest[] = [];
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk.toString("utf8");
		requests.push({ body });
		const input = requestInput(body);
		if (input.teamId !== expectedTeamId || input.title !== "Created through CLI smoke") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ errors: [{ message: `unexpected input ${JSON.stringify(input)}` }] }));
			return;
		}
		response.writeHead(200, { "content-type": "application/json" });
		response.end(
			JSON.stringify({
				data: {
					issueCreate: {
						success: true,
						issue: {
							id: "issue-cli",
							identifier: "CLI-100",
							title: input.title,
							url: "https://linear.example/CLI-100",
							team: {
								id: input.teamId,
							},
						},
					},
				},
			}),
		);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (typeof address !== "object" || address === null) throw new Error("Could not bind Linear CLI smoke server");
	return {
		endpoint: `http://127.0.0.1:${address.port}/graphql`,
		requests,
		close: async () => {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
				});
			});
		},
	};
}

async function freeTcpPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	await new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		});
	});
	if (typeof address !== "object" || address === null) throw new Error("Could not allocate HTTP smoke port");
	return address.port;
}

function requestInput(body: string): Record<string, unknown> {
	const parsed = JSON.parse(body) as unknown;
	const variables = recordProperty(parsed, "variables");
	const input = recordProperty(variables, "input");
	return input;
}

function recordProperty(value: unknown, key: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`Expected object with ${key}: ${JSON.stringify(value)}`);
	}
	const item = (value as Record<string, unknown>)[key];
	if (typeof item !== "object" || item === null || Array.isArray(item)) {
		throw new Error(`Expected ${key} object: ${JSON.stringify(value)}`);
	}
	return item as Record<string, unknown>;
}

function restoreEnv(values: Map<string, string | undefined>): void {
	for (const [key, value] of values) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}
