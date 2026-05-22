import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRegistry } from "@clanky/core";

const homeDir = await mkdtemp(join(tmpdir(), "clanky-linear-"));
const registry = new SessionRegistry({ homeDir });
let calls = 0;

try {
	await registry.start();
	const createdIssue = await registry.createLinearIssue(
		{
			teamId: "team-linear",
			title: "Created from Linear smoke",
			description: "Exercise Linear issue creation.",
			priority: 2,
			labelIds: ["label-a"],
		},
		{
			apiKey: "linear-key",
			endpoint: "https://linear.example/graphql",
			fetchFn: linearFetch("ok"),
		},
	);
	if (
		createdIssue.issueId !== "issue-created" ||
		createdIssue.identifier !== "PROJ-100" ||
		createdIssue.teamId !== "team-linear"
	) {
		throw new Error(`Linear issue creation returned unexpected payload: ${JSON.stringify(createdIssue)}`);
	}

	const first = await registry.addLinearOutboxEntry({
		issueId: "PROJ-1",
		body: "First comment",
		sessionId: "session-1",
	});
	const second = await registry.addLinearOutboxEntry({
		issueId: "PROJ-2",
		body: "Second comment",
		taskId: "task-2",
	});

	const firstFlush = await registry.flushLinearOutbox({
		apiKey: "linear-key",
		endpoint: "https://linear.example/graphql",
		fetchFn: linearFetch("ok"),
		limit: 1,
	});
	const postedEntry = firstFlush.posted[0];
	if (firstFlush.posted.length !== 1 || firstFlush.failed.length !== 0 || postedEntry === undefined) {
		throw new Error("Linear outbox limit flush did not post exactly one pending entry");
	}

	const afterFirstFlush = await registry.listLinearOutbox();
	if (afterFirstFlush.find((entry) => entry.id === postedEntry.id)?.status !== "posted") {
		throw new Error("Flushed Linear outbox entry was not marked posted");
	}
	const remainingEntry = [first, second].find((entry) => entry.id !== postedEntry.id);
	if (
		remainingEntry === undefined ||
		afterFirstFlush.find((entry) => entry.id === remainingEntry.id)?.status !== "pending"
	) {
		throw new Error("Unflushed Linear outbox entry should have remained pending");
	}

	const secondFlush = await registry.flushLinearOutbox({
		apiKey: "linear-key",
		endpoint: "https://linear.example/graphql",
		fetchFn: linearFetch("ok"),
		entryIds: [remainingEntry.id],
	});
	if (secondFlush.posted.length !== 1 || secondFlush.posted[0]?.id !== remainingEntry.id) {
		throw new Error("Linear outbox entryIds flush did not post the selected entry");
	}

	const failing = await registry.addLinearOutboxEntry({
		issueId: "PROJ-3",
		body: "Failing comment",
	});
	const failedFlush = await registry.flushLinearOutbox({
		apiKey: "linear-key",
		endpoint: "https://linear.example/graphql",
		fetchFn: linearFetch("error"),
		entryIds: [failing.id],
	});
	if (failedFlush.failed.length !== 1 || failedFlush.failed[0]?.status !== "error") {
		throw new Error("Linear outbox GraphQL error was not recorded as an entry error");
	}

	console.log(
		JSON.stringify({
			created: createdIssue.identifier,
			posted: firstFlush.posted.length + secondFlush.posted.length,
			failed: failedFlush.failed.length,
		}),
	);
} finally {
	await registry.dispose();
	await rm(homeDir, { force: true, recursive: true });
}

function linearFetch(mode: "ok" | "error"): typeof fetch {
	return async (_input, init) => {
		calls += 1;
		if (mode === "error") {
			return new Response(JSON.stringify({ errors: [{ message: "synthetic failure" }] }), { status: 200 });
		}
		if (requestQuery(init).includes("issueCreate")) {
			const input = requestVariablesInput(init);
			if (
				input.teamId !== "team-linear" ||
				input.title !== "Created from Linear smoke" ||
				input.description !== "Exercise Linear issue creation." ||
				input.priority !== 2 ||
				!Array.isArray(input.labelIds)
			) {
				throw new Error(`Linear issueCreate request included unexpected input: ${JSON.stringify(input)}`);
			}
			return new Response(
				JSON.stringify({
					data: {
						issueCreate: {
							success: true,
							issue: {
								id: "issue-created",
								identifier: "PROJ-100",
								title: "Created from Linear smoke",
								url: "https://linear.example/PROJ-100",
								team: {
									id: input.teamId,
								},
							},
						},
					},
				}),
				{ status: 200 },
			);
		}
		const issueId = requestIssueId(init);
		return new Response(
			JSON.stringify({
				data: {
					commentCreate: {
						success: true,
						comment: {
							id: `comment-${calls}`,
							url: `https://linear.example/comment-${calls}`,
							issue: {
								id: issueId,
								identifier: issueId,
							},
						},
					},
				},
			}),
			{ status: 200 },
		);
	};
}

function requestIssueId(init: RequestInit | undefined): string {
	const input = requestVariablesInput(init);
	const issueId = input.issueId;
	if (typeof issueId !== "string") throw new Error("Linear request did not include issueId");
	return issueId;
}

function requestQuery(init: RequestInit | undefined): string {
	const body = typeof init?.body === "string" ? init.body : "";
	const parsed = JSON.parse(body) as unknown;
	const query = property(parsed, "query");
	if (typeof query !== "string") throw new Error("Linear request did not include query");
	return query;
}

function requestVariablesInput(init: RequestInit | undefined): Record<string, unknown> {
	const body = typeof init?.body === "string" ? init.body : "";
	const parsed = JSON.parse(body) as unknown;
	const variables = property(parsed, "variables");
	const input = property(variables, "input");
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new Error("Linear request did not include input variables");
	}
	return input as Record<string, unknown>;
}

function property(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return (value as Record<string, unknown>)[key];
}
