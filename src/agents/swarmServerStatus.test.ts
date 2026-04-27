import { afterEach, beforeEach, expect, test } from "bun:test";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  formatSwarmServerStatusLine,
  getSwarmServerStatus,
  swarmServerSocketExists
} from "./swarmServerStatus.ts";

let tempDir: string;
let originalSocketEnv: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "clanky-swarm-server-status-"));
  originalSocketEnv = process.env.SWARM_DB_PATH;
  process.env.SWARM_DB_PATH = path.join(tempDir, "swarm.db");
});

afterEach(() => {
  if (originalSocketEnv === undefined) {
    delete process.env.SWARM_DB_PATH;
  } else {
    process.env.SWARM_DB_PATH = originalSocketEnv;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

function listen(server: http.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

test("getSwarmServerStatus reports unavailable when socket is missing", async () => {
  const status = await getSwarmServerStatus(process.env.SWARM_DB_PATH);
  expect(status.available).toBe(false);
  expect(status.directSpawnSupported).toBe(false);
  expect(status.hint).toMatch(/swarm-server is not running/i);
  expect(swarmServerSocketExists(process.env.SWARM_DB_PATH)).toBe(false);
});

test("getSwarmServerStatus reports available and PTY-capable when /health advertises direct spawn", async () => {
  const dbPath = process.env.SWARM_DB_PATH!;
  const socketPath = path.join(path.dirname(dbPath), "server", "swarm-server.sock");
  mkdirSync(path.dirname(socketPath), { recursive: true });

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        v: 1,
        capabilities: ["pty.spawn.args", "pty.spawn.env", "pty.spawn.initial_input"]
      }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "not found" }));
  });

  await listen(server, socketPath);
  try {
    expect(swarmServerSocketExists(dbPath)).toBe(true);
    const status = await getSwarmServerStatus(dbPath);
    expect(status.available).toBe(true);
    expect(status.directSpawnSupported).toBe(true);
    expect(status.hint).toBeUndefined();
  } finally {
    await closeServer(server);
  }
});

test("getSwarmServerStatus warns when /health lacks direct PTY spawn capabilities", async () => {
  const dbPath = process.env.SWARM_DB_PATH!;
  const socketPath = path.join(path.dirname(dbPath), "server", "swarm-server.sock");
  mkdirSync(path.dirname(socketPath), { recursive: true });

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, v: 1 }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "not found" }));
  });

  await listen(server, socketPath);
  try {
    const status = await getSwarmServerStatus(dbPath);
    expect(status.available).toBe(true);
    expect(status.directSpawnSupported).toBe(false);
    expect(status.hint).toMatch(/does not advertise direct PTY spawn capabilities/i);
  } finally {
    await closeServer(server);
  }
});

test("getSwarmServerStatus reports stale-socket hint when /health rejects", async () => {
  const dbPath = process.env.SWARM_DB_PATH!;
  const socketPath = path.join(path.dirname(dbPath), "server", "swarm-server.sock");
  mkdirSync(path.dirname(socketPath), { recursive: true });

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "not found" }));
  });

  await listen(server, socketPath);
  try {
    const status = await getSwarmServerStatus(dbPath);
    expect(status.available).toBe(false);
    expect(status.directSpawnSupported).toBe(false);
    expect(status.hint).toMatch(/did not respond with a healthy/i);
  } finally {
    await closeServer(server);
  }
});

test("formatSwarmServerStatusLine renders both states cleanly", () => {
  const okLine = formatSwarmServerStatusLine({
    available: true,
    directSpawnSupported: true,
    socketPath: "/tmp/swarm-server.sock"
  });
  expect(okLine).toMatch(/running ✓/);
  expect(okLine).toMatch(/visible\/interactive/);

  const degradedLine = formatSwarmServerStatusLine({
    available: true,
    directSpawnSupported: false,
    socketPath: "/tmp/swarm-server.sock",
    hint: "Restart swarm-server."
  });
  expect(degradedLine).toMatch(/not PTY-spawn capable/i);
  expect(degradedLine).toMatch(/Restart swarm-server\./);

  const downLine = formatSwarmServerStatusLine({
    available: false,
    directSpawnSupported: false,
    socketPath: "/tmp/swarm-server.sock",
    hint: "swarm-server is not running. Start it."
  });
  expect(downLine).toMatch(/not running ✗/);
  expect(downLine).toMatch(/Start it\./);
});
