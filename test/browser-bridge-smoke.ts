import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { browserControlNeedsApproval } from "../agent/tools/browser_control.ts";
import { browserSnapshot } from "../packages/clanky-browser-bridge/src/client.ts";
import { installBrowserBridge } from "../packages/clanky-browser-bridge/src/install.ts";
import { resolveBrowserBridgePaths } from "../packages/clanky-browser-bridge/src/paths.ts";
import { startBrowserBridgeServer } from "../packages/clanky-browser-bridge/src/server.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mode(value: number): number {
	return value & 0o777;
}

async function allocatePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				server.close();
				reject(new Error("failed to allocate TCP port"));
				return;
			}
			const port = address.port;
			server.close((error) => {
				if (error) reject(error);
				else resolve(port);
			});
		});
	});
}

function waitForOpen(ws: WebSocket): Promise<void> {
	return new Promise((resolve, reject) => {
		ws.once("open", () => resolve());
		ws.once("error", reject);
	});
}

function readSocketMessage(ws: WebSocket): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		ws.once("error", reject);
		ws.once("message", (data) => {
			try {
				const parsed = JSON.parse(data.toString()) as unknown;
				if (!isRecord(parsed)) {
					reject(new Error("websocket message was not an object"));
					return;
				}
				resolve(parsed);
			} catch (error) {
				reject(error);
			}
		});
	});
}

const home = await mkdtemp(join(tmpdir(), "clanky-browser-bridge-"));
const port = await allocatePort();
const env = { ...process.env, CLANKY_BROWSER_BRIDGE_PORT: String(port) };
let shutdown: (() => Promise<void>) | undefined;
let ws: WebSocket | undefined;

try {
	const installed = await installBrowserBridge({ homeDir: home, env });
	const paths = resolveBrowserBridgePaths({ homeDir: home, env });
	assert(installed.port === port, "browser bridge installer did not use configured port");
	assert(installed.extensionDir === paths.extensionDir, "browser bridge installer returned wrong extension dir");
	assert(mode((await stat(paths.bridgeDir)).mode) === 0o700, "browser bridge dir mode is not 0700");
	assert(mode((await stat(paths.extensionDir)).mode) === 0o700, "browser bridge extension dir mode is not 0700");
	assert(mode((await stat(paths.configFile)).mode) === 0o600, "browser bridge config file mode is not 0600");
	assert(mode((await stat(paths.extensionConfigFile)).mode) === 0o600, "browser bridge extension config file mode is not 0600");
	assert(mode((await stat(paths.extensionKeyFile)).mode) === 0o600, "browser bridge extension key mode is not 0600");
	const manifest = JSON.parse(await readFile(join(paths.extensionDir, "manifest.json"), "utf8")) as unknown;
	assert(isRecord(manifest) && typeof manifest.key === "string", "browser bridge manifest did not include stable extension key");
	const config = JSON.parse(await readFile(paths.configFile, "utf8")) as unknown;
	assert(isRecord(config) && config.port === port && typeof config.token === "string", "browser bridge config shape wrong");
	const token = config.token;

	shutdown = await startBrowserBridgeServer({ homeDir: home, env, host: "127.0.0.1" });
	assert(mode((await stat(paths.stateFile)).mode) === 0o600, "browser bridge state file mode is not 0600");
	const initialHealth = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json() as unknown;
	assert(isRecord(initialHealth) && initialHealth.ok === true, "browser bridge health route failed");
	assert(initialHealth.connectionCount === 0, "browser bridge should start with no extension connection");

	ws = new WebSocket(`ws://127.0.0.1:${port}/agent?token=${encodeURIComponent(token)}`);
	await waitForOpen(ws);
	ws.send(JSON.stringify({ type: "hello", browser: "smoke", version: "0.8.0" }));
	const requestPromise = readSocketMessage(ws);
	const responsePromise = fetch(`http://127.0.0.1:${port}/tabs/list`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-clanky-token": token },
		body: "{}",
	});
	const request = await requestPromise;
	assert(request.op === "list_tabs", "browser bridge did not dispatch list_tabs to extension");
	assert(typeof request.id === "number", "browser bridge dispatched request without numeric id");
	ws.send(
		JSON.stringify({
			id: request.id,
			ok: true,
			result: { tabs: [{ tabId: 1, url: "https://example.test/", title: "Example", active: true, windowId: 7 }] },
		}),
	);
	const response = await responsePromise;
	assert(response.ok, "browser bridge HTTP route did not return ok");
	const listed = await response.json() as unknown;
	assert(isRecord(listed) && Array.isArray(listed.tabs) && listed.tabs.length === 1, "browser bridge list_tabs result wrong");

	const snapshotRequestPromise = readSocketMessage(ws);
	const snapshotPromise = browserSnapshot({ tabId: 1, maxTextChars: 123, maxLinks: 2, maxMedia: 3, maxElements: 4 }, { homeDir: home, env });
	const snapshotRequest = await snapshotRequestPromise;
	assert(snapshotRequest.op === "snapshot", "browser bridge did not dispatch snapshot to extension");
	assert(snapshotRequest.tabId === 1, "browser bridge snapshot lost tabId");
	assert(snapshotRequest.maxTextChars === 123, "browser bridge snapshot lost maxTextChars");
	assert(snapshotRequest.maxLinks === 2, "browser bridge snapshot lost maxLinks");
	assert(snapshotRequest.maxMedia === 3, "browser bridge snapshot lost maxMedia");
	assert(snapshotRequest.maxElements === 4, "browser bridge snapshot lost maxElements");
	ws.send(
		JSON.stringify({
			id: snapshotRequest.id,
			ok: true,
			result: {
				tabId: 1,
				url: "https://example.test/form",
				title: "Example Form",
				text: "Submit the form",
				length: 15,
				truncated: false,
				viewport: { width: 800, height: 600, devicePixelRatio: 1, scrollX: 0, scrollY: 0 },
				links: [{ text: "Docs", url: "https://example.test/docs" }],
				media: [{ kind: "image", url: "https://example.test/a.png", alt: "A" }],
				elements: [
					{
						tag: "button",
						selector: "button",
						role: null,
						type: null,
						label: "Submit",
						text: "Submit",
						value: null,
						checked: null,
						disabled: false,
						href: null,
						visible: true,
						inViewport: true,
						rect: { x: 10, y: 20, width: 80, height: 30, centerX: 50, centerY: 35 },
					},
				],
				counts: { links: 1, media: 1, elements: 1 },
			},
		}),
	);
	const snapshot = await snapshotPromise;
	assert(snapshot.title === "Example Form", "browser snapshot client parsed title wrong");
	assert(snapshot.links[0]?.url === "https://example.test/docs", "browser snapshot client parsed links wrong");
	assert(snapshot.elements[0]?.rect.centerX === 50, "browser snapshot client parsed element rect wrong");

	assert(
		!browserControlNeedsApproval({ toolName: "browser_control", approvedTools: new Set(), toolInput: { op: "status" } }),
		"browser status should not require approval",
	);
	assert(
		!browserControlNeedsApproval({ toolName: "browser_control", approvedTools: new Set(), toolInput: { op: "read_text" } }),
		"browser read_text should not require approval",
	);
	assert(
		!browserControlNeedsApproval({ toolName: "browser_control", approvedTools: new Set(), toolInput: { op: "snapshot" } }),
		"browser snapshot should not require approval",
	);
	assert(
		browserControlNeedsApproval({ toolName: "browser_control", approvedTools: new Set(), toolInput: { op: "click" } }),
		"browser click should require approval before first browser-control approval",
	);
	assert(
		!browserControlNeedsApproval({
			toolName: "browser_control",
			approvedTools: new Set(["browser_control"]),
			toolInput: { op: "click" },
		}),
		"browser click should not require approval after browser_control is approved in-session",
	);
} finally {
	if (ws !== undefined && ws.readyState !== WebSocket.CLOSED) ws.close();
	if (shutdown !== undefined) await shutdown();
	await rm(home, { recursive: true, force: true });
}
