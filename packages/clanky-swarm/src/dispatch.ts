import type { SwarmLeaderState, SwarmLeaderStatus } from "./lifecycle.ts";

export const SWARM_DISPATCH_TYPES = ["implement", "fix", "review", "research"] as const;

export type SwarmDispatchType = (typeof SWARM_DISPATCH_TYPES)[number];

export interface SwarmDispatchInput {
	title: string;
	type: SwarmDispatchType;
	description: string;
	files?: string[];
	spawn?: boolean;
	waitForCompletion?: boolean;
	provider?: string;
	model?: string;
	linearIssue?: string;
	idempotencyKey?: string;
}

export interface SwarmDispatchRequest {
	title: string;
	type: SwarmDispatchType;
	description: string;
	files: string[];
	spawn: boolean;
	waitForCompletion: boolean;
	provider?: string;
	model?: string;
	linearIssue?: string;
	idempotencyKey?: string;
}

export interface SwarmDispatchResult {
	ok: boolean;
	state: SwarmLeaderState;
	message: string;
	status: SwarmLeaderStatus;
	request: SwarmDispatchRequest;
	response?: unknown;
	taskId?: string;
	dispatchStatus?: string;
}

export function isSwarmDispatchType(value: unknown): value is SwarmDispatchType {
	return typeof value === "string" && SWARM_DISPATCH_TYPES.includes(value as SwarmDispatchType);
}

export function normalizeSwarmDispatchInput(input: SwarmDispatchInput): SwarmDispatchRequest {
	const request: SwarmDispatchRequest = {
		title: input.title,
		type: input.type,
		description: input.description,
		files: input.files ?? [],
		spawn: input.spawn ?? true,
		waitForCompletion: input.waitForCompletion ?? false,
	};
	if (input.provider !== undefined) request.provider = input.provider;
	if (input.model !== undefined) request.model = input.model;
	if (input.linearIssue !== undefined) request.linearIssue = input.linearIssue;
	if (input.idempotencyKey !== undefined) request.idempotencyKey = input.idempotencyKey;
	return request;
}
