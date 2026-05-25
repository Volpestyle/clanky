export type ClankyChatGatewayOwner = "agent" | "room" | "off";
export type ClankyChatMode = "agent-owned" | "agent-owned-in-room" | "room-owned" | "off";

export function isAgentRoomEnrolled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.AGENTROOM === "1";
}

export function resolveClankyChatGatewayOwner(env: NodeJS.ProcessEnv = process.env): ClankyChatGatewayOwner {
	const configured = env.CLANKY_CHAT_GATEWAY_OWNER?.trim().toLowerCase();
	if (configured === "agent" || configured === "room" || configured === "off") return configured;
	if (env.CLANKY_DISABLE_CHAT_GATEWAY === "1" || env.CLANKY_DISABLE_CHAT_GATEWAY === "true") return "off";
	return "agent";
}

export function resolveClankyChatMode(env: NodeJS.ProcessEnv = process.env): ClankyChatMode {
	const owner = resolveClankyChatGatewayOwner(env);
	if (owner === "off") return "off";
	if (owner === "room") return "room-owned";
	return isAgentRoomEnrolled(env) ? "agent-owned-in-room" : "agent-owned";
}

export function shouldStartAgentChatGateway(env: NodeJS.ProcessEnv = process.env): boolean {
	return resolveClankyChatGatewayOwner(env) === "agent";
}

export function shouldStartStandaloneChatGateway(env: NodeJS.ProcessEnv = process.env): boolean {
	return shouldStartAgentChatGateway(env);
}
