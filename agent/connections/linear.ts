import { defineMcpClientConnection } from "eve/connections";
import { always } from "eve/tools/approval";
import { defineMcpOAuthAuthorization } from "../lib/mcp-oauth.ts";

const LINEAR_MCP_URL = process.env.CLANKY_LINEAR_MCP_URL?.trim() || "https://mcp.linear.app/sse";

export default defineMcpClientConnection({
	url: LINEAR_MCP_URL,
	description:
		"Linear workspace connection for issues, projects, cycles, comments, statuses, and work-tracking follow-up. Use this instead of dynamic MCP for Linear.",
	auth: defineMcpOAuthAuthorization({
		connectionName: "linear",
		serverUrl: LINEAR_MCP_URL,
		displayName: "Linear",
		clientName: "Clanky Linear MCP",
		clientMetadataUrlEnv: "CLANKY_LINEAR_MCP_CLIENT_METADATA_URL",
	}),
	approval: always(),
});
