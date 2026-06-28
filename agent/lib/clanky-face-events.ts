/**
 * Event-derived type aliases shared by the Clanky face renderer and its pure
 * markdown formatters. Extracted from clanky-face-renderer.ts.
 */
import type { HandleMessageStreamEvent } from "eve/client";

export type StepUsage = NonNullable<Extract<HandleMessageStreamEvent, { type: "step.completed" }>["data"]["usage"]>;

export type ActionRequest = Extract<HandleMessageStreamEvent, { type: "actions.requested" }>["data"]["actions"][number];
export type ActionResult = Extract<HandleMessageStreamEvent, { type: "action.result" }>["data"]["result"];
export type ActionResultError = Extract<HandleMessageStreamEvent, { type: "action.result" }>["data"]["error"];
export type ActionResultStatus = Extract<HandleMessageStreamEvent, { type: "action.result" }>["data"]["status"];
export type AuthorizationCompletedEvent = Extract<HandleMessageStreamEvent, { type: "authorization.completed" }>;
export type AuthorizationRequiredEvent = Extract<HandleMessageStreamEvent, { type: "authorization.required" }>;
export type FailureEvent =
	| Extract<HandleMessageStreamEvent, { type: "session.failed" }>
	| Extract<HandleMessageStreamEvent, { type: "step.failed" }>
	| Extract<HandleMessageStreamEvent, { type: "turn.failed" }>;
export type SubagentCalledEvent = Extract<HandleMessageStreamEvent, { type: "subagent.called" }>;

export type TurnStats = {
	assistantTextChars: number;
	reasoningTextChars: number;
	sawAssistantText: boolean;
	sawInputRequest: boolean;
	stepFinishes: number;
	stepStarts: number;
	toolCalls: string[];
	toolResults: string[];
};
