export type ClankyChatGatewayOwner = "agent" | "off";
export type ClankyChatMode = "agent-owned" | "off";

export function resolveClankyChatGatewayOwner(env: NodeJS.ProcessEnv = process.env): ClankyChatGatewayOwner {
	const configured = env.CLANKY_CHAT_GATEWAY_OWNER?.trim().toLowerCase();
	if (configured === "agent" || configured === "off") return configured;
	if (env.CLANKY_DISABLE_CHAT_GATEWAY === "1" || env.CLANKY_DISABLE_CHAT_GATEWAY === "true") return "off";
	return "agent";
}

export function resolveClankyChatMode(env: NodeJS.ProcessEnv = process.env): ClankyChatMode {
	return resolveClankyChatGatewayOwner(env) === "off" ? "off" : "agent-owned";
}

export function shouldStartAgentChatGateway(env: NodeJS.ProcessEnv = process.env): boolean {
	return resolveClankyChatGatewayOwner(env) === "agent";
}

export function shouldStartStandaloneChatGateway(env: NodeJS.ProcessEnv = process.env): boolean {
	return shouldStartAgentChatGateway(env);
}
