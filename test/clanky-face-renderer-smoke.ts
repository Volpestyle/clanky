import type { HandleMessageStreamEvent } from "eve/client";
import {
	ClankyFaceRenderer,
	formatContextUsage,
	formatTokenFlow,
	type FaceBlockOptions,
	type FaceBlockHandle,
	type FaceRenderSink,
} from "../agent/lib/clanky-face-renderer.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

class CapturedBlock implements FaceBlockHandle {
	markdown: string;
	readonly options: FaceBlockOptions | undefined;

	constructor(markdown: string, options?: FaceBlockOptions) {
		this.markdown = markdown;
		this.options = options;
	}

	setMarkdown(markdown: string): void {
		this.markdown = markdown;
	}
}

const blocks: CapturedBlock[] = [];
const statuses: string[] = [];
const loaderMessages: string[] = [];
const sink: FaceRenderSink = {
	insertMarkdown(markdown: string, options?: FaceBlockOptions): FaceBlockHandle {
		const block = new CapturedBlock(markdown, options);
		blocks.push(block);
		return block;
	},
	setLoaderMessage(message: string): void {
		loaderMessages.push(message);
	},
	setStatus(message: string): void {
		statuses.push(message);
	},
};

const renderer = new ClankyFaceRenderer(sink);
assert(formatContextUsage(renderer.lastUsage, 100_000) === "ctx 0%", "initial context usage should show zero percent");
assert(formatContextUsage(renderer.lastUsage, undefined) === "", "context usage should stay hidden without a context window");
assert(formatTokenFlow(renderer.lastUsage, 100_000) === "", "token flow should stay hidden before usage exists");
const events: HandleMessageStreamEvent[] = [
	{ type: "turn.started", data: { sequence: 1, turnId: "turn-1" } },
	{ type: "step.started", data: { sequence: 2, stepIndex: 0, turnId: "turn-1" } },
	{
		type: "message.appended",
		data: { messageDelta: "Hel", messageSoFar: "Hel", sequence: 3, stepIndex: 0, turnId: "turn-1" },
	},
	{
		type: "reasoning.appended",
		data: {
			reasoningDelta: "Need a tool.",
			reasoningSoFar: "Need a tool.",
			sequence: 4,
			stepIndex: 0,
			turnId: "turn-1",
		},
	},
	{
		type: "message.appended",
		data: { messageDelta: "lo", messageSoFar: "Hello", sequence: 5, stepIndex: 0, turnId: "turn-1" },
	},
	{
		type: "message.appended",
		data: { messageDelta: "Hello", messageSoFar: "Hello", sequence: 6, stepIndex: 0, turnId: "turn-1" },
	},
	{
		type: "actions.requested",
		data: {
			actions: [{ callId: "call-1", input: { command: "printf ok" }, kind: "tool-call", toolName: "bash" }],
			sequence: 7,
			stepIndex: 0,
			turnId: "turn-1",
		},
	},
	{
		type: "action.result",
		data: {
			result: { callId: "call-1", isError: false, kind: "tool-result", output: { stdout: "ok" }, toolName: "bash" },
			sequence: 8,
			status: "completed",
			stepIndex: 0,
			turnId: "turn-1",
		},
	},
	{
		type: "input.requested",
		data: {
			requests: [
				{
					action: { callId: "call-2", input: {}, kind: "tool-call", toolName: "ask_question" },
					display: "select",
					options: [
						{ id: "continue", label: "Continue" },
						{ id: "stop", label: "Stop" },
					],
					prompt: "Continue?",
					requestId: "input-1",
				},
			],
			sequence: 9,
			stepIndex: 0,
			turnId: "turn-1",
		},
	},
	{
		type: "result.completed",
		data: { result: { answer: 42 }, sequence: 10, stepIndex: 0, turnId: "turn-1" },
	},
	{
		type: "step.completed",
		data: {
			finishReason: "tool-calls",
			sequence: 11,
			stepIndex: 0,
			turnId: "turn-1",
			usage: { inputTokens: 12_345, outputTokens: 67 },
		},
	},
	{ type: "session.waiting", data: { wait: "next-user-message" } },
];

let inputRequestCount = 0;
let terminal = false;
for (const event of events) {
	const result = renderer.renderEvent(event);
	inputRequestCount += result.inputRequests.length;
	terminal = terminal || result.terminal;
}

assert(blocks.some((block) => block.markdown === "**Clanky**\n\nHello"), "assistant stream should render once with replay deduped");
assert(!blocks.some((block) => block.markdown.includes("HelloHello")), "replayed assistant prefix should not duplicate text");
assert(blocks.some((block) => block.markdown.includes("**Reasoning**") && block.markdown.includes("Need a tool.")), "reasoning block should render");
const completedToolBlock = blocks.find((block) => block.markdown.includes("**Tool: bash - completed**"));
assert(completedToolBlock !== undefined, "tool block should exist after completion");
assert(completedToolBlock.markdown.includes("-> ok"), "tool block should update with compact result");
assert(completedToolBlock.options?.collapsed === true, "tool blocks should start collapsed");
assert(completedToolBlock.options?.clickToggle === true, "tool blocks should opt into click expand/collapse");
assert(completedToolBlock.markdown.includes("input:"), "expanded tool detail should include the request input");
assert(completedToolBlock.markdown.includes('"command": "printf ok"'), "expanded tool detail should show the request JSON");
assert(completedToolBlock.markdown.includes("output:"), "expanded tool detail should include the result output");
assert(completedToolBlock.markdown.includes('"stdout": "ok"'), "expanded tool detail should show the result JSON");
assert(!blocks.some((block) => block.markdown.includes("**Actions requested**")), "tool requests should not render as raw request batches");
assert(blocks.some((block) => block.markdown.includes("**Input requested**") && block.markdown.includes("Continue?")), "input request block should render");
const questionBlock = blocks.find((block) => block.markdown.includes("**Input requested**") && block.markdown.includes("input-1"));
assert(questionBlock !== undefined, "input request should have a stable block");
renderer.recordInputResponses([{ requestId: "input-1", optionId: "continue" }]);
assert(questionBlock.markdown.includes("**Input answered**"), "input response should update the request block in place");
assert(questionBlock.markdown.includes("answer: continue"), "input response block should show the selected answer");
assert(!blocks.some((block) => block.markdown.includes("**Input responses**")), "input answers should not render as a separate response dump");
assert(blocks.some((block) => block.markdown.includes("**Result completed**") && block.markdown.includes("\"answer\": 42")), "structured result block should render");
assert(inputRequestCount === 1, "input.requested should be surfaced to the caller");
assert(terminal, "session.waiting should be a terminal boundary for the current stream pass");
assert(statuses.includes("streaming"), "renderer should show streaming while a turn is active");
assert(statuses.includes("ready"), "renderer should return to ready when waiting for the next message");
assert(!statuses.includes("step 1"), "renderer status should not expose step numbers");
assert(!statuses.includes("step 1 completed"), "renderer status should not expose completed step numbers");
assert(loaderMessages.includes("Step 1 running..."), "step start should update loader message");
assert(formatTokenFlow(renderer.lastUsage, 100_000) === "↑ 12K ↓ 67 ctx 12%", "token flow should include context percent");
assert(formatContextUsage(renderer.lastUsage, 100_000) === "↑ 12K ↓ 67 ctx 12%", "context usage should include token flow after usage");
assert(renderer.noticeForCompletedTurn("no-reply") === undefined, "assistant text should suppress no-reply notice");

const skillBlocks: CapturedBlock[] = [];
const skillRenderer = new ClankyFaceRenderer({
	insertMarkdown(markdown: string): FaceBlockHandle {
		const block = new CapturedBlock(markdown);
		skillBlocks.push(block);
		return block;
	},
	setLoaderMessage(): void {},
	setStatus(): void {},
});
skillRenderer.renderEvent({
	type: "actions.requested",
	data: {
		actions: [{ callId: "skill-call", input: { skill: "herdr" }, kind: "load-skill" }],
		sequence: 1,
		stepIndex: 0,
		turnId: "turn-skill",
	},
});
const skillBlock = skillBlocks.find((block) => block.markdown.includes("**Skill: herdr - running**"));
assert(skillBlock !== undefined, "load-skill request should render a Skill block with the requested skill name");
skillRenderer.renderEvent({
	type: "action.result",
	data: {
		result: { callId: "skill-call", isError: false, kind: "load-skill-result", output: { text: "# Herdr Host Control" } },
		sequence: 2,
		status: "completed",
		stepIndex: 0,
		turnId: "turn-skill",
	},
});
assert(skillBlock.markdown.includes("**Skill: herdr - completed**"), "load-skill result should preserve the requested skill name when Eve omits result.name");
assert(!skillBlock.markdown.includes("load_skill"), "load-skill lifecycle should not fall back to the generic load_skill label when the request named a skill");

const frameworkSkillBlocks: CapturedBlock[] = [];
const frameworkSkillRenderer = new ClankyFaceRenderer({
	insertMarkdown(markdown: string): FaceBlockHandle {
		const block = new CapturedBlock(markdown);
		frameworkSkillBlocks.push(block);
		return block;
	},
	setLoaderMessage(): void {},
	setStatus(): void {},
});
frameworkSkillRenderer.renderEvent({
	type: "actions.requested",
	data: {
		actions: [{ callId: "framework-skill-call", input: { skill: "herdr" }, kind: "tool-call", toolName: "load_skill" }],
		sequence: 1,
		stepIndex: 0,
		turnId: "turn-framework-skill",
	},
});
const frameworkSkillBlock = frameworkSkillBlocks.find((block) => block.markdown.includes("**Skill: herdr - running**"));
assert(frameworkSkillBlock !== undefined, "framework load_skill tool-call should render a Skill block with the requested skill name");
frameworkSkillRenderer.renderEvent({
	type: "action.result",
	data: {
		result: { callId: "framework-skill-call", isError: false, kind: "tool-result", output: "# Herdr Host Control", toolName: "load_skill" },
		sequence: 2,
		status: "completed",
		stepIndex: 0,
		turnId: "turn-framework-skill",
	},
});
assert(frameworkSkillBlock.markdown.includes("**Skill: herdr - completed**"), "framework load_skill result should preserve the requested skill name");
assert(!frameworkSkillBlock.markdown.includes("load_skill"), "framework load_skill lifecycle should not render the generic tool name when the request named a skill");

renderer.resetSession();
assert(formatContextUsage(renderer.lastUsage, 100_000) === "ctx 0%", "new session should reset context usage to zero percent");
renderer.renderEvent({ type: "step.started", data: { sequence: 1, stepIndex: 0, turnId: "turn-empty" } });
renderer.renderEvent({
	type: "step.completed",
	data: { finishReason: "stop", sequence: 2, stepIndex: 0, turnId: "turn-empty", usage: { inputTokens: 9, outputTokens: 0 } },
});
renderer.renderEvent({ type: "turn.completed", data: { sequence: 3, turnId: "turn-empty" } });
const notice = renderer.noticeForCompletedTurn("no-reply") ?? "";
assert(notice.includes("No assistant reply was produced for that turn."), "empty completed turn should render no-reply notice");
assert(notice.includes("assistant 0 chars"), "no-reply trace should include assistant text count");

const chronologyBlocks: CapturedBlock[] = [];
const chronologyRenderer = new ClankyFaceRenderer({
	insertMarkdown(markdown: string): FaceBlockHandle {
		const block = new CapturedBlock(markdown);
		chronologyBlocks.push(block);
		return block;
	},
	setLoaderMessage(): void {},
	setStatus(): void {},
});

const longJsonValue = "x".repeat(140);
const multiStepEvents: HandleMessageStreamEvent[] = [
	{ type: "turn.started", data: { sequence: 1, turnId: "turn-multi" } },
	{ type: "step.started", data: { sequence: 2, stepIndex: 0, turnId: "turn-multi" } },
	{
		type: "message.appended",
		data: { messageDelta: "First step answer.", messageSoFar: "First step answer.", sequence: 3, stepIndex: 0, turnId: "turn-multi" },
	},
	{
		type: "actions.requested",
		data: {
			actions: [{ callId: "call-multi", input: { command: `printf ${longJsonValue}` }, kind: "tool-call", toolName: "bash" }],
			sequence: 4,
			stepIndex: 0,
			turnId: "turn-multi",
		},
	},
	{
		type: "action.result",
		data: {
			result: { callId: "call-multi", isError: false, kind: "tool-result", output: { stdout: longJsonValue }, toolName: "bash" },
			sequence: 5,
			status: "completed",
			stepIndex: 0,
			turnId: "turn-multi",
		},
	},
	{ type: "step.completed", data: { finishReason: "tool-calls", sequence: 6, stepIndex: 0, turnId: "turn-multi" } },
	{ type: "step.started", data: { sequence: 7, stepIndex: 1, turnId: "turn-multi" } },
	{
		type: "message.appended",
		data: { messageDelta: "Second", messageSoFar: "Second", sequence: 8, stepIndex: 1, turnId: "turn-multi" },
	},
	{
		type: "message.appended",
		data: { messageDelta: " step answer.", messageSoFar: "Second step answer.", sequence: 9, stepIndex: 1, turnId: "turn-multi" },
	},
	{
		type: "message.completed",
		data: { finishReason: "stop", message: "Second step answer.", sequence: 10, stepIndex: 1, turnId: "turn-multi" },
	},
	{ type: "step.completed", data: { finishReason: "stop", sequence: 11, stepIndex: 1, turnId: "turn-multi" } },
	{ type: "turn.completed", data: { sequence: 12, turnId: "turn-multi" } },
];

for (const event of multiStepEvents) chronologyRenderer.renderEvent(event);

const firstAssistantIndex = chronologyBlocks.findIndex((block) => block.markdown === "**Clanky**\n\nFirst step answer.");
const actionIndex = chronologyBlocks.findIndex((block) => block.markdown.includes("**Tool: bash - completed**"));
const secondAssistantIndex = chronologyBlocks.findIndex((block) => block.markdown === "**Clanky**\n\nSecond step answer.");
assert(firstAssistantIndex >= 0, "first-step assistant block should render");
assert(actionIndex > firstAssistantIndex, "tool block should render after first-step assistant text");
assert(secondAssistantIndex > actionIndex, "second-step assistant block should render after tool result block");
assert(
	!chronologyBlocks.some((block) => block.markdown.includes("First step answer.Second step answer.")),
	"assistant text from separate steps should not be concatenated into one block",
);
assert(
	chronologyBlocks
		.flatMap((block) => block.markdown.split("\n"))
		.every((line) => line.length <= 72 || line.startsWith("**") || line.startsWith("- ")),
	"renderer-owned JSON code-block lines should be bounded before Markdown rendering",
);

const lifecycleBlocks: CapturedBlock[] = [];
const lifecycleRenderer = new ClankyFaceRenderer({
	insertMarkdown(markdown: string): FaceBlockHandle {
		const block = new CapturedBlock(markdown);
		lifecycleBlocks.push(block);
		return block;
	},
	setLoaderMessage(): void {},
	setStatus(): void {},
});

lifecycleRenderer.renderEvent({
	type: "authorization.required",
	data: {
		authorization: {
			displayName: "Linear",
			expiresAt: "2026-06-26T12:00:00.000Z",
			instructions: "Approve the browser prompt.",
			url: "https://linear.test/auth",
			userCode: "ABCD",
		},
		description: "Sign in to Linear",
		name: "linear",
		sequence: 1,
		stepIndex: 0,
		turnId: "turn-auth",
	},
});
const authBlock = lifecycleBlocks.find((block) => block.markdown.includes("**Authorization required**"));
assert(authBlock !== undefined, "authorization.required should insert an auth block");
lifecycleRenderer.renderEvent({
	type: "authorization.completed",
	data: {
		authorization: { displayName: "Linear" },
		name: "linear",
		outcome: "authorized",
		sequence: 2,
		stepIndex: 0,
		turnId: "turn-auth",
	},
});
assert(authBlock.markdown.includes("**Authorization authorized**"), "authorization.completed should update the auth block in place");
assert(lifecycleBlocks.filter((block) => block.markdown.includes("Authorization")).length === 1, "auth lifecycle should not duplicate blocks");

lifecycleRenderer.renderEvent({
	type: "input.requested",
	data: {
		requests: [
			{
				action: { callId: "approval-call", input: { command: "rm tmp" }, kind: "tool-call", toolName: "bash" },
				display: "confirmation",
				options: [
					{ id: "approve", label: "Approve", style: "primary" },
					{ id: "deny", label: "Deny", style: "danger" },
				],
				prompt: "Run bash?",
				requestId: "approval-1",
			},
		],
		sequence: 3,
		stepIndex: 0,
		turnId: "turn-auth",
	},
});
const approvalBlock = lifecycleBlocks.find((block) => block.markdown.includes("**Tool: bash - approval requested**"));
assert(approvalBlock !== undefined, "confirmation input should render as an approval-pending tool block");
lifecycleRenderer.recordInputResponses([{ requestId: "approval-1", optionId: "approve" }]);
assert(approvalBlock.markdown.includes("**Tool: bash - approved**"), "approval response should update the tool approval block");

lifecycleRenderer.renderEvent({
	type: "subagent.called",
	data: {
		callId: "sub-1",
		childSessionId: "child-session",
		name: "Planner",
		sequence: 4,
		sessionId: "parent-session",
		toolName: "planner",
		turnId: "turn-sub",
		workflowId: "workflow-1",
	},
});
const subagentBlock = lifecycleBlocks.find((block) => block.markdown.includes("**Subagent: Planner - running**"));
assert(subagentBlock !== undefined, "subagent.called should insert a running subagent block");
lifecycleRenderer.renderEvent({
	type: "subagent.event",
	data: {
		callId: "sub-1",
		subagentName: "Planner",
		event: {
			type: "message.appended",
			data: { messageDelta: "Child ", messageSoFar: "Child ", sequence: 5, stepIndex: 0, turnId: "child-turn" },
		},
	},
});
lifecycleRenderer.renderEvent({
	type: "subagent.event",
	data: {
		callId: "sub-1",
		subagentName: "Planner",
		event: {
			type: "message.appended",
			data: { messageDelta: "answer \x1b[31mred", messageSoFar: "Child answer \x1b[31mred", sequence: 6, stepIndex: 0, turnId: "child-turn" },
		},
	},
});
lifecycleRenderer.renderEvent({
	type: "subagent.event",
	data: {
		callId: "sub-1",
		subagentName: "Planner",
		event: {
			type: "message.completed",
			data: { finishReason: "stop", message: "Child answer \x1b[31mred", sequence: 7, stepIndex: 0, turnId: "child-turn" },
		},
	},
});
lifecycleRenderer.renderEvent({
	type: "subagent.event",
	data: {
		callId: "sub-1",
		subagentName: "Planner",
		event: {
			type: "actions.requested",
			data: {
				actions: [{ callId: "child-tool", input: { command: "printf ok" }, kind: "tool-call", toolName: "bash" }],
				sequence: 8,
				stepIndex: 0,
				turnId: "child-turn",
			},
		},
	},
});
lifecycleRenderer.renderEvent({
	type: "subagent.event",
	data: {
		callId: "sub-1",
		subagentName: "Planner",
		event: {
			type: "action.result",
			data: {
				result: { callId: "child-tool", isError: false, kind: "tool-result", output: { stdout: "ok\x1b[31m" }, toolName: "bash" },
				sequence: 9,
				status: "completed",
				stepIndex: 0,
				turnId: "child-turn",
			},
		},
	},
});
const subagentApprovalResult = lifecycleRenderer.renderEvent({
	type: "subagent.event",
	data: {
		callId: "sub-1",
		subagentName: "Planner",
		event: {
			type: "input.requested",
			data: {
				requests: [
					{
						action: { callId: "child-approval", input: { command: "touch ok" }, kind: "tool-call", toolName: "bash" },
						display: "confirmation",
						options: [
							{ id: "approve", label: "Approve", style: "primary" },
							{ id: "deny", label: "Deny", style: "danger" },
						],
						prompt: "Run child bash?",
						requestId: "sub-approval-1",
					},
				],
				sequence: 10,
				stepIndex: 0,
				turnId: "child-turn",
			},
		},
	},
});
assert(subagentApprovalResult.inputRequests.length === 1, "child input requests should still be returned so the prompt loop can answer them");
const subagentApprovalBlock = lifecycleBlocks.find((block) => block.markdown.includes("**Subagent tool: Planner / bash - approval requested**"));
assert(subagentApprovalBlock !== undefined, "subagent approval should render as a nested tool approval block");
lifecycleRenderer.recordInputResponses([{ requestId: "sub-approval-1", optionId: "approve" }]);
assert(
	subagentApprovalBlock.markdown.includes("**Subagent tool: Planner / bash - approved**"),
	"subagent approval response should preserve the nested tool title",
);
const childWait = lifecycleRenderer.renderEvent({
	type: "subagent.event",
	data: {
		callId: "sub-1",
		subagentName: "Planner",
		event: { type: "session.waiting", data: { wait: "next-user-message" } },
	},
});
assert(!childWait.terminal, "child session.waiting should not terminate the parent stream");
lifecycleRenderer.renderEvent({ type: "subagent.completed", data: { callId: "sub-1", output: "Done", subagentName: "Planner" } });
assert(subagentBlock.markdown.includes("**Subagent: Planner - completed**"), "subagent.completed should update the parent subagent block");
assert(!subagentBlock.markdown.includes("Done"), "subagent completion should not duplicate output already shown in child stream rows");
assert(lifecycleBlocks.some((block) => block.markdown.includes("**Subagent step: Planner**") && block.markdown.includes("Child answer red")), "subagent child message should render as a nested step");
assert(
	lifecycleBlocks.filter((block) => block.markdown.includes("**Subagent step: Planner**")).length === 1,
	"subagent streamed message should update one nested step block",
);
assert(
	lifecycleBlocks.some((block) => block.markdown.includes("**Subagent tool: Planner / bash - completed**") && block.markdown.includes("-> ok")),
	"subagent child tool result should update the nested tool block",
);
assert(!lifecycleBlocks.some((block) => block.markdown.includes("\x1b")), "renderer should strip terminal control sequences from event text");

const fallbackSubagentBlocks: CapturedBlock[] = [];
const fallbackSubagentRenderer = new ClankyFaceRenderer({
	insertMarkdown(markdown: string): FaceBlockHandle {
		const block = new CapturedBlock(markdown);
		fallbackSubagentBlocks.push(block);
		return block;
	},
	setLoaderMessage(): void {},
	setStatus(): void {},
});
fallbackSubagentRenderer.renderEvent({
	type: "subagent.called",
	data: {
		callId: "sub-no-child",
		childSessionId: "child-no-stream",
		name: "Scout",
		sequence: 1,
		sessionId: "parent-session",
		toolName: "scout",
		turnId: "turn-sub",
		workflowId: "workflow-1",
	},
});
const fallbackSubagentBlock = fallbackSubagentBlocks.find((block) => block.markdown.includes("**Subagent: Scout - running**"));
assert(fallbackSubagentBlock !== undefined, "subagent without child stream should still insert a lifecycle block");
fallbackSubagentRenderer.renderEvent({ type: "subagent.completed", data: { callId: "sub-no-child", output: "Scout final output", subagentName: "Scout" } });
assert(fallbackSubagentBlock.markdown.includes("**Subagent: Scout - completed**"), "fallback subagent completion should update the lifecycle block");
assert(fallbackSubagentBlock.markdown.includes("Scout final output"), "subagent completion should show output when no child stream was rendered");

const failureCountBefore = lifecycleBlocks.length;
const failureEvent: HandleMessageStreamEvent = {
	type: "step.failed",
	data: {
		code: "boom",
		details: { detail: "root cause" },
		message: "Exploded",
		sequence: 8,
		stepIndex: 0,
		turnId: "turn-fail",
	},
};
lifecycleRenderer.renderEvent(failureEvent);
lifecycleRenderer.renderEvent(failureEvent);
assert(lifecycleBlocks.length === failureCountBefore + 1, "duplicate failure cascade events should update one error block");
assert(lifecycleBlocks.at(-1)?.markdown.includes("root cause") === true, "failure blocks should include useful detail text");

console.log("clanky-face-renderer-smoke: ok");
