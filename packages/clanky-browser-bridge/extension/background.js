// Clanky Browser Bridge — MV3 service worker.
// Maintains a WebSocket connection to a local Clanky helper daemon and
// executes commands the daemon forwards from Clanky tools.

const RECONNECT_DELAY_MS = 2000;
const ALARM_NAME = "clanky-bridge-tick";
let configPromise = null;
let ws = null;
let reconnectTimer = null;
// Synchronous guard so that overlapping connect() triggers (onStartup, onInstalled,
// the alarm watchdog, and the initial call) cannot each open a socket while the
// first is still awaiting loadConfig() — that produced duplicate connections.
let connecting = false;

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

// Runs a function in the page's isolated world via chrome.scripting (no debugger
// attach, so no "extension is debugging this tab" bar). Throws if the tab cannot
// be scripted (restricted URL such as chrome:// or the Web Store).
async function runInPage(tabId, func) {
	const results = await chrome.scripting.executeScript({ target: { tabId }, func });
	const injection = Array.isArray(results) ? results[0] : undefined;
	if (injection === undefined) {
		throw new Error("page script returned no result (restricted URL?)");
	}
	return injection.result;
}

function readPageMetricsFn() {
	return {
		devicePixelRatio: window.devicePixelRatio,
		cssWidth: window.innerWidth,
		cssHeight: window.innerHeight,
		url: location.href,
		title: document.title,
	};
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

async function downscalePngDataUrl(dataUrl, targetWidth, targetHeight) {
	const blob = await (await fetch(dataUrl)).blob();
	const bitmap = await createImageBitmap(blob);
	try {
		const canvas = new OffscreenCanvas(targetWidth, targetHeight);
		const ctx = canvas.getContext("2d");
		if (ctx === null) throw new Error("OffscreenCanvas 2d context unavailable");
		ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
		const outBlob = await canvas.convertToBlob({ type: "image/png" });
		const bytes = new Uint8Array(await outBlob.arrayBuffer());
		let binary = "";
		for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
		return `data:image/png;base64,${btoa(binary)}`;
	} finally {
		bitmap.close();
	}
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
	// `text: "\r"` makes CDP emit a DOM keypress on keyDown, which is what triggers
	// implicit form submission (and newline insertion in textareas) on Enter.
	Enter: { code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
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

// Derive the DOM `code` and virtual key code for a single printable character so
// keyboard shortcuts (Cmd/Ctrl+A, Cmd+C, …) are recognized as accelerators. The
// browser only maps a key event to an edit command when the virtual key code is
// present — a bare `text` field makes it plain text input instead.
function singleCharKeyInfo(ch) {
	if (ch.length !== 1) return null;
	const upper = ch.toUpperCase();
	if (upper >= "A" && upper <= "Z") {
		return { code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0) };
	}
	if (ch >= "0" && ch <= "9") {
		return { code: `Digit${ch}`, windowsVirtualKeyCode: ch.charCodeAt(0) };
	}
	return null;
}

const CDP_BUTTONS = new Set(["left", "right", "middle"]);
const MOUSE_BUTTON_MASK = { left: 1, right: 2, middle: 4 };

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Evaluate an arbitrary JS expression in the page's main world via the CDP
// Runtime domain. Runs with full page access and is not blocked by the page's
// CSP (unlike chrome.scripting + eval). Returns a JSON-serializable value.
async function evalInPage(tabId, expression, awaitPromise) {
	await ensureAttached(tabId);
	const wrapped = `(function(){ return (${expression}); })()`;
	const res = await cdpSend(tabId, "Runtime.evaluate", {
		expression: wrapped,
		returnByValue: true,
		awaitPromise: awaitPromise !== false,
		userGesture: true,
		timeout: 15000,
	});
	if (res?.exceptionDetails) {
		const ex = res.exceptionDetails;
		const msg = ex.exception?.description || ex.exception?.value || ex.text || "page eval threw";
		throw new Error(String(msg).split("\n")[0]);
	}
	return res?.result ? res.result.value : undefined;
}

// Locate elements by CSS selector via chrome.scripting (isolated world, DOM
// access, no debugger bar). Coordinates are in CSS pixels — the same space the
// screenshot is downscaled to and the click/scroll input ops consume.
function querySelectorInfoFn(selector, returnAll, scrollIntoView, pierce) {
	const describe = (el) => {
		if (scrollIntoView) el.scrollIntoView({ block: "center", inline: "center" });
		const r = el.getBoundingClientRect();
		const style = window.getComputedStyle(el);
		const visible =
			r.width > 0 &&
			r.height > 0 &&
			style.visibility !== "hidden" &&
			style.display !== "none" &&
			Number(style.opacity || "1") > 0;
		const inViewport = r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
		return {
			tag: el.tagName.toLowerCase(),
			rect: {
				x: r.x,
				y: r.y,
				width: r.width,
				height: r.height,
				centerX: r.x + r.width / 2,
				centerY: r.y + r.height / 2,
			},
			text: (el.innerText || el.textContent || "").trim().slice(0, 400),
			value: typeof el.value === "string" ? el.value : null,
			href: typeof el.href === "string" ? el.href : el.getAttribute?.("href") || null,
			visible,
			inViewport,
		};
	};
	let nodes;
	if (pierce) {
		// Descend into every open shadow root, running the selector per-scope.
		nodes = [];
		const seen = new Set();
		const walk = (root) => {
			let matched = [];
			try {
				matched = root.querySelectorAll(selector);
			} catch {
				matched = [];
			}
			for (const el of matched) {
				if (!seen.has(el)) {
					seen.add(el);
					nodes.push(el);
				}
			}
			let hosts = [];
			try {
				hosts = root.querySelectorAll("*");
			} catch {
				hosts = [];
			}
			for (const el of hosts) {
				if (el.shadowRoot) walk(el.shadowRoot);
			}
		};
		walk(document);
	} else {
		nodes = Array.from(document.querySelectorAll(selector));
	}
	if (returnAll) {
		return { found: nodes.length > 0, count: nodes.length, elements: nodes.slice(0, 50).map(describe) };
	}
	return { found: nodes.length > 0, count: nodes.length, element: nodes.length > 0 ? describe(nodes[0]) : null };
}

// Reliably set the state of a form control, the way Playwright's fill/check/
// selectOption do: focus, mutate through the native setter (so React's value
// tracker sees the change), then fire input + change. Avoids the CDP key-event
// limitation where browser accelerators like Cmd+A are not delivered to the page.
// Handles checkboxes/radios (boolean-ish value -> checked state) and <select>
// (match by option value OR visible label) instead of silently no-op'ing.
function fillSelectorFn(selector, value, pierce) {
	let el = document.querySelector(selector);
	if (!el && pierce) {
		const walk = (root) => {
			let found = null;
			try {
				found = root.querySelector(selector);
			} catch {
				found = null;
			}
			if (found) return found;
			let hosts = [];
			try {
				hosts = root.querySelectorAll("*");
			} catch {
				hosts = [];
			}
			for (const host of hosts) {
				if (host.shadowRoot) {
					const r = walk(host.shadowRoot);
					if (r) return r;
				}
			}
			return null;
		};
		el = walk(document);
	}
	if (!el) return { ok: false, error: "selector matched no element" };
	if (typeof el.focus === "function") el.focus();

	// Checkbox / radio: the meaningful state is `.checked`, not `.value`. Setting
	// `.value` (the old behavior) silently did nothing visible. Interpret the
	// value as a desired checked state instead.
	if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
		const v = String(value).trim().toLowerCase();
		const truthy = ["true", "1", "on", "yes", "checked", "check"];
		const falsy = ["false", "0", "off", "no", "unchecked", "uncheck", ""];
		let desired;
		if (truthy.includes(v)) desired = true;
		else if (falsy.includes(v)) desired = false;
		else {
			return {
				ok: false,
				error: `${el.type} fill expects a boolean-ish value (true/false/on/off/1/0); got "${value}". To toggle by position, click it instead.`,
			};
		}
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set;
		if (setter) setter.call(el, desired);
		else el.checked = desired;
		el.dispatchEvent(new Event("input", { bubbles: true }));
		el.dispatchEvent(new Event("change", { bubbles: true }));
		return { ok: true, value: String(el.checked) };
	}

	// Select: match by option value first, then by visible label (exact, then
	// case-insensitive). Throwing on no match kills the old silent-clear footgun
	// where passing a label (e.g. "Blue") reset the select to no selection.
	if (el instanceof HTMLSelectElement) {
		const opts = Array.from(el.options);
		const want = String(value);
		let opt = opts.find((o) => o.value === want);
		if (!opt) opt = opts.find((o) => (o.text || "").trim() === want.trim());
		if (!opt) opt = opts.find((o) => (o.text || "").trim().toLowerCase() === want.trim().toLowerCase());
		if (!opt) {
			const list = opts
				.map((o) => `${o.value}=${(o.text || "").trim()}`)
				.join(", ")
				.slice(0, 300);
			return { ok: false, error: `select has no option matching value or label "${value}". Options: ${list}` };
		}
		const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
		if (setter) setter.call(el, opt.value);
		else el.value = opt.value;
		el.dispatchEvent(new Event("input", { bubbles: true }));
		el.dispatchEvent(new Event("change", { bubbles: true }));
		return { ok: true, value: el.value };
	}

	if (el.isContentEditable) {
		el.textContent = value;
		el.dispatchEvent(new InputEvent("input", { bubbles: true }));
		return { ok: true, value: el.textContent };
	}
	if (!("value" in el)) return { ok: false, error: "element is not fillable (no value)" };
	const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
	if (setter) setter.call(el, value);
	else el.value = value;
	el.dispatchEvent(new Event("input", { bubbles: true }));
	el.dispatchEvent(new Event("change", { bubbles: true }));
	return { ok: true, value: el.value };
}

function snapshotPageFn(maxTextChars, maxLinks, maxMedia, maxElements) {
	const textLimit = Math.max(1, Math.min(100000, Math.floor(Number(maxTextChars) || 25000)));
	const linkLimit = Math.max(0, Math.min(500, Math.floor(Number(maxLinks) || 100)));
	const mediaLimit = Math.max(0, Math.min(500, Math.floor(Number(maxMedia) || 100)));
	const elementLimit = Math.max(0, Math.min(300, Math.floor(Number(maxElements) || 80)));

	function absoluteUrl(value) {
		if (typeof value !== "string" || value.trim().length === 0) return null;
		try {
			const parsed = new URL(value, document.baseURI);
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
			return parsed.toString();
		} catch {
			return null;
		}
	}

	function cleanText(value, max) {
		return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
	}

	function mediaKind(url, declaredType) {
		const lower = `${declaredType || ""} ${url}`.toLowerCase();
		if (lower.includes("image/gif") || /\.(gif)(\?|#|$)/i.test(url)) return "gif";
		if (lower.includes("video/") || /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(url)) return "video";
		return "image";
	}

	function cssEscape(value) {
		if (globalThis.CSS && typeof globalThis.CSS.escape === "function") return globalThis.CSS.escape(value);
		return String(value).replace(/["\\]/g, "\\$&");
	}

	function quotedAttr(name, value) {
		return `[${name}="${String(value).replace(/["\\]/g, "\\$&")}"]`;
	}

	function selectorFor(el) {
		if (!(el instanceof Element)) return "";
		const id = el.getAttribute("id");
		if (id && document.querySelectorAll(`#${cssEscape(id)}`).length === 1) return `#${cssEscape(id)}`;
		for (const attr of ["data-testid", "data-test", "aria-label", "name", "placeholder"]) {
			const value = el.getAttribute(attr);
			if (!value) continue;
			const selector = `${el.tagName.toLowerCase()}${quotedAttr(attr, value)}`;
			try {
				if (document.querySelectorAll(selector).length === 1) return selector;
			} catch {
				// fall through to path selector
			}
		}
		const parts = [];
		let node = el;
		while (node instanceof Element && parts.length < 5) {
			const tag = node.tagName.toLowerCase();
			const parent = node.parentElement;
			if (!parent) {
				parts.unshift(tag);
				break;
			}
			const siblings = Array.from(parent.children).filter((candidate) => candidate.tagName === node.tagName);
			const index = siblings.indexOf(node) + 1;
			parts.unshift(siblings.length <= 1 ? tag : `${tag}:nth-of-type(${index})`);
			node = parent;
		}
		return parts.join(" > ");
	}

	function elementLabel(el) {
		const labelledBy = el.getAttribute("aria-labelledby");
		if (labelledBy) {
			const value = labelledBy
				.split(/\s+/)
				.flatMap((id) => {
					const target = document.getElementById(id);
					return target ? [target.textContent || ""] : [];
				})
				.join(" ");
			const cleaned = cleanText(value, 160);
			if (cleaned.length > 0) return cleaned;
		}
		for (const attr of ["aria-label", "alt", "title", "placeholder", "name"]) {
			const value = el.getAttribute(attr);
			const cleaned = cleanText(value, 160);
			if (cleaned.length > 0) return cleaned;
		}
		if (el instanceof HTMLInputElement && el.id) {
			const label = document.querySelector(`label${quotedAttr("for", el.id)}`);
			const cleaned = cleanText(label?.textContent, 160);
			if (cleaned.length > 0) return cleaned;
		}
		const nearestLabel = el.closest("label");
		const nearestLabelText = cleanText(nearestLabel?.textContent, 160);
		if (nearestLabelText.length > 0) return nearestLabelText;
		return cleanText(el.innerText || el.textContent || "", 160);
	}

	function describeElement(el) {
		const rect = el.getBoundingClientRect();
		const style = window.getComputedStyle(el);
		const visible =
			rect.width > 0 &&
			rect.height > 0 &&
			style.visibility !== "hidden" &&
			style.display !== "none" &&
			Number(style.opacity || "1") > 0;
		const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
		const tag = el.tagName.toLowerCase();
		const role = el.getAttribute("role") || null;
		const value =
			el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
				? el.value
				: null;
		const checked = el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio") ? el.checked : null;
		const disabled = "disabled" in el ? Boolean(el.disabled) : false;
		const href = el instanceof HTMLAnchorElement ? absoluteUrl(el.getAttribute("href")) : null;
		return {
			tag,
			selector: selectorFor(el),
			role,
			type: el instanceof HTMLInputElement ? el.type || "text" : null,
			label: elementLabel(el),
			text: cleanText(el.innerText || el.textContent || "", 240),
			value,
			checked,
			disabled,
			href,
			visible,
			inViewport,
			rect: {
				x: rect.x,
				y: rect.y,
				width: rect.width,
				height: rect.height,
				centerX: rect.x + rect.width / 2,
				centerY: rect.y + rect.height / 2,
			},
		};
	}

	const fullText = document.body ? document.body.innerText || "" : "";
	const links = [];
	const seenLinks = new Set();
	for (const node of Array.from(document.querySelectorAll("a[href]"))) {
		const url = absoluteUrl(node.getAttribute("href"));
		if (url === null || seenLinks.has(url)) continue;
		seenLinks.add(url);
		links.push({ text: cleanText(node.innerText || node.textContent || "", 240), url });
		if (links.length >= linkLimit) break;
	}

	const media = [];
	const seenMedia = new Set();
	function pushMedia(kind, url, details) {
		if (url === null || seenMedia.has(url) || media.length >= mediaLimit) return;
		seenMedia.add(url);
		media.push({ kind, url, ...details });
	}
	for (const node of Array.from(document.querySelectorAll("img"))) {
		const url = absoluteUrl(node.currentSrc || node.src || node.getAttribute("src"));
		pushMedia(mediaKind(url || "", node.getAttribute("type")), url, {
			alt: cleanText(node.alt, 240),
			width: node.naturalWidth || undefined,
			height: node.naturalHeight || undefined,
		});
	}
	for (const node of Array.from(document.querySelectorAll("video"))) {
		const url = absoluteUrl(node.currentSrc || node.src || node.getAttribute("src"));
		pushMedia("video", url, { width: node.videoWidth || undefined, height: node.videoHeight || undefined });
		const poster = absoluteUrl(node.poster || node.getAttribute("poster"));
		pushMedia("image", poster, { alt: "video poster" });
	}
	for (const node of Array.from(document.querySelectorAll("source[src]"))) {
		const url = absoluteUrl(node.src || node.getAttribute("src"));
		pushMedia(mediaKind(url || "", node.type), url, {});
	}
	for (const node of Array.from(document.querySelectorAll("meta[property], meta[name]"))) {
		const name = node.getAttribute("property") || node.getAttribute("name") || "";
		if (name !== "og:image" && name !== "twitter:image" && name !== "og:video" && name !== "twitter:player") continue;
		const url = absoluteUrl(node.content);
		pushMedia(name.includes("video") || name.includes("player") ? "video" : mediaKind(url || "", "image"), url, {
			source: name,
		});
	}

	const elements = [];
	const seenElements = new Set();
	const selector =
		'a[href],button,input,textarea,select,[contenteditable="true"],[role="button"],[role="link"],[role="textbox"],[role="checkbox"],[role="radio"],[role="combobox"],summary';
	for (const node of Array.from(document.querySelectorAll(selector))) {
		if (!(node instanceof Element) || seenElements.has(node)) continue;
		seenElements.add(node);
		const described = describeElement(node);
		if (!described.visible && elements.length >= Math.floor(elementLimit / 2)) continue;
		elements.push(described);
		if (elements.length >= elementLimit) break;
	}

	return {
		url: location.href,
		title: document.title,
		text: fullText.length > textLimit ? fullText.slice(0, textLimit) : fullText,
		length: fullText.length,
		truncated: fullText.length > textLimit,
		viewport: {
			width: window.innerWidth,
			height: window.innerHeight,
			devicePixelRatio: window.devicePixelRatio,
			scrollX: window.scrollX,
			scrollY: window.scrollY,
		},
		links,
		media,
		elements,
		counts: {
			links: document.querySelectorAll("a[href]").length,
			media: document.querySelectorAll("img,video,source[src]").length,
			elements: document.querySelectorAll(selector).length,
		},
	};
}

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
	// Best-effort label from the UA. Note: privacy-focused forks like Helium ship a
	// vanilla Chrome UA (no "Helium" token) and Chrome-only UA-CH brands by design, so
	// they are web-indistinguishable from Chrome here and report as "chrome". The bridge
	// behaves identically regardless of the label; this is cosmetic, not a bug.
	if (/Helium/i.test(ua)) return "helium";
	if (/Brave/i.test(ua)) return "brave";
	if (/Edg\//i.test(ua)) return "edge";
	if (/Chrome/i.test(ua)) return "chrome";
	return "chromium";
}

async function connect() {
	if (connecting) return;
	if (ws !== null && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
	connecting = true;
	let config;
	try {
		config = await loadConfig();
	} catch (error) {
		connecting = false;
		console.warn("[clanky-bridge] failed to load config.json:", error);
		scheduleReconnect();
		return;
	}
	const port = Number(config?.port);
	const token = String(config?.token ?? "");
	if (!Number.isInteger(port) || port <= 0 || token.length === 0) {
		connecting = false;
		console.warn("[clanky-bridge] config.json missing port or token");
		scheduleReconnect();
		return;
	}
	let socket;
	try {
		socket = new WebSocket(`ws://127.0.0.1:${port}/agent?token=${encodeURIComponent(token)}`);
	} catch (error) {
		connecting = false;
		console.warn("[clanky-bridge] WebSocket constructor threw:", error);
		scheduleReconnect();
		return;
	}
	ws = socket;
	// ws is now CONNECTING, so the readyState guard above holds for later calls.
	connecting = false;
	socket.addEventListener("open", () => {
		try {
			socket.send(
				JSON.stringify({
					type: "hello",
					browser: detectBrowser(),
					version: chrome.runtime.getManifest().version,
				}),
			);
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
		const rawDataUrl = await chrome.tabs.captureVisibleTab(target.windowId, { format: "png" });
		const captured = pngDimensionsFromDataUrl(rawDataUrl);
		let metrics = null;
		try {
			metrics = await runInPage(target.tabId, readPageMetricsFn);
		} catch {
			// Restricted URL (chrome://, store, etc.) — cannot read CSS dimensions.
		}
		// captureVisibleTab returns the tab at the display's physical backing-store
		// resolution, which can differ from both the CSS viewport and the page's
		// reported devicePixelRatio (e.g. a Retina display reports DPR 1 under an
		// emulated viewport yet still captures at 2x). To keep input-op coordinates
		// identical to screenshot pixels, downscale to the CSS viewport so callers
		// never have to apply a scale factor.
		const cssWidth = metrics && typeof metrics.cssWidth === "number" && metrics.cssWidth > 0 ? metrics.cssWidth : null;
		const cssHeight =
			metrics && typeof metrics.cssHeight === "number" && metrics.cssHeight > 0 ? metrics.cssHeight : null;
		let dataUrl = rawDataUrl;
		let width = captured.width;
		let height = captured.height;
		if (cssWidth !== null && cssHeight !== null && (cssWidth !== captured.width || cssHeight !== captured.height)) {
			dataUrl = await downscalePngDataUrl(rawDataUrl, cssWidth, cssHeight);
			width = cssWidth;
			height = cssHeight;
		}
		return {
			tabId: target.tabId,
			dataUrl,
			width,
			height,
			capturedWidth: captured.width,
			capturedHeight: captured.height,
			devicePixelRatio:
				metrics && typeof metrics.devicePixelRatio === "number" && metrics.devicePixelRatio > 0
					? metrics.devicePixelRatio
					: 1,
			url: metrics && typeof metrics.url === "string" ? metrics.url : "",
			title: metrics && typeof metrics.title === "string" ? metrics.title : "",
		};
	}
	if (message.op === "read_text") {
		if (typeof message.tabId !== "number") throw new Error("tabId required");
		const maxChars =
			typeof message.maxChars === "number" && message.maxChars > 0 ? Math.floor(message.maxChars) : 20000;
		const data = await runInPage(message.tabId, () => ({
			url: location.href,
			title: document.title,
			text: document.body ? document.body.innerText : "",
		}));
		if (!data || typeof data !== "object") {
			throw new Error("read_text could not access page contents (restricted URL?)");
		}
		const fullText = typeof data.text === "string" ? data.text : "";
		const truncated = fullText.length > maxChars;
		return {
			tabId: message.tabId,
			url: typeof data.url === "string" ? data.url : "",
			title: typeof data.title === "string" ? data.title : "",
			text: truncated ? fullText.slice(0, maxChars) : fullText,
			length: fullText.length,
			truncated,
		};
	}
	if (message.op === "snapshot") {
		if (typeof message.tabId !== "number") throw new Error("tabId required");
		const result = await chrome.scripting.executeScript({
			target: { tabId: message.tabId },
			func: snapshotPageFn,
			args: [
				typeof message.maxTextChars === "number" ? message.maxTextChars : 25000,
				typeof message.maxLinks === "number" ? message.maxLinks : 100,
				typeof message.maxMedia === "number" ? message.maxMedia : 100,
				typeof message.maxElements === "number" ? message.maxElements : 80,
			],
		});
		const data = Array.isArray(result) ? result[0]?.result : undefined;
		if (!data || typeof data !== "object") {
			throw new Error("snapshot could not access page contents (restricted URL?)");
		}
		return { tabId: message.tabId, ...data };
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
		await ensureAttached(message.tabId);
		const buttons = MOUSE_BUTTON_MASK[button] || 1;
		// One press+release pair at the given clickCount. clickCount drives the
		// DOM `detail` and lets the renderer synthesize dblclick on the 2nd pair.
		const dispatchPair = async (clickCount) => {
			const base = { x: message.x, y: message.y, button, clickCount };
			await cdpSend(message.tabId, "Input.dispatchMouseEvent", { ...base, type: "mousePressed", buttons });
			await cdpSend(message.tabId, "Input.dispatchMouseEvent", { ...base, type: "mouseReleased", buttons: 0 });
		};
		if (message.op === "double_click") {
			// A faithful double click is two full click sequences; the second pair
			// with clickCount=2 is what makes the page fire a `dblclick` event.
			await dispatchPair(1);
			await dispatchPair(2);
		} else {
			await dispatchPair(typeof message.clickCount === "number" ? message.clickCount : 1);
		}
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
		// A command modifier (Ctrl/Cmd/Alt) means this is a shortcut, not text entry.
		const m = message.modifiers || {};
		const hasCommandModifier = Boolean(m.ctrl || m.meta || m.alt);
		const known = keyCodeFor(message.key);
		await ensureAttached(message.tabId);
		const baseDown = { type: "keyDown", key: message.key, modifiers };
		const baseUp = { type: "keyUp", key: message.key, modifiers };
		if (known) {
			Object.assign(baseDown, known);
			Object.assign(baseUp, known);
			// `text` drives the keypress and belongs only on the keyDown event.
			delete baseUp.text;
			if (hasCommandModifier) delete baseDown.text;
		} else if (message.key.length === 1) {
			const charInfo = singleCharKeyInfo(message.key);
			if (charInfo) {
				baseDown.code = charInfo.code;
				baseDown.windowsVirtualKeyCode = charInfo.windowsVirtualKeyCode;
				baseUp.code = charInfo.code;
				baseUp.windowsVirtualKeyCode = charInfo.windowsVirtualKeyCode;
			}
			// Only emit `text` for plain typing — a shortcut (Cmd+A) must not insert text.
			if (!hasCommandModifier) baseDown.text = message.key;
		}
		await cdpSend(message.tabId, "Input.dispatchKeyEvent", baseDown);
		await cdpSend(message.tabId, "Input.dispatchKeyEvent", baseUp);
		return { ok: true };
	}
	if (message.op === "hover") {
		if (typeof message.tabId !== "number") throw new Error("tabId required");
		if (typeof message.x !== "number" || typeof message.y !== "number") {
			throw new Error("x and y required");
		}
		await ensureAttached(message.tabId);
		// A synthesized mouse move updates Blink's hover state, so CSS :hover rules
		// and mouseover/mouseenter listeners fire (reveals hover menus/tooltips).
		await cdpSend(message.tabId, "Input.dispatchMouseEvent", {
			type: "mouseMoved",
			x: message.x,
			y: message.y,
			buttons: 0,
		});
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
	if (message.op === "drag") {
		if (typeof message.tabId !== "number") throw new Error("tabId required");
		for (const field of ["x", "y", "toX", "toY"]) {
			if (typeof message[field] !== "number") throw new Error(`${field} required`);
		}
		const button = message.button || "left";
		if (!CDP_BUTTONS.has(button)) throw new Error(`invalid button: ${button}`);
		const buttons = MOUSE_BUTTON_MASK[button] || 1;
		const steps =
			typeof message.steps === "number" && message.steps >= 1 ? Math.min(Math.floor(message.steps), 100) : 12;
		const holdMs = typeof message.holdMs === "number" && message.holdMs >= 0 ? Math.min(message.holdMs, 2000) : 0;
		await ensureAttached(message.tabId);
		// Press at the start point, then walk the pointer to the end across `steps`
		// interpolated moves (buttons held the whole time) so drag handlers track the
		// path, then release. Covers pointer/mouse-event draggables (sliders, canvas
		// pans, reorder libs). Native HTML5 drag-and-drop is not driven by this.
		await cdpSend(message.tabId, "Input.dispatchMouseEvent", {
			type: "mousePressed",
			x: message.x,
			y: message.y,
			button,
			buttons,
			clickCount: 1,
		});
		// An initial move at the press point helps libraries that begin a drag only
		// after the first move past the threshold.
		await cdpSend(message.tabId, "Input.dispatchMouseEvent", {
			type: "mouseMoved",
			x: message.x,
			y: message.y,
			buttons,
		});
		if (holdMs > 0) await sleep(holdMs);
		for (let i = 1; i <= steps; i++) {
			const t = i / steps;
			await cdpSend(message.tabId, "Input.dispatchMouseEvent", {
				type: "mouseMoved",
				x: message.x + (message.toX - message.x) * t,
				y: message.y + (message.toY - message.y) * t,
				buttons,
			});
		}
		await cdpSend(message.tabId, "Input.dispatchMouseEvent", {
			type: "mouseReleased",
			x: message.toX,
			y: message.toY,
			button,
			buttons: 0,
			clickCount: 1,
		});
		return { ok: true };
	}
	if (message.op === "eval") {
		if (typeof message.tabId !== "number") throw new Error("tabId required");
		if (typeof message.expression !== "string" || message.expression.length === 0) {
			throw new Error("expression required");
		}
		const value = await evalInPage(message.tabId, message.expression, message.awaitPromise);
		return { tabId: message.tabId, value: value === undefined ? null : value };
	}
	if (message.op === "fill") {
		if (typeof message.tabId !== "number") throw new Error("tabId required");
		if (typeof message.selector !== "string" || message.selector.length === 0) {
			throw new Error("selector required");
		}
		if (typeof message.value !== "string") throw new Error("value required");
		const result = await chrome.scripting.executeScript({
			target: { tabId: message.tabId },
			func: fillSelectorFn,
			args: [message.selector, message.value, message.pierce === true],
		});
		const data = Array.isArray(result) ? result[0]?.result : undefined;
		if (!data) throw new Error("fill could not access page contents (restricted URL?)");
		if (data.ok !== true) throw new Error(data.error || "fill failed");
		return { tabId: message.tabId, selector: message.selector, value: data.value };
	}
	if (message.op === "query") {
		if (typeof message.tabId !== "number") throw new Error("tabId required");
		if (typeof message.selector !== "string" || message.selector.length === 0) {
			throw new Error("selector required");
		}
		const all = message.all === true;
		const scrollIntoView = message.scrollIntoView === true;
		const result = await chrome.scripting.executeScript({
			target: { tabId: message.tabId },
			func: querySelectorInfoFn,
			args: [message.selector, all, scrollIntoView, message.pierce === true],
		});
		const data = Array.isArray(result) ? result[0]?.result : undefined;
		if (!data) throw new Error("query could not access page contents (restricted URL?)");
		return { tabId: message.tabId, selector: message.selector, ...data };
	}
	if (message.op === "wait_for") {
		if (typeof message.tabId !== "number") throw new Error("tabId required");
		const selector = typeof message.selector === "string" && message.selector.length > 0 ? message.selector : null;
		const jsCondition =
			typeof message.jsCondition === "string" && message.jsCondition.length > 0 ? message.jsCondition : null;
		const readyState =
			typeof message.readyState === "string" && message.readyState.length > 0 ? message.readyState : null;
		if (!selector && !jsCondition && !readyState) {
			throw new Error("wait_for requires one of: selector, jsCondition, readyState");
		}
		const visible = message.visible === true;
		const pierce = message.pierce === true;
		const timeoutMs =
			typeof message.timeoutMs === "number" && message.timeoutMs > 0 ? Math.min(message.timeoutMs, 30000) : 10000;
		const pollMs = typeof message.pollMs === "number" && message.pollMs >= 50 ? Math.min(message.pollMs, 5000) : 150;
		const start = Date.now();
		// Probe runs in the isolated world (no debugger bar) for selector/readyState;
		// jsCondition needs page-main-world eval, handled separately below.
		const probeSelector = (sel, wantVisible, wantReady, wantPierce) => {
			if (
				wantReady &&
				document.readyState !== wantReady &&
				!(wantReady === "complete" && document.readyState === "complete")
			) {
				// readyState ordering: loading < interactive < complete
				const order = { loading: 0, interactive: 1, complete: 2 };
				if ((order[document.readyState] ?? -1) < (order[wantReady] ?? 99)) return false;
			}
			if (!sel) return true;
			let el = document.querySelector(sel);
			if (!el && wantPierce) {
				const walk = (root) => {
					let f = null;
					try {
						f = root.querySelector(sel);
					} catch {
						f = null;
					}
					if (f) return f;
					let hosts = [];
					try {
						hosts = root.querySelectorAll("*");
					} catch {
						hosts = [];
					}
					for (const h of hosts) {
						if (h.shadowRoot) {
							const r = walk(h.shadowRoot);
							if (r) return r;
						}
					}
					return null;
				};
				el = walk(document);
			}
			if (!el) return false;
			if (!wantVisible) return true;
			const r = el.getBoundingClientRect();
			const st = window.getComputedStyle(el);
			return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
		};
		for (;;) {
			let ok = false;
			try {
				if (jsCondition) {
					ok = Boolean(await evalInPage(message.tabId, jsCondition, true));
				} else {
					const probe = await chrome.scripting.executeScript({
						target: { tabId: message.tabId },
						func: probeSelector,
						args: [selector, visible, readyState, pierce],
					});
					ok = Array.isArray(probe) ? probe[0]?.result === true : false;
				}
			} catch {
				// Page mid-navigation can transiently fail to script; keep polling.
				ok = false;
			}
			if (ok) return { tabId: message.tabId, ok: true, waitedMs: Date.now() - start, timedOut: false };
			if (Date.now() - start >= timeoutMs) {
				return { tabId: message.tabId, ok: false, waitedMs: Date.now() - start, timedOut: true };
			}
			await sleep(pollMs);
		}
	}
	if (message.op === "back" || message.op === "forward" || message.op === "reload") {
		if (typeof message.tabId !== "number") throw new Error("tabId required");
		if (message.op === "back") await chrome.tabs.goBack(message.tabId);
		else if (message.op === "forward") await chrome.tabs.goForward(message.tabId);
		else await chrome.tabs.reload(message.tabId, { bypassCache: message.bypassCache === true });
		const tab = await chrome.tabs.get(message.tabId);
		return { tabId: message.tabId, url: tab.url || tab.pendingUrl || "", title: tab.title || "" };
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
