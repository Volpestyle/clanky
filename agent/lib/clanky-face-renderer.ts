import type { HandleMessageStreamEvent, InputRequest, InputResponse } from "eve/client";
import { NoReplyTracker, NO_ASSISTANT_REPLY_NOTICE } from "./tui-no-reply.ts";
import type {
	ActionRequest,
	ActionResult,
	ActionResultError,
	ActionResultStatus,
	AuthorizationCompletedEvent,
	AuthorizationRequiredEvent,
	FailureEvent,
	StepUsage,
} from "./clanky-face-events.ts";
export type { StepUsage } from "./clanky-face-events.ts";
import {
	actionOutcome,
	actionRequestName,
	actionResultName,
	createEmptyTurnStats,
	failureBlockKey,
	failureTitle,
	formatActionRequestBlock,
	formatActionResultBlock,
	formatAuthorizationChallenge,
	formatAuthorizationCompletion,
	formatCompactAmount,
	formatFailureEvent,
	formatInputRequestBlock,
	formatInputRequestBody,
	formatInputResponseBlock,
	formatJsonBlock,
	formatOrphanInputResponseBlock,
	formatSubagentBlock,
	formatSubagentCalledBody,
	formatTurnStats,
	isApprovalRequest,
	isSkillLoadRequest,
	isSkillLoadResult,
	mergeUsage,
	sanitizeTerminalText,
	subagentActionKey,
	subagentStreamKey,
} from "./clanky-face-format.ts";

export type FaceBlockHandle = {
	remove?(): void;
	setMarkdown(markdown: string): void;
};

export type FaceBlockOptions = {
	readonly clickToggle?: boolean;
	readonly collapsed?: boolean;
	readonly collapsible?: boolean;
};

export type FaceRenderSink = {
	insertMarkdown(markdown: string, options?: FaceBlockOptions): FaceBlockHandle;
	setLoaderMessage(message: string): void;
	setStatus(message: string): void;
};

export type FaceRenderEventResult = {
	inputRequests: readonly InputRequest[];
	terminal: boolean;
};

export type FaceStatusLabel = "failed" | "ready" | "streaming";

export function statusLabelForFaceEvent(event: HandleMessageStreamEvent): FaceStatusLabel {
	switch (event.type) {
		case "session.completed":
		case "session.waiting":
		case "turn.completed":
			return "ready";
		case "session.failed":
		case "step.failed":
		case "turn.failed":
			return "failed";
		default:
			return "streaming";
	}
}

const STREAM_RENDER_THROTTLE_MS = 50;
const COLLAPSED_TOOL_BLOCK_OPTIONS: FaceBlockOptions = { clickToggle: true, collapsed: true };

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
	private readonly actionInputsByBlockKey = new Map<string, unknown>();
	private readonly actionNamesByBlockKey = new Map<string, string>();
	private readonly authorizationBlocksByName = new Map<string, FaceBlockHandle>();
	private readonly failureBlocksByKey = new Map<string, FaceBlockHandle>();
	private readonly inputApprovalTitlePrefixByRequestId = new Map<string, string>();
	private readonly inputBlocksByRequestId = new Map<string, FaceBlockHandle>();
	private readonly inputRequestsByRequestId = new Map<string, InputRequest>();
	private readonly subagentBlocksByCallId = new Map<string, FaceBlockHandle>();
	private readonly subagentBodyByCallId = new Map<string, string>();
	private readonly subagentHasVisibleChildContentByCallId = new Map<string, boolean>();
	private readonly subagentMessageBlocksByKey = new Map<string, FaceBlockHandle>();
	private readonly pendingSubagentStreamUpdatesByKey = new Map<string, { block: FaceBlockHandle; markdown: string }>();
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
		this.actionInputsByBlockKey.clear();
		this.actionNamesByBlockKey.clear();
		this.authorizationBlocksByName.clear();
		this.failureBlocksByKey.clear();
		this.inputApprovalTitlePrefixByRequestId.clear();
		this.inputBlocksByRequestId.clear();
		this.inputRequestsByRequestId.clear();
		this.subagentBlocksByCallId.clear();
		this.subagentBodyByCallId.clear();
		this.subagentHasVisibleChildContentByCallId.clear();
		this.subagentMessageBlocksByKey.clear();
		this.pendingSubagentStreamUpdatesByKey.clear();
		this.subagentReasoningBlocksByKey.clear();
		this.subagentStreamTextByKey.clear();
		this.noReply = new NoReplyTracker();
		this.stats = createEmptyTurnStats();
	}

	renderEvent(event: HandleMessageStreamEvent): FaceRenderEventResult {
		this.recordEvent(event);
		this.noReply.observe(event);
		this.sink.setStatus(statusLabelForFaceEvent(event));
		let inputRequests: readonly InputRequest[] = [];
		let terminal = false;

		switch (event.type) {
			case "session.started":
				break;
			case "turn.started":
				break;
			case "message.received":
				break;
			case "step.started":
				this.closeStreamingBlocks();
				this.stats.stepStarts += 1;
				this.sink.setLoaderMessage(`Step ${event.data.stepIndex + 1} running...`);
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
				this.stats.toolResults.push(this.actionNameForResult(event.data.result));
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
				break;
			case "step.failed":
				this.upsertFailureBlock(event);
				break;
			case "turn.completed":
				this.flushPendingStreamUpdates();
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
				terminal = true;
				break;
			case "session.completed":
				this.flushPendingStreamUpdates();
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
		this.actionInputsByBlockKey.set(action.callId, action.input);
		const name = actionRequestName(action);
		this.actionNamesByBlockKey.set(action.callId, name);
		const title = isSkillLoadRequest(action) ? `Skill: ${name} - running` : `Tool: ${name} - running`;
		const block = this.sink.insertMarkdown(sanitizeTerminalText(formatActionRequestBlock(action, title)), COLLAPSED_TOOL_BLOCK_OPTIONS);
		this.actionBlocksByCallId.set(action.callId, block);
	}

	private upsertActionResult(result: ActionResult, status: ActionResultStatus, error: ActionResultError): void {
		this.closeStreamingBlocks();
		const outcome = actionOutcome(result, status);
		const kind = isSkillLoadResult(result) ? "Skill" : "Tool";
		const markdown = formatActionResultBlock(
			result,
			status,
			error,
			`${kind}: ${this.actionNameForResult(result)} - ${outcome}`,
			this.actionInputsByBlockKey.get(result.callId),
		);
		const block = this.actionBlocksByCallId.get(result.callId);
		if (block === undefined) {
			this.sink.insertMarkdown(sanitizeTerminalText(markdown), COLLAPSED_TOOL_BLOCK_OPTIONS);
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
				this.stats.toolResults.push(`${subagentName}/${this.actionNameForResult(childEvent.data.result, subagentActionKey(parentCallId, childEvent.data.result.callId))}`);
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
		const actionKey = subagentActionKey(parentCallId, action.callId);
		this.actionInputsByBlockKey.set(actionKey, action.input);
		this.actionNamesByBlockKey.set(actionKey, actionRequestName(action));
		const block = this.sink.insertMarkdown(
			sanitizeTerminalText(formatActionRequestBlock(action, `Subagent tool: ${subagentName} / ${actionRequestName(action)} - running`)),
			COLLAPSED_TOOL_BLOCK_OPTIONS,
		);
		this.actionBlocksByCallId.set(actionKey, block);
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
		const actionKey = subagentActionKey(parentCallId, result.callId);
		const markdown = formatActionResultBlock(
			result,
			status,
			error,
			`Subagent tool: ${subagentName} / ${this.actionNameForResult(result, actionKey)} - ${outcome}`,
			this.actionInputsByBlockKey.get(actionKey),
		);
		const block = this.actionBlocksByCallId.get(actionKey);
		if (block === undefined) {
			this.sink.insertMarkdown(sanitizeTerminalText(markdown), COLLAPSED_TOOL_BLOCK_OPTIONS);
			return;
		}
		block.setMarkdown(sanitizeTerminalText(markdown));
	}

	private actionNameForResult(result: ActionResult, blockKey = result.callId): string {
		return this.actionNamesByBlockKey.get(blockKey) ?? actionResultName(result);
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
		const markdown = sanitizeTerminalText(`**Subagent ${kind === "message" ? "step" : "reasoning"}: ${subagentName}**\n\n${text}`);
		const blocks = kind === "message" ? this.subagentMessageBlocksByKey : this.subagentReasoningBlocksByKey;
		const block = blocks.get(key);
		if (block === undefined) {
			this.closeStreamingBlocks();
			blocks.set(key, this.sink.insertMarkdown(markdown));
			return;
		}
		this.pendingSubagentStreamUpdatesByKey.set(key, { block, markdown });
		this.scheduleStreamFlush();
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
		for (const { block, markdown } of this.pendingSubagentStreamUpdatesByKey.values()) {
			block.setMarkdown(markdown);
		}
		this.pendingAssistantMarkdown = undefined;
		this.pendingReasoningMarkdown = undefined;
		this.pendingSubagentStreamUpdatesByKey.clear();
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
