/**
 * HTTP wrapper for the Minecraft MCP tools.
 *
 * Clanky's voice MCP pipeline expects an HTTP server at baseUrl + toolPath
 * that accepts POST { toolName, arguments } and returns JSON.
 *
 * This bridges that contract to the same MinecraftBotController used by
 * the stdio MCP server.
 *
 * Usage:
 *   node dist/http-server.js
 *   # or dev mode:
 *   npx tsx src/http-server.ts
 *
 * Environment:
 *   MC_HTTP_PORT  - HTTP listen port (default: 3847)
 *   MC_HTTP_HOST  - HTTP listen host (default: 127.0.0.1)
 *   MC_*          - Minecraft connection defaults (same as stdio server)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { MinecraftBotController } from "./minecraftBot.js";
import { TOOL_DEFINITIONS, dispatchToolCall } from "./tools.js";
import { log, logError } from "./logger.js";

const controller = new MinecraftBotController();

const HTTP_PORT = Number(process.env.MC_HTTP_PORT) || 3847;
const HTTP_HOST = process.env.MC_HTTP_HOST || "127.0.0.1";

function jsonResponse(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

async function handleToolsCall(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") {
    jsonResponse(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  let body: { toolName?: string; arguments?: Record<string, unknown> };
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    jsonResponse(res, 400, { ok: false, error: "Invalid JSON body" });
    return;
  }

  const toolName = String(body?.toolName || "").trim();
  if (!toolName) {
    jsonResponse(res, 400, { ok: false, error: "Missing toolName" });
    return;
  }

  log("info", `tool call: ${toolName}`, body.arguments);

  try {
    const result = await dispatchToolCall(controller, toolName, body.arguments ?? {});
    jsonResponse(res, 200, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError(`tool call failed: ${toolName}`, error);
    jsonResponse(res, 200, { ok: false, error: message });
  }
}

function handleToolsList(_req: IncomingMessage, res: ServerResponse) {
  jsonResponse(res, 200, {
    ok: true,
    tools: TOOL_DEFINITIONS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema
    }))
  });
}

function handleHealth(_req: IncomingMessage, res: ServerResponse) {
  const status = controller.status();
  jsonResponse(res, 200, {
    ok: true,
    connected: status.connected,
    task: status.task ?? "idle"
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  try {
    switch (path) {
      case "/tools/call":
        await handleToolsCall(req, res);
        break;
      case "/tools/list":
        handleToolsList(req, res);
        break;
      case "/health":
        handleHealth(req, res);
        break;
      default:
        jsonResponse(res, 404, { ok: false, error: "Not found" });
    }
  } catch (error) {
    logError("unhandled request error", error);
    jsonResponse(res, 500, { ok: false, error: "Internal server error" });
  }
});

server.listen(HTTP_PORT, HTTP_HOST, () => {
  log("info", `minecraft MCP HTTP server listening on http://${HTTP_HOST}:${HTTP_PORT}`);
  log("info", "endpoints: POST /tools/call, GET /tools/list, GET /health");
});

process.on("SIGINT", async () => {
  log("info", "SIGINT received, shutting down");
  try { await controller.disconnect("SIGINT"); } catch (error) { logError("disconnect during SIGINT failed", error); }
  server.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  log("info", "SIGTERM received, shutting down");
  try { await controller.disconnect("SIGTERM"); } catch (error) { logError("disconnect during SIGTERM failed", error); }
  server.close();
  process.exit(0);
});
