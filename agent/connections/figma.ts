import { defineMcpClientConnection } from "eve/connections";
import { always } from "eve/tools/approval";
import { defineMcpOAuthAuthorization } from "../lib/mcp-oauth.ts";

const FIGMA_MCP_URL = process.env.CLANKY_FIGMA_MCP_URL?.trim() || "https://mcp.figma.com/mcp";

export default defineMcpClientConnection({
	url: FIGMA_MCP_URL,
	description:
		"Figma workspace connection for design files, components, variables, FigJam, visual references, and native Figma canvas updates. Use this instead of dynamic MCP for Figma.",
	auth: defineMcpOAuthAuthorization({
		connectionName: "figma",
		serverUrl: FIGMA_MCP_URL,
		displayName: "Figma",
		clientName: "Clanky Figma MCP",
		clientMetadataUrlEnv: "CLANKY_FIGMA_MCP_CLIENT_METADATA_URL",
	}),
	approval: always(),
});
