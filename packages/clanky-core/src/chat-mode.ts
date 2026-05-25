export type ClankyChatMode = "standalone" | "enrolled";

export function isAgentRoomEnrolled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.AGENTROOM === "1";
}

export function resolveClankyChatMode(env: NodeJS.ProcessEnv = process.env): ClankyChatMode {
	return isAgentRoomEnrolled(env) ? "enrolled" : "standalone";
}

export function shouldStartStandaloneChatGateway(env: NodeJS.ProcessEnv = process.env): boolean {
	return resolveClankyChatMode(env) === "standalone";
}
