import type { ChatMode, ChatSessionMapping } from "./sessions-store.ts";
import type { MessageEvent } from "./types.ts";

export type PolicyDecision =
	| { type: "allow"; mode?: ChatMode }
	| { type: "ignore"; reason: string }
	| { type: "reject"; reason: string; replyText?: string }
	| { type: "confirm"; replyText: string; pendingId: string };

export interface PolicyContext {
	event: MessageEvent;
	mapping: ChatSessionMapping | undefined;
}

export interface MessagingPolicyGate {
	evaluate(context: PolicyContext): Promise<PolicyDecision> | PolicyDecision;
}

export interface InboundMemoryRecord {
	event: MessageEvent;
	mapping: ChatSessionMapping;
}

export interface OutboundMemoryRecord {
	event: MessageEvent;
	mapping: ChatSessionMapping;
	replyText: string;
	replyMessageIds: string[];
	durationMs: number;
}

export interface MemoryWriter {
	recordInbound(record: InboundMemoryRecord): Promise<void> | void;
	recordOutbound(record: OutboundMemoryRecord): Promise<void> | void;
}

export interface MemoryRetriever {
	buildContext(event: MessageEvent, mapping: ChatSessionMapping): Promise<string | undefined> | string | undefined;
}

export class PassThroughPolicyGate implements MessagingPolicyGate {
	evaluate(): PolicyDecision {
		return { type: "allow" };
	}
}

export class NoopMemoryWriter implements MemoryWriter {
	recordInbound(): void {
		// no-op
	}
	recordOutbound(): void {
		// no-op
	}
}

export class NoopMemoryRetriever implements MemoryRetriever {
	buildContext(): undefined {
		return undefined;
	}
}
