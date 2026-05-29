// Clanky Browser Bridge — MV3 service worker.
// Maintains a WebSocket connection to a local Clanky helper daemon and
// executes commands the daemon forwards from Clanky tools.

const RECONNECT_DELAY_MS = 2000;
const ALARM_NAME = "clanky-bridge-tick";
let configPromise = null;
let ws = null;
let reconnectTimer = null;

const attachedTabs = new Set();

const ALLOWED_URL_PREFIXES = ["http://", "https://", "about:", "chrome://"];

function isAllowedUrl(url) {
	if (typeof url !== "string" || url.length === 0) return false;
	for (const prefix of ALLOWED_URL_PREFIXES) {
		if (url.startsWith(prefix)) return true;
	}
	return false;
}

async function ensureAttached(tabId) {
	if (attachedTabs.has(tabId)) return;
	await chrome.debugger.attach({ tabId }, "1.3");
	attachedTabs.add(tabId);
}

function cdpSend(tabId, method, params) {
	return new Promise((resolve, reject) => {
		chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
			const err = chrome.runtime.lastError;
			if (err) {
				reject(new Error(err.message || `CDP ${method} failed`));
				return;
			}
			resolve(result);
		});
	});
}

function requireTabIdentity(tab, opName) {
	if (typeof tab?.id !== "number" || typeof tab.windowId !== "number") {
		throw new Error(`${opName} tab is missing id or windowId`);
	}
	return { tabId: tab.id, windowId: tab.windowId };
}

async function resolveScreenshotTarget(tabId) {
	if (typeof tabId === "number") {
		const tab = await chrome.tabs.get(tabId);
		const identity = requireTabIdentity(tab, "screenshot");
		await chrome.windows.update(identity.windowId, { focused: true });
		const activeTab = await chrome.tabs.update(identity.tabId, { active: true });
		return requireTabIdentity(activeTab, "screenshot");
	}
	const win = await chrome.windows.getLastFocused({ populate: true });
	const tab = (win.tabs || []).find((t) => t.active);
	if (!tab) throw new Error("no active tab in focused window");
	return requireTabIdentity(tab, "screenshot");
}

function readPngUint32(binary, offset) {
	return (
		((binary.charCodeAt(offset) << 24) |
			(binary.charCodeAt(offset + 1) << 16) |
			(binary.charCodeAt(offset + 2) << 8) |
			binary.charCodeAt(offset + 3)) >>>
		0
	);
}

function pngDimensionsFromDataUrl(dataUrl) {
	const prefix = "data:image/png;base64,";
	if (typeof dataUrl !== "string" || !dataUrl.startsWith(prefix)) {
		throw new Error("screenshot did not return a PNG data URL");
	}
	const binary = atob(dataUrl.slice(prefix.length));
	if (binary.length < 24 || binary.slice(0, 8) !== "\x89PNG\r\n\x1a\n" || binary.slice(12, 16) !== "IHDR") {
		throw new Error("screenshot PNG is malformed");
	}
	return {
		width: readPngUint32(binary, 16),
		height: readPngUint32(binary, 20),
	};
}

const MOD_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

function modifierBitmask(modifiers) {
	if (!modifiers || typeof modifiers !== "object") return 0;
	let mask = 0;
	if (modifiers.alt) mask |= MOD_BITS.alt;
	if (modifiers.ctrl) mask |= MOD_BITS.ctrl;
	if (modifiers.meta) mask |= MOD_BITS.meta;
	if (modifiers.shift) mask |= MOD_BITS.shift;
	return mask;
}

const KEY_TABLE = {
	Enter: { code: "Enter", windowsVirtualKeyCode: 13 },
	Tab: { code: "Tab", windowsVirtualKeyCode: 9 },
	Escape: { code: "Escape", windowsVirtualKeyCode: 27 },
	Backspace: { code: "Backspace", windowsVirtualKeyCode: 8 },
	Delete: { code: "Delete", windowsVirtualKeyCode: 46 },
	ArrowUp: { code: "ArrowUp", windowsVirtualKeyCode: 38 },
	ArrowDown: { code: "ArrowDown", windowsVirtualKeyCode: 40 },
	ArrowLeft: { code: "ArrowLeft", windowsVirtualKeyCode: 37 },
	ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39 },
	Home: { code: "Home", windowsVirtualKeyCode: 36 },
	End: { code: "End", windowsVirtualKeyCode: 35 },
	PageUp: { code: "PageUp", windowsVirtualKeyCode: 33 },
	PageDown: { code: "PageDown", windowsVirtualKeyCode: 34 },
	" ": { code: "Space", windowsVirtualKeyCode: 32 },
};

function keyCodeFor(key) {
	if (Object.hasOwn(KEY_TABLE, key)) {
		return KEY_TABLE[key];
	}
	return null;
}

const CDP_BUTTONS = new Set(["left", "right", "middle"]);

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
	if (message.op === "screenshot") {
		const target = await resolveScreenshotTarget(message.tabId);
		const dataUrl = await chrome.tabs.captureVisibleTab(target.windowId, { format: "png" });
		const dimensions = pngDimensionsFromDataUrl(dataUrl);
		return {
			tabId: target.tabId,
			dataUrl,
			width: dimensions.width,
			height: dimensions.height,
		};
	}
	if (message.op === "list_tabs") {
		const tabs = await chrome.tabs.query({});
		return {
			tabs: tabs.map((t) => ({
				tabId: t.id,
				url: t.url || t.pendingUrl || "",
				title: t.title || "",
				active: Boolean(t.active),
				windowId: t.windowId,
			})),
		};
	}
	if (message.op === "navigate") {
		if (!isAllowedUrl(message.url)) {
			throw new Error("url required (http(s)://, about:, or chrome://)");
		}
		if (typeof message.tabId === "number") {
			const tab = await chrome.tabs.update(message.tabId, { url: message.url });
			return { tabId: tab.id, url: tab.url || tab.pendingUrl || message.url };
		}
		const tab = await chrome.tabs.create({ url: message.url, active: true });
		return { tabId: tab.id, url: tab.url || tab.pendingUrl || message.url };
	}
	if (message.op === "close_tab") {
		if (typeof message.tabId !== "number") {
			throw new Error("tabId required");
		}
		await chrome.tabs.remove(message.tabId);
		attachedTabs.delete(message.tabId);
		return { ok: true };
	}
	if (message.op === "click" || message.op === "double_click") {
		if (typeof message.tabId !== "number") throw new Error("tabId required");
		if (typeof message.x !== "number" || typeof message.y !== "number") {
			throw new Error("x and y required");
		}
		const button = message.button || "left";
		if (!CDP_BUTTONS.has(button)) throw new Error(`invalid button: ${button}`);
		const clickCount =
			message.op === "double_click" ? 2 : typeof message.clickCount === "number" ? message.clickCount : 1;
		await ensureAttached(message.tabId);
		const base = { x: message.x, y: message.y, button, clickCount };
		await cdpSend(message.tabId, "Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
		await cdpSend(message.tabId, "Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
		return { ok: true };
	}
	if (message.op === "type") {
		if (typeof message.tabId !== "number") throw new Error("tabId required");
		if (typeof message.text !== "string") throw new Error("text required");
		await ensureAttached(message.tabId);
		await cdpSend(message.tabId, "Input.insertText", { text: message.text });
		return { ok: true };
	}
	if (message.op === "key") {
		if (typeof message.tabId !== "number") throw new Error("tabId required");
		if (typeof message.key !== "string" || message.key.length === 0) {
			throw new Error("key required");
		}
		const modifiers = modifierBitmask(message.modifiers);
		const known = keyCodeFor(message.key);
		await ensureAttached(message.tabId);
		const baseDown = { type: "keyDown", key: message.key, modifiers };
		const baseUp = { type: "keyUp", key: message.key, modifiers };
		if (known) {
			Object.assign(baseDown, known);
			Object.assign(baseUp, known);
		} else if (message.key.length === 1) {
			// Printable single char — give CDP a `text` so the page sees input.
			baseDown.text = message.key;
		}
		await cdpSend(message.tabId, "Input.dispatchKeyEvent", baseDown);
		await cdpSend(message.tabId, "Input.dispatchKeyEvent", baseUp);
		return { ok: true };
	}
	if (message.op === "scroll") {
		if (typeof message.tabId !== "number") throw new Error("tabId required");
		if (typeof message.x !== "number" || typeof message.y !== "number") {
			throw new Error("x and y required");
		}
		if (typeof message.deltaX !== "number" || typeof message.deltaY !== "number") {
			throw new Error("deltaX and deltaY required");
		}
		await ensureAttached(message.tabId);
		await cdpSend(message.tabId, "Input.dispatchMouseEvent", {
			type: "mouseWheel",
			x: message.x,
			y: message.y,
			deltaX: message.deltaX,
			deltaY: message.deltaY,
		});
		return { ok: true };
	}
	throw new Error(`unknown op: ${message.op}`);
}

chrome.tabs.onRemoved.addListener((tabId) => {
	attachedTabs.delete(tabId);
});

chrome.debugger.onDetach.addListener((source) => {
	if (source && typeof source.tabId === "number") {
		attachedTabs.delete(source.tabId);
	}
});

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
