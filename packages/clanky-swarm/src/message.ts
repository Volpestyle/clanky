import type { SwarmLeaderState, SwarmLeaderStatus } from "./lifecycle.ts";

export interface SwarmMessageInput {
	recipient: string;
	message: string;
	taskId?: string;
	nudge?: boolean;
	force?: boolean;
}

export interface SwarmMessageRequest {
	recipient: string;
	message: string;
	taskId?: string;
	nudge: boolean;
	force: boolean;
}

export interface SwarmMessageResult {
	ok: boolean;
	state: SwarmLeaderState;
	message: string;
	status: SwarmLeaderStatus;
	request: SwarmMessageRequest;
	response?: unknown;
}

export function normalizeSwarmMessageInput(input: SwarmMessageInput): SwarmMessageRequest {
	const recipient = input.recipient.trim();
	if (recipient.length === 0) throw new Error("Swarm message recipient must be a non-empty string");
	const message = input.message.trim();
	if (message.length === 0) throw new Error("Swarm message content must be a non-empty string");
	const request: SwarmMessageRequest = {
		recipient,
		message,
		nudge: input.nudge ?? true,
		force: input.force ?? false,
	};
	if (input.taskId !== undefined) {
		const taskId = input.taskId.trim();
		if (taskId.length === 0) throw new Error("Swarm message taskId must be a non-empty string");
		request.taskId = taskId;
	}
	return request;
}
