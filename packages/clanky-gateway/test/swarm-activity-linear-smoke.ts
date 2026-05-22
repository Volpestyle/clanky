import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRegistry } from "@clanky/core";
import type { SwarmLeaderEvent } from "@clanky/swarm";
import { mirrorSwarmActivityToLinear } from "../src/operations.ts";

const homeDir = await mkdtemp(join(tmpdir(), "clanky-swarm-activity-linear-"));
const registry = new SessionRegistry({ homeDir, watchSkills: false });

try {
	await registry.start();
	const sessionId = "019e5f8f-8358-7c8d-9b42-3bd93600f1a0";
	const timestamp = "2026-05-20T12:00:00.000Z";
	const sessionFile = join(registry.paths.sessionsDir, `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
	await mkdir(registry.paths.sessionsDir, { recursive: true, mode: 0o700 });
	await writeFile(sessionFile, persistedSessionFixture(sessionId, timestamp), { mode: 0o600 });
	await registry.linkLinearIssue({
		issueId: "PROJ-ACTIVITY",
		taskId: "task-activity",
		sessionId,
		note: "linked from swarm activity smoke",
	});

	const event: SwarmLeaderEvent = {
		type: "swarm.activity",
		changes: ["task_updates"],
		activity: {
			tasks: {
				done: [
					{
						id: "task-activity",
						title: "Activity task",
						result: {
							summary: "Activity task completed through the poller.",
							files_changed: ["README.md"],
							tests: [{ command: "pnpm check", status: "passed" }],
							followups: ["Run the live Linear gate."],
						},
					},
				],
			},
		},
	};

	const mirrored = await mirrorSwarmActivityToLinear(registry, event);
	const [entry] = mirrored.entries;
	if (entry === undefined || entry.issueId !== "PROJ-ACTIVITY" || entry.taskId !== "task-activity") {
		throw new Error(`Swarm activity did not create the expected Linear outbox entry: ${JSON.stringify(mirrored)}`);
	}
	if (
		!entry.body.includes("Activity task completed through the poller.") ||
		!entry.body.includes("- README.md") ||
		!entry.body.includes("- passed pnpm check") ||
		!entry.body.includes("- Run the live Linear gate.")
	) {
		throw new Error(`Swarm activity Linear body omitted structured task details: ${entry.body}`);
	}
	const sessionJsonl = await readFile(sessionFile, "utf8");
	if (
		!sessionJsonl.includes("clanky.swarm_completion") ||
		!sessionJsonl.includes("task-activity") ||
		!sessionJsonl.includes("Activity task completed through the poller.")
	) {
		throw new Error(`Swarm activity did not notify the linked session: ${sessionJsonl}`);
	}

	const duplicate = await mirrorSwarmActivityToLinear(registry, event);
	if (duplicate.entries.length !== 0) {
		throw new Error(`Swarm activity Linear mirror was not idempotent: ${JSON.stringify(duplicate)}`);
	}
	const duplicateSessionJsonl = await readFile(sessionFile, "utf8");
	const notificationCount = duplicateSessionJsonl.split("clanky.swarm_completion").length - 1;
	if (notificationCount !== 1) {
		throw new Error(`Swarm activity session notification was not idempotent: ${duplicateSessionJsonl}`);
	}

	const messageEvent: SwarmLeaderEvent = {
		type: "swarm.activity",
		changes: ["new_messages"],
		activity: {
			messages: [
				{
					id: 1001,
					sender: "worker-direct",
					content: `[session:${sessionId}] Direct session note from swarm.`,
					created_at: 1_769_169_610,
				},
				{
					id: 1002,
					sender: "worker-task",
					content: "[task:task-activity] Task-linked note from swarm.",
					created_at: 1_769_169_611,
				},
			],
		},
	};
	const routedMessages = await mirrorSwarmActivityToLinear(registry, messageEvent);
	if (routedMessages.sessionMessages !== 2) {
		throw new Error(
			`Swarm activity did not route addressed messages into the session: ${JSON.stringify(routedMessages)}`,
		);
	}
	const sessionWithMessagesJsonl = await readFile(sessionFile, "utf8");
	if (
		!sessionWithMessagesJsonl.includes("clanky.swarm_message") ||
		!sessionWithMessagesJsonl.includes("Swarm message from worker-direct") ||
		!sessionWithMessagesJsonl.includes("Direct session note from swarm.") ||
		!sessionWithMessagesJsonl.includes("Swarm message from worker-task for task task-activity") ||
		!sessionWithMessagesJsonl.includes("Task-linked note from swarm.")
	) {
		throw new Error(`Swarm messages were not persisted as session user messages: ${sessionWithMessagesJsonl}`);
	}
	const searchResults = await registry.searchSessions({ query: "Task-linked note" });
	if (!searchResults.some((result) => result.sessionId === sessionId && result.text.includes("Task-linked note"))) {
		throw new Error(`Swarm session message was not indexed for search: ${JSON.stringify(searchResults)}`);
	}

	const duplicateMessages = await mirrorSwarmActivityToLinear(registry, messageEvent);
	if (duplicateMessages.sessionMessages !== undefined) {
		throw new Error(`Swarm session message routing was not idempotent: ${JSON.stringify(duplicateMessages)}`);
	}
	const duplicateMessageSessionJsonl = await readFile(sessionFile, "utf8");
	const swarmMessageCount = duplicateMessageSessionJsonl.split("clanky.swarm_message").length - 1;
	if (swarmMessageCount !== 2) {
		throw new Error(`Swarm session message markers were not idempotent: ${duplicateMessageSessionJsonl}`);
	}

	console.log(
		JSON.stringify({
			entries: mirrored.entries.length,
			duplicateEntries: duplicate.entries.length,
			sessionNotifications: notificationCount,
			sessionMessages: routedMessages.sessionMessages,
		}),
	);
} finally {
	await registry.dispose();
	await rm(homeDir, { force: true, recursive: true });
}

function persistedSessionFixture(sessionId: string, timestamp: string): string {
	return `${JSON.stringify({
		type: "session",
		version: 3,
		id: sessionId,
		timestamp,
		cwd: process.cwd(),
	})}
${JSON.stringify({
	type: "message",
	id: "00000001",
	parentId: null,
	timestamp,
	message: {
		role: "user",
		content: "Please dispatch the activity task.",
		timestamp: Date.parse(timestamp),
	},
})}
${JSON.stringify({
	type: "message",
	id: "00000002",
	parentId: "00000001",
	timestamp,
	message: {
		role: "assistant",
		content: [{ type: "text", text: "Dispatched task-activity." }],
		api: "clanky-test-api",
		provider: "clanky-test",
		model: "clanky-test-model",
		stopReason: "stop",
		timestamp: Date.parse(timestamp),
	},
})}
`;
}
