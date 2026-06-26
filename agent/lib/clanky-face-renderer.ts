import type { HandleMessageStreamEvent, InputRequest, InputResponse } from "eve/client";
import { NoReplyTracker, NO_ASSISTANT_REPLY_NOTICE } from "./tui-no-reply.ts";

export type FaceBlockHandle = {
	setMarkdown(markdown: string): void;
};

export type FaceRenderSink = {
	insertMarkdown(markdown: string): FaceBlockHandle;
	setLoaderMessage(message: string): void;
	setStatus(message: string): void;
};

export type FaceRenderEventResult = {
	inputRequests: readonly InputRequest[];
	terminal: boolean;
};

export type StepUsage = NonNullable<Extract<HandleMessageStreamEvent, { type: "step.completed" }>["data"]["usage"]>;

type ActionRequest = Extract<HandleMessageStreamEvent, { type: "actions.requested" }>["data"]["actions"][number];
type ActionResult = Extract<HandleMessageStreamEvent, { type: "action.result" }>["data"]["result"];
type ActionResultError = Extract<HandleMessageStreamEvent, { type: "action.result" }>["data"]["error"];
type ActionResultStatus = Extract<HandleMessageStreamEvent, { type: "action.result" }>["data"]["status"];
type AuthorizationCompletedEvent = Extract<HandleMessageStreamEvent, { type: "authorization.completed" }>;
type AuthorizationRequiredEvent = Extract<HandleMessageStreamEvent, { type: "authorization.required" }>;
type FailureEvent =
	| Extract<HandleMessageStreamEvent, { type: "session.failed" }>
	| Extract<HandleMessageStreamEvent, { type: "step.failed" }>
	| Extract<HandleMessageStreamEvent, { type: "turn.failed" }>;
type SubagentCalledEvent = Extract<HandleMessageStreamEvent, { type: "subagent.called" }>;

const STREAM_RENDER_THROTTLE_MS = 50;
const MAX_CODE_BLOCK_LINE_CHARS = 72;
const JSON_BLOCK_MAX_CHARS = 4_000;

type TurnStats = {
	assistantTextChars: number;
	reasoningTextChars: number;
	sawAssistantText: boolean;
	sawInputRequest: boolean;
	stepFinishes: number;
	stepStarts: number;
	toolCalls: string[];
	toolResults: string[];
};

export class ClankyFaceRenderer {
	private readonly sink: FaceRenderSink;
	private readonly prefixByTurnStep = new Map<string, string>();
	private readonly eventCounts = new Map<HandleMessageStreamEvent["type"], number>();
	private assistantBlock: FaceBlockHandle | undefined;
	private assistantText = "";
	private pendingAssistantMarkdown: string | undefined;
	private reasoningBlock: FaceBlockHandle | undefined;
	private reasoningText = "";
	private pendingReasoningMarkdown: string | undefined;
	private streamFlushTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly actionBlocksByCallId = new Map<string, FaceBlockHandle>();
	private readonly authorizationBlocksByName = new Map<string, FaceBlockHandle>();
	private readonly failureBlocksByKey = new Map<string, FaceBlockHandle>();
	private readonly inputApprovalTitlePrefixByRequestId = new Map<string, string>();
	private readonly inputBlocksByRequestId = new Map<string, FaceBlockHandle>();
	private readonly inputRequestsByRequestId = new Map<string, InputRequest>();
	private readonly subagentBlocksByCallId = new Map<string, FaceBlockHandle>();
	private readonly subagentBodyByCallId = new Map<string, string>();
	private readonly subagentHasVisibleChildContentByCallId = new Map<string, boolean>();
	private readonly subagentMessageBlocksByKey = new Map<string, FaceBlockHandle>();
	private readonly subagentReasoningBlocksByKey = new Map<string, FaceBlockHandle>();
	private readonly subagentStreamTextByKey = new Map<string, string>();
	private noReply = new NoReplyTracker();
	private stats = createEmptyTurnStats();
	private usage: StepUsage | undefined;

	constructor(sink: FaceRenderSink) {
		this.sink = sink;
	}

	get lastUsage(): StepUsage | undefined {
		return this.usage;
	}

	get eventCount(): number {
		return [...this.eventCounts.values()].reduce((sum, count) => sum + count, 0);
	}

	resetSession(): void {
		this.prefixByTurnStep.clear();
		this.usage = undefined;
		this.resetTurn();
	}

	resetTurn(): void {
		this.clearPendingStreamFlush();
		this.assistantBlock = undefined;
		this.assistantText = "";
		this.pendingAssistantMarkdown = undefined;
		this.reasoningBlock = undefined;
		this.reasoningText = "";
		this.pendingReasoningMarkdown = undefined;
		this.actionBlocksByCallId.clear();
		this.authorizationBlocksByName.clear();
		this.failureBlocksByKey.clear();
		this.inputApprovalTitlePrefixByRequestId.clear();
		this.inputBlocksByRequestId.clear();
		this.inputRequestsByRequestId.clear();
		this.subagentBlocksByCallId.clear();
		this.subagentBodyByCallId.clear();
		this.subagentHasVisibleChildContentByCallId.clear();
		this.subagentMessageBlocksByKey.clear();
		this.subagentReasoningBlocksByKey.clear();
		this.subagentStreamTextByKey.clear();
		this.noReply = new NoReplyTracker();
		this.stats = createEmptyTurnStats();
	}

	renderEvent(event: HandleMessageStreamEvent): FaceRenderEventResult {
		this.recordEvent(event);
		this.noReply.observe(event);
		let inputRequests: readonly InputRequest[] = [];
		let terminal = false;

		switch (event.type) {
			case "session.started":
				this.sink.setStatus(`session started ${event.data.runtime?.modelId ?? ""}`.trim());
				break;
			case "turn.started":
				this.sink.setStatus(`turn ${event.data.turnId}`);
				break;
			case "message.received":
				break;
			case "step.started":
				this.closeStreamingBlocks();
				this.stats.stepStarts += 1;
				this.sink.setLoaderMessage(`Step ${event.data.stepIndex + 1} running...`);
				this.sink.setStatus(`step ${event.data.stepIndex + 1}`);
				break;
			case "reasoning.appended":
				this.appendReasoning(event.data.turnId, event.data.stepIndex, event.data.reasoningSoFar, event.data.reasoningDelta);
				break;
			case "reasoning.completed":
				this.flushPendingStreamUpdates();
				break;
			case "message.appended":
				this.appendAssistant(event.data.turnId, event.data.stepIndex, event.data.messageSoFar, event.data.messageDelta);
				break;
			case "message.completed":
				this.flushPendingStreamUpdates();
				if ((event.data.message ?? "").trim().length > 0) this.stats.sawAssistantText = true;
				break;
			case "actions.requested":
				this.stats.toolCalls.push(...event.data.actions.map(actionRequestName));
				for (const action of event.data.actions) this.insertActionRequest(action);
				break;
			case "action.result":
				this.stats.toolResults.push(actionResultName(event.data.result));
				this.upsertActionResult(event.data.result, event.data.status, event.data.error);
				break;
			case "input.requested":
				this.stats.sawInputRequest = true;
				inputRequests = event.data.requests;
				this.upsertInputRequests(event.data.requests);
				break;
			case "authorization.required":
				this.upsertAuthorizationRequired(event);
				break;
			case "authorization.completed":
				this.upsertAuthorizationCompleted(event);
				break;
			case "subagent.called":
				this.upsertSubagentBlock(event.data.callId, event.data.name, "running", formatSubagentCalledBody(event));
				break;
			case "subagent.started":
				this.upsertSubagentBlock(event.data.callId, event.data.subagentName, "running", "inline subagent started");
				break;
			case "subagent.event":
				inputRequests = this.renderSubagentChildEvent(event.data.callId, event.data.subagentName, event.data.event);
				break;
			case "subagent.completed":
				this.completeSubagentBlock(event.data.callId, event.data.subagentName, event.data.output);
				break;
			case "step.completed":
				this.flushPendingStreamUpdates();
				this.stats.stepFinishes += 1;
				this.usage = mergeUsage(this.usage, event.data.usage);
				this.sink.setStatus(`step ${event.data.stepIndex + 1} completed`);
				break;
			case "step.failed":
				this.upsertFailureBlock(event);
				break;
			case "turn.completed":
				this.flushPendingStreamUpdates();
				this.sink.setStatus("turn completed");
				terminal = true;
				break;
			case "turn.failed":
				this.upsertFailureBlock(event);
				terminal = true;
				break;
			case "result.completed":
				this.insertStandaloneMarkdown(`**Result completed**\n\n\`\`\`json\n${formatJsonBlock(event.data.result)}\n\`\`\``);
				break;
			case "compaction.requested":
				this.insertStandaloneMarkdown(`**Compaction requested**\n\n${event.data.modelId}`);
				break;
			case "compaction.completed":
				this.insertStandaloneMarkdown(`**Compaction completed**\n\n${event.data.sessionId}`);
				break;
			case "session.waiting":
				this.flushPendingStreamUpdates();
				this.sink.setStatus("session waiting");
				terminal = true;
				break;
			case "session.completed":
				this.flushPendingStreamUpdates();
				this.sink.setStatus("session completed");
				terminal = true;
				break;
			case "session.failed":
				this.upsertFailureBlock(event);
				terminal = true;
				break;
		}

		return { inputRequests, terminal };
	}

	noticeForCompletedTurn(traceMode: "off" | "no-reply" | "all"): string | undefined {
		if (this.noReply.shouldRenderNotice()) {
			return traceMode === "off" ? NO_ASSISTANT_REPLY_NOTICE : this.noReply.formatNoReplyNotice();
		}
		return traceMode === "all" ? this.noReply.formatTraceNotice() : undefined;
	}

	formatEventCounts(): string {
		if (this.eventCounts.size === 0) return "No events observed yet.";
		return [...this.eventCounts.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([type, count]) => `- ${type}: ${count}`)
			.join("\n");
	}

	formatTraceSummary(): string {
		return formatTurnStats(this.stats);
	}

	recordInputResponses(responses: readonly InputResponse[]): void {
		for (const response of responses) this.upsertInputResponse(response);
	}

	private appendAssistant(turnId: string, stepIndex: number, messageSoFar: string, messageDelta: string): void {
		const suffix = this.suffixFromReplay("message", turnId, stepIndex, messageSoFar, messageDelta);
		if (suffix.length === 0) return;
		this.assistantText += sanitizeTerminalText(suffix);
		this.stats.assistantTextChars += suffix.length;
		if (suffix.trim().length > 0) this.stats.sawAssistantText = true;
		const markdown = `**Clanky**\n\n${this.assistantText}`;
		if (this.assistantBlock === undefined) {
			this.assistantBlock = this.sink.insertMarkdown(markdown);
			return;
		}
		this.pendingAssistantMarkdown = markdown;
		this.scheduleStreamFlush();
	}

	private appendReasoning(turnId: string, stepIndex: number, reasoningSoFar: string, reasoningDelta: string): void {
		const suffix = this.suffixFromReplay("reasoning", turnId, stepIndex, reasoningSoFar, reasoningDelta);
		if (suffix.length === 0) return;
		this.reasoningText += sanitizeTerminalText(suffix);
		this.stats.reasoningTextChars += suffix.length;
		const markdown = `**Reasoning**\n\n${this.reasoningText}`;
		if (this.reasoningBlock === undefined) {
			this.reasoningBlock = this.sink.insertMarkdown(markdown);
			return;
		}
		this.pendingReasoningMarkdown = markdown;
		this.scheduleStreamFlush();
	}

	private insertStandaloneMarkdown(markdown: string): void {
		this.closeStreamingBlocks();
		this.sink.insertMarkdown(sanitizeTerminalText(markdown));
	}

	private insertActionRequest(action: ActionRequest): void {
		this.closeStreamingBlocks();
		const block = this.sink.insertMarkdown(sanitizeTerminalText(formatActionRequestBlock(action)));
		this.actionBlocksByCallId.set(action.callId, block);
	}

	private upsertActionResult(result: ActionResult, status: ActionResultStatus, error: ActionResultError): void {
		this.closeStreamingBlocks();
		const markdown = formatActionResultBlock(result, status, error);
		const block = this.actionBlocksByCallId.get(result.callId);
		if (block === undefined) {
			this.sink.insertMarkdown(sanitizeTerminalText(markdown));
			return;
		}
		block.setMarkdown(sanitizeTerminalText(markdown));
	}

	private upsertAuthorizationRequired(event: AuthorizationRequiredEvent): void {
		this.closeStreamingBlocks();
		const markdown = `**Authorization required**\n\n${formatAuthorizationChallenge(event)}`;
		const block = this.authorizationBlocksByName.get(event.data.name);
		if (block === undefined) {
			this.authorizationBlocksByName.set(event.data.name, this.sink.insertMarkdown(sanitizeTerminalText(markdown)));
			return;
		}
		block.setMarkdown(sanitizeTerminalText(markdown));
	}

	private upsertAuthorizationCompleted(event: AuthorizationCompletedEvent): void {
		this.closeStreamingBlocks();
		const markdown = `**Authorization ${event.data.outcome}**\n\n${formatAuthorizationCompletion(event)}`;
		const block = this.authorizationBlocksByName.get(event.data.name);
		if (block === undefined) {
			this.authorizationBlocksByName.set(event.data.name, this.sink.insertMarkdown(sanitizeTerminalText(markdown)));
			return;
		}
		block.setMarkdown(sanitizeTerminalText(markdown));
	}

	private upsertFailureBlock(event: FailureEvent): void {
		this.closeStreamingBlocks();
		const key = failureBlockKey(event);
		const markdown = `**${failureTitle(event)}**\n\n${formatFailureEvent(event)}`;
		const block = this.failureBlocksByKey.get(key);
		if (block === undefined) {
			this.failureBlocksByKey.set(key, this.sink.insertMarkdown(sanitizeTerminalText(markdown)));
			return;
		}
		block.setMarkdown(sanitizeTerminalText(markdown));
	}

	private upsertInputRequests(requests: readonly InputRequest[]): void {
		for (const request of requests) {
			this.inputRequestsByRequestId.set(request.requestId, request);
			if (isApprovalRequest(request)) this.inputApprovalTitlePrefixByRequestId.set(request.requestId, `Tool: ${request.action.toolName}`);
			const markdown = formatInputRequestBlock(request);
			const block = this.inputBlocksByRequestId.get(request.requestId) ?? this.actionBlocksByCallId.get(request.action.callId);
			if (block === undefined) {
				const inserted = this.sink.insertMarkdown(sanitizeTerminalText(markdown));
				this.inputBlocksByRequestId.set(request.requestId, inserted);
				if (isApprovalRequest(request)) this.actionBlocksByCallId.set(request.action.callId, inserted);
				continue;
			}
			this.inputBlocksByRequestId.set(request.requestId, block);
			block.setMarkdown(sanitizeTerminalText(markdown));
		}
	}

	private upsertInputResponse(response: InputResponse): void {
		this.closeStreamingBlocks();
		const request = this.inputRequestsByRequestId.get(response.requestId);
		const titlePrefix = this.inputApprovalTitlePrefixByRequestId.get(response.requestId);
		const markdown = request === undefined ? formatOrphanInputResponseBlock(response) : formatInputResponseBlock(request, response, titlePrefix);
		const block = this.inputBlocksByRequestId.get(response.requestId);
		if (block === undefined) {
			this.inputBlocksByRequestId.set(response.requestId, this.sink.insertMarkdown(sanitizeTerminalText(markdown)));
			return;
		}
		block.setMarkdown(sanitizeTerminalText(markdown));
	}

	private upsertSubagentBlock(callId: string, name: string, status: "completed" | "failed" | "running", body: string): void {
		this.closeStreamingBlocks();
		this.subagentBodyByCallId.set(callId, body);
		const markdown = formatSubagentBlock(name, status, body);
		const block = this.subagentBlocksByCallId.get(callId);
		if (block === undefined) {
			this.subagentBlocksByCallId.set(callId, this.sink.insertMarkdown(sanitizeTerminalText(markdown)));
			return;
		}
		block.setMarkdown(sanitizeTerminalText(markdown));
	}

	private renderSubagentChildEvent(parentCallId: string, subagentName: string, childEvent: HandleMessageStreamEvent): readonly InputRequest[] {
		switch (childEvent.type) {
			case "message.appended":
				this.appendSubagentStream(
					parentCallId,
					subagentName,
					"message",
					childEvent.data.turnId,
					childEvent.data.stepIndex,
					childEvent.data.messageSoFar,
					childEvent.data.messageDelta,
				);
				return [];
			case "message.completed": {
				const message = sanitizeTerminalText(childEvent.data.message ?? "").trim();
				if (message.length > 0) this.completeSubagentStream(parentCallId, subagentName, "message", childEvent.data.turnId, childEvent.data.stepIndex, message);
				return [];
			}
			case "reasoning.appended":
				this.appendSubagentStream(
					parentCallId,
					subagentName,
					"reasoning",
					childEvent.data.turnId,
					childEvent.data.stepIndex,
					childEvent.data.reasoningSoFar,
					childEvent.data.reasoningDelta,
				);
				return [];
			case "reasoning.completed": {
				const reasoning = sanitizeTerminalText(childEvent.data.reasoning).trim();
				if (reasoning.length > 0) {
					this.completeSubagentStream(parentCallId, subagentName, "reasoning", childEvent.data.turnId, childEvent.data.stepIndex, reasoning);
				}
				return [];
			}
			case "actions.requested":
				this.stats.toolCalls.push(...childEvent.data.actions.map((action) => `${subagentName}/${actionRequestName(action)}`));
				for (const action of childEvent.data.actions) this.insertSubagentActionRequest(parentCallId, subagentName, action);
				return [];
			case "action.result":
				this.stats.toolResults.push(`${subagentName}/${actionResultName(childEvent.data.result)}`);
				this.upsertSubagentActionResult(parentCallId, subagentName, childEvent.data.result, childEvent.data.status, childEvent.data.error);
				return [];
			case "input.requested":
				this.stats.sawInputRequest = true;
				this.upsertSubagentInputRequests(parentCallId, subagentName, childEvent.data.requests);
				return childEvent.data.requests;
			case "authorization.required":
				this.insertStandaloneMarkdown(`**Authorization required**\n\nSubagent ${subagentName}\n\n${formatAuthorizationChallenge(childEvent)}`);
				return [];
			case "authorization.completed":
				this.insertStandaloneMarkdown(`**Authorization ${childEvent.data.outcome}**\n\nSubagent ${subagentName}\n\n${formatAuthorizationCompletion(childEvent)}`);
				return [];
			case "step.failed":
			case "turn.failed":
			case "session.failed":
				this.upsertSubagentBlock(parentCallId, subagentName, "failed", formatFailureEvent(childEvent));
				this.insertStandaloneMarkdown(`**Subagent failed: ${subagentName}**\n\n${formatFailureEvent(childEvent)}`);
				return [];
			case "subagent.called":
				this.upsertSubagentBlock(childEvent.data.callId, childEvent.data.name, "running", formatSubagentCalledBody(childEvent));
				return [];
			case "subagent.started":
				this.upsertSubagentBlock(childEvent.data.callId, childEvent.data.subagentName, "running", "inline subagent started");
				return [];
			case "subagent.event":
				return this.renderSubagentChildEvent(childEvent.data.callId, childEvent.data.subagentName, childEvent.data.event);
			case "subagent.completed":
				this.completeSubagentBlock(childEvent.data.callId, childEvent.data.subagentName, childEvent.data.output);
				return [];
			case "compaction.completed":
			case "compaction.requested":
			case "message.received":
			case "result.completed":
			case "session.completed":
			case "session.started":
			case "session.waiting":
			case "step.completed":
			case "step.started":
			case "turn.completed":
			case "turn.started":
				return [];
		}
	}

	private insertSubagentActionRequest(parentCallId: string, subagentName: string, action: ActionRequest): void {
		this.closeStreamingBlocks();
		this.markSubagentVisibleChildContent(parentCallId);
		const block = this.sink.insertMarkdown(
			sanitizeTerminalText(formatActionRequestBlock(action, `Subagent tool: ${subagentName} / ${actionRequestName(action)} - running`)),
		);
		this.actionBlocksByCallId.set(subagentActionKey(parentCallId, action.callId), block);
	}

	private upsertSubagentActionResult(
		parentCallId: string,
		subagentName: string,
		result: ActionResult,
		status: ActionResultStatus,
		error: ActionResultError,
	): void {
		this.closeStreamingBlocks();
		this.markSubagentVisibleChildContent(parentCallId);
		const outcome = actionOutcome(result, status);
		const markdown = formatActionResultBlock(result, status, error, `Subagent tool: ${subagentName} / ${actionResultName(result)} - ${outcome}`);
		const block = this.actionBlocksByCallId.get(subagentActionKey(parentCallId, result.callId));
		if (block === undefined) {
			this.sink.insertMarkdown(sanitizeTerminalText(markdown));
			return;
		}
		block.setMarkdown(sanitizeTerminalText(markdown));
	}

	private upsertSubagentInputRequests(parentCallId: string, subagentName: string, requests: readonly InputRequest[]): void {
		for (const request of requests) {
			this.inputRequestsByRequestId.set(request.requestId, request);
			const actionKey = subagentActionKey(parentCallId, request.action.callId);
			this.markSubagentVisibleChildContent(parentCallId);
			if (isApprovalRequest(request)) {
				this.inputApprovalTitlePrefixByRequestId.set(request.requestId, `Subagent tool: ${subagentName} / ${request.action.toolName}`);
			}
			const title = isApprovalRequest(request)
				? `Subagent tool: ${subagentName} / ${request.action.toolName} - approval requested`
				: `Input requested`;
			const markdown = isApprovalRequest(request)
				? formatInputRequestBlock(request, title)
				: `**Input requested**\n\nSubagent ${subagentName}\n\n${formatInputRequestBody(request)}`;
			const block = this.inputBlocksByRequestId.get(request.requestId) ?? this.actionBlocksByCallId.get(actionKey);
			if (block === undefined) {
				const inserted = this.sink.insertMarkdown(sanitizeTerminalText(markdown));
				this.inputBlocksByRequestId.set(request.requestId, inserted);
				if (isApprovalRequest(request)) this.actionBlocksByCallId.set(actionKey, inserted);
				continue;
			}
			this.inputBlocksByRequestId.set(request.requestId, block);
			block.setMarkdown(sanitizeTerminalText(markdown));
		}
	}

	private appendSubagentStream(
		parentCallId: string,
		subagentName: string,
		kind: "message" | "reasoning",
		turnId: string,
		stepIndex: number,
		soFar: string,
		delta: string,
	): void {
		const key = subagentStreamKey(parentCallId, kind, turnId, stepIndex);
		const suffix = this.suffixFromReplayKey(`subagent:${key}`, soFar, delta);
		if (suffix.length === 0) return;
		const text = `${this.subagentStreamTextByKey.get(key) ?? ""}${sanitizeTerminalText(suffix)}`;
		this.subagentStreamTextByKey.set(key, text);
		this.markSubagentVisibleChildContent(parentCallId);
		this.upsertSubagentStreamBlock(key, subagentName, kind, text);
	}

	private completeSubagentStream(
		parentCallId: string,
		subagentName: string,
		kind: "message" | "reasoning",
		turnId: string,
		stepIndex: number,
		text: string,
	): void {
		const key = subagentStreamKey(parentCallId, kind, turnId, stepIndex);
		this.subagentStreamTextByKey.set(key, text);
		this.markSubagentVisibleChildContent(parentCallId);
		this.upsertSubagentStreamBlock(key, subagentName, kind, text);
	}

	private upsertSubagentStreamBlock(key: string, subagentName: string, kind: "message" | "reasoning", text: string): void {
		this.closeStreamingBlocks();
		const markdown = `**Subagent ${kind === "message" ? "step" : "reasoning"}: ${subagentName}**\n\n${text}`;
		const blocks = kind === "message" ? this.subagentMessageBlocksByKey : this.subagentReasoningBlocksByKey;
		const block = blocks.get(key);
		if (block === undefined) {
			blocks.set(key, this.sink.insertMarkdown(sanitizeTerminalText(markdown)));
			return;
		}
		block.setMarkdown(sanitizeTerminalText(markdown));
	}

	private completeSubagentBlock(callId: string, name: string, output: string): void {
		const visibleChildContent = this.subagentHasVisibleChildContentByCallId.get(callId) === true;
		const body = visibleChildContent ? this.subagentBodyByCallId.get(callId) ?? "" : output;
		this.upsertSubagentBlock(callId, name, "completed", body);
	}

	private markSubagentVisibleChildContent(callId: string): void {
		this.subagentHasVisibleChildContentByCallId.set(callId, true);
	}

	private closeStreamingBlocks(): void {
		this.flushPendingStreamUpdates();
		this.assistantBlock = undefined;
		this.assistantText = "";
		this.reasoningBlock = undefined;
		this.reasoningText = "";
	}

	private scheduleStreamFlush(): void {
		if (this.streamFlushTimer !== undefined) return;
		this.streamFlushTimer = setTimeout(() => {
			this.streamFlushTimer = undefined;
			this.flushPendingStreamUpdates();
		}, STREAM_RENDER_THROTTLE_MS);
	}

	private flushPendingStreamUpdates(): void {
		this.clearPendingStreamFlush();
		if (this.pendingAssistantMarkdown !== undefined && this.assistantBlock !== undefined) {
			this.assistantBlock.setMarkdown(this.pendingAssistantMarkdown);
		}
		if (this.pendingReasoningMarkdown !== undefined && this.reasoningBlock !== undefined) {
			this.reasoningBlock.setMarkdown(this.pendingReasoningMarkdown);
		}
		this.pendingAssistantMarkdown = undefined;
		this.pendingReasoningMarkdown = undefined;
	}

	private clearPendingStreamFlush(): void {
		if (this.streamFlushTimer === undefined) return;
		clearTimeout(this.streamFlushTimer);
		this.streamFlushTimer = undefined;
	}

	private suffixFromReplay(kind: "message" | "reasoning", turnId: string, stepIndex: number, soFar: string, delta: string): string {
		return this.suffixFromReplayKey(`${kind}:${turnId}:${stepIndex}`, soFar, delta);
	}

	private suffixFromReplayKey(key: string, soFar: string, delta: string): string {
		const previous = this.prefixByTurnStep.get(key) ?? "";
		if (soFar.length <= previous.length && previous.startsWith(soFar)) return "";
		if (soFar.startsWith(previous)) {
			this.prefixByTurnStep.set(key, soFar);
			return soFar.slice(previous.length);
		}
		if (soFar.length > previous.length) this.prefixByTurnStep.set(key, soFar);
		return delta;
	}

	private recordEvent(event: HandleMessageStreamEvent): void {
		this.eventCounts.set(event.type, (this.eventCounts.get(event.type) ?? 0) + 1);
	}
}

function createEmptyTurnStats(): TurnStats {
	return {
		assistantTextChars: 0,
		reasoningTextChars: 0,
		sawAssistantText: false,
		sawInputRequest: false,
		stepFinishes: 0,
		stepStarts: 0,
		toolCalls: [],
		toolResults: [],
	};
}

export function formatTokenFlow(usage: StepUsage | undefined, contextWindowTokens: number | undefined): string {
	if (usage === undefined) return "";
	const inputTokens = usage.inputTokens ?? 0;
	const outputTokens = usage.outputTokens ?? 0;
	const contextPercent =
		contextWindowTokens !== undefined && contextWindowTokens > 0 ? ` ctx ${Math.round((inputTokens / contextWindowTokens) * 100)}%` : "";
	return `↑ ${formatCompactTokenCount(inputTokens)} ↓ ${formatCompactTokenCount(outputTokens)}${contextPercent}`;
}

export function formatContextUsage(usage: StepUsage | undefined, contextWindowTokens: number | undefined): string {
	if (usage !== undefined) return formatTokenFlow(usage, contextWindowTokens);
	return contextWindowTokens !== undefined && contextWindowTokens > 0 ? "ctx 0%" : "";
}

export function formatCompactTokenCount(tokens: number): string {
	if (tokens >= 1_000_000) return `${formatCompactAmount(tokens / 1_000_000)}M`;
	if (tokens >= 1_000) return `${formatCompactAmount(tokens / 1_000)}K`;
	return String(tokens);
}

export function formatInputRequests(requests: readonly InputRequest[]): string {
	return requests.map(formatInputRequestBody).join("\n\n");
}

export function defaultResponseForInputRequest(request: InputRequest): InputResponse {
	const preferred = request.options?.find((option) => /approve|allow|yes|continue/iu.test(option.id));
	const fallback = request.options?.[0];
	if (request.display !== "confirmation" && preferred !== undefined && /^(approve|deny)$/iu.test(preferred.id)) {
		return { requestId: request.requestId, text: preferred.label };
	}
	if (preferred !== undefined) return { requestId: request.requestId, optionId: preferred.id };
	if (fallback !== undefined) return { requestId: request.requestId, optionId: fallback.id };
	return { requestId: request.requestId, text: "Approved by Clanky face." };
}

export function formatInputResponses(responses: readonly InputResponse[]): string {
	return responses.map((response) => `- ${response.requestId}: ${response.optionId ?? response.text ?? "(empty)"}`).join("\n");
}

function formatTurnStats(stats: TurnStats): string {
	const parts = [
		`steps ${stats.stepStarts}/${stats.stepFinishes}`,
		`assistant ${stats.assistantTextChars} chars`,
		`reasoning ${stats.reasoningTextChars} chars`,
		`tool-calls ${stats.toolCalls.length === 0 ? "none" : summarizeNames(stats.toolCalls)}`,
		`tool-results ${stats.toolResults.length === 0 ? "none" : summarizeNames(stats.toolResults)}`,
		`input-requests ${stats.sawInputRequest ? "yes" : "no"}`,
	];
	return `Trace: ${parts.join("; ")}.`;
}

function formatActionRequestBlock(action: ActionRequest, title = `Tool: ${actionRequestName(action)} - running`): string {
	const summary = summarizeToolArgs(action.input);
	return [
		`**${title}**`,
		"",
		summary.length === 0 ? `call ${action.callId}` : summary,
	].join("\n");
}

function formatActionResultBlock(
	result: ActionResult,
	status: ActionResultStatus,
	error: ActionResultError,
	title = `Tool: ${actionResultName(result)} - ${actionOutcome(result, status)}`,
): string {
	const outcome = actionOutcome(result, status);
	const detail = error === undefined ? summarizeToolResult(result.output) : `${error.code}: ${error.message}`;
	return [
		`**${title}**`,
		"",
		`${outcome === "completed" ? "->" : "!"} ${detail}`,
	].join("\n");
}

function formatInputRequestBlock(request: InputRequest, title?: string): string {
	const resolvedTitle = title ?? (isApprovalRequest(request) ? `Tool: ${request.action.toolName} - approval requested` : "Input requested");
	return [`**${resolvedTitle}**`, "", formatInputRequestBody(request)].join("\n");
}

function formatInputResponseBlock(request: InputRequest, response: InputResponse, approvalTitlePrefix?: string): string {
	if (isApprovalRequest(request)) {
		const status = inputResponseIsDenial(response) ? "rejected" : "approved";
		const titlePrefix = approvalTitlePrefix ?? `Tool: ${request.action.toolName}`;
		return [`**${titlePrefix} - ${status}**`, "", `${formatInputRequestBody(request)}\n\nanswer: ${formatInputResponseValue(response)}`].join("\n");
	}
	return [`**Input answered**`, "", `${formatInputRequestBody(request)}\n\nanswer: ${formatInputResponseValue(response)}`].join("\n");
}

function formatOrphanInputResponseBlock(response: InputResponse): string {
	return [`**Input answered**`, "", `${response.requestId}: ${formatInputResponseValue(response)}`].join("\n");
}

function formatInputRequestBody(request: InputRequest): string {
	const optionsText =
		request.options
			?.map((option) => {
				const description = option.description === undefined ? "" : ` - ${option.description}`;
				const style = option.style === undefined ? "" : ` (${option.style})`;
				return `  - ${option.id}: ${option.label}${style}${description}`;
			})
			.join("\n") ?? "  - freeform";
	const freeform = request.allowFreeform === true ? "\n  - freeform allowed" : "";
	return [`- ${request.display ?? "text"} request ${request.requestId}`, `  ${request.prompt}`, `${optionsText}${freeform}`].join("\n");
}

function formatInputResponseValue(response: InputResponse): string {
	return response.optionId ?? response.text ?? "(empty)";
}

function inputResponseIsDenial(response: InputResponse): boolean {
	const value = `${response.optionId ?? ""} ${response.text ?? ""}`;
	return /\b(deny|denied|reject|rejected|no|stop)\b/iu.test(value);
}

function isApprovalRequest(request: InputRequest): boolean {
	return request.display === "confirmation";
}

function formatSubagentBlock(name: string, status: "completed" | "failed" | "running", body: string): string {
	const cleanBody = body.trim().length === 0 ? "no output" : body.trim();
	return [`**Subagent: ${name} - ${status}**`, "", cleanBody].join("\n");
}

function formatSubagentCalledBody(event: SubagentCalledEvent): string {
	const lines = [`tool: ${event.data.toolName}`, `child session: ${event.data.childSessionId}`];
	if (event.data.remote?.url !== undefined) lines.push(`remote: ${event.data.remote.url}`);
	return lines.join("\n");
}

function subagentActionKey(parentCallId: string, actionCallId: string): string {
	return `subagent:${parentCallId}:tool:${actionCallId}`;
}

function subagentStreamKey(parentCallId: string, kind: "message" | "reasoning", turnId: string, stepIndex: number): string {
	return `subagent:${parentCallId}:${kind}:${turnId}:${stepIndex}`;
}

function actionOutcome(result: ActionResult, status: ActionResultStatus): string {
	if (status === "rejected") return "rejected";
	if (status === "failed" || result.isError === true) return "failed";
	return "completed";
}

function summarizeToolArgs(input: unknown): string {
	if (!isRecord(input)) return summarizeJsonValue(input);
	const entries = Object.entries(input);
	if (entries.length === 0) return "";
	return truncateInline(entries
		.slice(0, 4)
		.map(([key, value]) => `${key}=${summarizeJsonValue(value)}`)
		.join("  "), 68);
}

function summarizeToolResult(output: unknown): string {
	if (isRecord(output)) {
		for (const key of ["stdout", "text", "message", "result", "error", "stderr"]) {
			const value = output[key];
			if (typeof value === "string" && value.trim().length > 0) return truncateInline(value.trim().replace(/\s+/gu, " "), 68);
		}
		const keys = Object.keys(output);
		return keys.length === 0 ? "{}" : `{${keys.slice(0, 5).join(", ")}}`;
	}
	return summarizeJsonValue(output);
}

function summarizeJsonValue(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(truncateInline(value.replace(/\s+/gu, " "), 64));
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return `[${value.length}]`;
	if (isRecord(value)) {
		const keys = Object.keys(value);
		return keys.length === 0 ? "{}" : `{${keys.slice(0, 4).join(", ")}}`;
	}
	return String(value);
}

function truncateInline(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatJsonBlock(value: unknown, maxChars = JSON_BLOCK_MAX_CHARS): string {
	const json = JSON.stringify(value, null, 2) ?? String(value);
	return truncateLongCodeLines(truncate(json, maxChars), MAX_CODE_BLOCK_LINE_CHARS);
}

function actionRequestName(action: ActionRequest): string {
	switch (action.kind) {
		case "tool-call":
			return action.toolName;
		case "subagent-call":
			return action.subagentName;
		case "remote-agent-call":
			return action.remoteAgentName;
		case "load-skill":
			return "load_skill";
	}
}

function actionResultName(result: ActionResult): string {
	switch (result.kind) {
		case "tool-result":
			return result.toolName;
		case "subagent-result":
			return result.subagentName;
		case "load-skill-result":
			return result.name ?? "load_skill";
	}
}

function mergeUsage(current: StepUsage | undefined, next: StepUsage | undefined): StepUsage | undefined {
	if (next === undefined) return current;
	return {
		cacheReadTokens: (current?.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0),
		cacheWriteTokens: (current?.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0),
		inputTokens: next.inputTokens ?? current?.inputTokens ?? 0,
		outputTokens: (current?.outputTokens ?? 0) + (next.outputTokens ?? 0),
	};
}

function formatAuthorizationChallenge(event: AuthorizationRequiredEvent): string {
	const challenge = event.data.authorization;
	const displayName = challenge?.displayName ?? event.data.name;
	const lines = [`${displayName}: ${event.data.description}`];
	if (challenge?.url !== undefined) lines.push(`url: ${challenge.url}`);
	if (challenge?.userCode !== undefined) lines.push(`code: ${challenge.userCode}`);
	if (challenge?.expiresAt !== undefined) lines.push(`expires: ${challenge.expiresAt}`);
	if (challenge?.instructions !== undefined) lines.push(challenge.instructions);
	return lines.join("\n");
}

function formatAuthorizationCompletion(event: AuthorizationCompletedEvent): string {
	const displayName = event.data.authorization?.displayName ?? event.data.name;
	const reason = event.data.reason === undefined ? "" : `\nreason: ${event.data.reason}`;
	return `${displayName}${reason}`;
}

function failureBlockKey(event: FailureEvent): string {
	return `${event.type}:${event.data.code}:${event.data.message}`;
}

function failureTitle(event: FailureEvent): string {
	switch (event.type) {
		case "session.failed":
			return "Session failed";
		case "step.failed":
			return "Step failed";
		case "turn.failed":
			return "Turn failed";
	}
}

function formatFailureEvent(event: FailureEvent): string {
	const detail = failureDetail(event);
	return detail === undefined ? `${event.data.code}: ${event.data.message}` : `${event.data.code}: ${event.data.message}\n${detail}`;
}

function failureDetail(event: FailureEvent): string | undefined {
	const details = event.data.details;
	if (!isRecord(details)) return undefined;
	const detail = details.detail;
	return typeof detail === "string" && detail.trim().length > 0 ? detail : undefined;
}

function summarizeNames(names: readonly string[]): string {
	const counts = new Map<string, number>();
	for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
	return [...counts.entries()].map(([name, count]) => (count === 1 ? name : `${name} x${count}`)).join(", ");
}

function formatCompactAmount(value: number): string {
	return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/u, "");
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n... truncated ${text.length - maxChars} chars`;
}

function truncateLongCodeLines(text: string, maxLineChars: number): string {
	return text
		.split("\n")
		.map((line) => {
			if (line.length <= maxLineChars) return line;
			return `${line.slice(0, Math.max(0, maxLineChars - 3))}...`;
		})
		.join("\n");
}

function sanitizeTerminalText(text: string): string {
	return text
		.replace(/\r\n?/gu, "\n")
		.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\x1B\\))/gu, "")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "");
}
