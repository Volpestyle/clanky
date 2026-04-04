/**
 * Stdio MCP server entry point.
 * For Clanky's runtime HTTP integration, use http-server.ts instead.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolRequest } from "@modelcontextprotocol/sdk/types.js";

import { MinecraftBotController } from "./minecraftBot.js";
import { TOOL_DEFINITIONS, dispatchToolCall } from "./tools.js";
import { log, logError } from "./logger.js";

const controller = new MinecraftBotController();

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function ok(value: unknown) {
  return {
    content: [{ type: "text" as const, text: pretty(value) }]
  };
}

function failure(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }]
  };
}

async function handleToolCall(request: CallToolRequest) {
  const result = await dispatchToolCall(
    controller,
    request.params.name,
    request.params.arguments
  );
  return ok(result.output);
}

const server = new Server(
  { name: "clanky-minecraft-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOL_DEFINITIONS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    return await handleToolCall(request);
  } catch (error) {
    logError("tool call failed", error);
    return failure(error instanceof Error ? error.message : String(error));
  }
});

server.onerror = (error) => {
  logError("mcp server error", error);
};

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("info", "clanky-minecraft-mcp started (stdio)");
}

process.on("SIGINT", async () => {
  try { await controller.disconnect("SIGINT"); } catch (error) { logError("disconnect during SIGINT failed", error); }
  process.exit(0);
});

process.on("SIGTERM", async () => {
  try { await controller.disconnect("SIGTERM"); } catch (error) { logError("disconnect during SIGTERM failed", error); }
  process.exit(0);
});

void main().catch((error) => {
  logError("fatal startup error", error);
  process.exit(1);
});
