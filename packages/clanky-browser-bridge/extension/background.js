// Clanky Browser Bridge — MV3 service worker.
// Maintains a WebSocket connection to a local Clanky helper daemon and
// executes commands the daemon forwards from Clanky tools.

const RECONNECT_DELAY_MS = 2000;
const ALARM_NAME = "clanky-bridge-tick";
let configPromise = null;
let ws = null;
let reconnectTimer = null;

function loadConfig() {
	if (configPromise === null) {
		configPromise = fetch(chrome.runtime.getURL("config.json"))
			.then((response) => response.json())
			.catch((error) => {
				configPromise = null;
				throw error;
			});
	}
	return configPromise;
}

function detectBrowser() {
	const ua = self.navigator?.userAgent || "";
	if (/Helium/i.test(ua)) return "helium";
	if (/Brave/i.test(ua)) return "brave";
	if (/Edg\//i.test(ua)) return "edge";
	if (/Chrome/i.test(ua)) return "chrome";
	return "chromium";
}

async function connect() {
	if (ws !== null && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
	let config;
	try {
		config = await loadConfig();
	} catch (error) {
		console.warn("[clanky-bridge] failed to load config.json:", error);
		scheduleReconnect();
		return;
	}
	const port = Number(config?.port);
	const token = String(config?.token ?? "");
	if (!Number.isInteger(port) || port <= 0 || token.length === 0) {
		console.warn("[clanky-bridge] config.json missing port or token");
		scheduleReconnect();
		return;
	}
	let socket;
	try {
		socket = new WebSocket(`ws://127.0.0.1:${port}/agent?token=${encodeURIComponent(token)}`);
	} catch (error) {
		console.warn("[clanky-bridge] WebSocket constructor threw:", error);
		scheduleReconnect();
		return;
	}
	ws = socket;
	socket.addEventListener("open", () => {
		try {
			socket.send(JSON.stringify({ type: "hello", browser: detectBrowser() }));
		} catch (error) {
			console.warn("[clanky-bridge] hello send failed:", error);
		}
	});
	socket.addEventListener("message", (event) => {
		let parsed;
		try {
			parsed = JSON.parse(typeof event.data === "string" ? event.data : "");
		} catch {
			return;
		}
		handleMessage(parsed).catch((error) => {
			console.warn("[clanky-bridge] handler crashed:", error);
		});
	});
	socket.addEventListener("close", () => {
		if (ws === socket) ws = null;
		scheduleReconnect();
	});
	socket.addEventListener("error", () => {
		// onclose will follow and clean up.
	});
}

function scheduleReconnect() {
	if (reconnectTimer !== null) return;
	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		connect();
	}, RECONNECT_DELAY_MS);
}

async function handleMessage(message) {
	if (ws === null) return;
	const id = message && typeof message.id === "number" ? message.id : null;
	if (id === null) return;
	try {
		const result = await dispatch(message);
		ws.send(JSON.stringify({ id, ok: true, result }));
	} catch (error) {
		ws.send(
			JSON.stringify({
				id,
				ok: false,
				error: error?.message || String(error),
			}),
		);
	}
}

async function dispatch(message) {
	if (!message || typeof message.op !== "string") {
		throw new Error("missing op");
	}
	if (message.op === "open_tab") {
		if (typeof message.url !== "string" || message.url.length === 0) {
			throw new Error("url required");
		}
		const tab = await chrome.tabs.create({
			url: message.url,
			active: message.active === undefined ? true : Boolean(message.active),
		});
		return {
			tabId: tab.id,
			url: tab.url || tab.pendingUrl || message.url,
			windowId: tab.windowId,
			active: Boolean(tab.active),
		};
	}
	throw new Error(`unknown op: ${message.op}`);
}

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

try {
	chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.4 });
	chrome.alarms.onAlarm.addListener((alarm) => {
		if (alarm.name === ALARM_NAME) connect();
	});
} catch (error) {
	console.warn("[clanky-bridge] alarms unavailable:", error);
}

connect();
