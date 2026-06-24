import figmaConnection from "../connections/figma.ts";
import linearConnection from "../connections/linear.ts";

const CURATED_MCP_CONNECTIONS = {
	figma: figmaConnection,
	linear: linearConnection,
} as const;

export function authoredMcpConnectionHasAuthorization(connectionName: string): boolean {
	return CURATED_MCP_CONNECTIONS[connectionName as keyof typeof CURATED_MCP_CONNECTIONS]?.auth !== undefined;
}

export function authoredMcpConnectionHasApproval(connectionName: string): boolean {
	return CURATED_MCP_CONNECTIONS[connectionName as keyof typeof CURATED_MCP_CONNECTIONS]?.approval !== undefined;
}
