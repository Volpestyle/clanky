import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestGateway, startGatewayServer } from "@clanky/gateway";

const homeDir = await mkdtemp(join(tmpdir(), "clanky-profile-daemons-"));
const work = await startGatewayServer({ homeDir, profile: "work" });
await new Promise((resolve) => setTimeout(resolve, 250));
const personal = await startGatewayServer({ homeDir, profile: "personal" });

try {
	if (work.socketFile === personal.socketFile) throw new Error("Profile daemons shared a socket file");
	if (work.registry.paths.daemonLockFile === personal.registry.paths.daemonLockFile) {
		throw new Error("Profile daemons shared a lock file");
	}

	const workStatus = await gatewayRecord(work.socketFile, "status");
	const personalStatus = await gatewayRecord(personal.socketFile, "status");
	if (workStatus.profile !== "work" || personalStatus.profile !== "personal") {
		throw new Error(`Profile daemon status mismatch: ${JSON.stringify({ workStatus, personalStatus })}`);
	}
	const workUptimeMs = numberProperty(workStatus, "uptimeMs");
	const personalUptimeMs = numberProperty(personalStatus, "uptimeMs");
	if (workUptimeMs - personalUptimeMs < 150) {
		throw new Error(
			`Profile daemon uptime should be measured per gateway instance: ${JSON.stringify({ workUptimeMs, personalUptimeMs })}`,
		);
	}

	const workSession = await work.registry.createSession();
	await requestGateway({
		socketFile: work.socketFile,
		method: "linear.link",
		params: {
			issueId: "WORK-123",
			taskId: "task-work",
			note: "work profile only",
		},
	});
	await requestGateway({
		socketFile: personal.socketFile,
		method: "cron.add",
		params: {
			schedule: "2026-01-01T00:00:01.000Z",
			prompt: "Personal cron prompt",
			deliver: "stdout",
			idempotencyKey: "personal-cron-profile-daemon-smoke",
		},
	});
	const workTask = await requestGateway({
		socketFile: work.socketFile,
		method: "task.add",
		params: {
			title: "Work profile daemon task",
			linearIssue: "WORK-123",
			source: "profile-daemons-smoke",
		},
	});
	if (!isRecord(workTask) || !isRecord(workTask.task) || typeof workTask.task.id !== "string") {
		throw new Error(`Work task add returned unexpected payload: ${JSON.stringify(workTask)}`);
	}
	await requestGateway({
		socketFile: personal.socketFile,
		method: "task.add",
		params: {
			title: "Personal profile daemon task",
			linearIssue: "PERS-123",
			source: "profile-daemons-smoke",
		},
	});

	const workSessions = arrayProperty(await gatewayRecord(work.socketFile, "session.list"), "sessions");
	const personalSessions = arrayProperty(await gatewayRecord(personal.socketFile, "session.list"), "sessions");
	if (!hasRecordWith(workSessions, "id", workSession.id)) {
		throw new Error(`Work profile session missing from work daemon: ${JSON.stringify(workSessions)}`);
	}
	if (hasRecordWith(personalSessions, "id", workSession.id)) {
		throw new Error(`Work profile session leaked into personal daemon: ${JSON.stringify(personalSessions)}`);
	}

	const workLinks = arrayProperty(await gatewayRecord(work.socketFile, "linear.list"), "links");
	const personalLinks = arrayProperty(await gatewayRecord(personal.socketFile, "linear.list"), "links");
	if (!hasRecordWith(workLinks, "issueId", "WORK-123")) {
		throw new Error(`Work Linear link missing from work daemon: ${JSON.stringify(workLinks)}`);
	}
	if (personalLinks.length !== 0) {
		throw new Error(`Work Linear link leaked into personal daemon: ${JSON.stringify(personalLinks)}`);
	}

	const workCron = arrayProperty(await gatewayRecord(work.socketFile, "cron.list"), "jobs");
	const personalCron = arrayProperty(await gatewayRecord(personal.socketFile, "cron.list"), "jobs");
	if (workCron.length !== 0) {
		throw new Error(`Personal cron job leaked into work daemon: ${JSON.stringify(workCron)}`);
	}
	if (!hasRecordWith(personalCron, "prompt", "Personal cron prompt")) {
		throw new Error(`Personal cron job missing from personal daemon: ${JSON.stringify(personalCron)}`);
	}

	const workTasks = arrayProperty(await gatewayRecord(work.socketFile, "task.list"), "tasks");
	const personalTasks = arrayProperty(await gatewayRecord(personal.socketFile, "task.list"), "tasks");
	if (!hasRecordWith(workTasks, "title", "Work profile daemon task")) {
		throw new Error(`Work task missing from work daemon: ${JSON.stringify(workTasks)}`);
	}
	if (hasRecordWith(workTasks, "title", "Personal profile daemon task")) {
		throw new Error(`Personal task leaked into work daemon: ${JSON.stringify(workTasks)}`);
	}
	if (!hasRecordWith(personalTasks, "title", "Personal profile daemon task")) {
		throw new Error(`Personal task missing from personal daemon: ${JSON.stringify(personalTasks)}`);
	}
	if (hasRecordWith(personalTasks, "title", "Work profile daemon task")) {
		throw new Error(`Work task leaked into personal daemon: ${JSON.stringify(personalTasks)}`);
	}

	console.log(
		JSON.stringify({
			homeDir,
			workSession: workSession.id,
			workLinks: workLinks.length,
			workTasks: workTasks.length,
			personalCron: personalCron.length,
		}),
	);
} finally {
	await personal.close();
	await work.close();
	await rm(homeDir, { force: true, recursive: true });
}

async function gatewayRecord(socketFile: string, method: Parameters<typeof requestGateway>[0]["method"]) {
	const result = await requestGateway({ socketFile, method });
	if (!isRecord(result)) throw new Error(`Expected object response for ${method}: ${JSON.stringify(result)}`);
	return result;
}

function arrayProperty(value: Record<string, unknown>, key: string): unknown[] {
	const item = value[key];
	if (!Array.isArray(item)) throw new Error(`Expected ${key} array: ${JSON.stringify(value)}`);
	return item;
}

function hasRecordWith(items: unknown[], key: string, value: unknown): boolean {
	return items.some((item) => isRecord(item) && item[key] === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberProperty(value: Record<string, unknown>, key: string): number {
	const item = value[key];
	if (typeof item !== "number" || !Number.isFinite(item)) {
		throw new Error(`Expected numeric ${key}: ${JSON.stringify(value)}`);
	}
	return item;
}
