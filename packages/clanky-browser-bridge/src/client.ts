import { readFile } from "node:fs/promises";
import { resolveBrowserBridgePaths } from "./paths.ts";

export interface BrowserBridgeState {
	port: number;
	pid: number;
	secret: string;
	browser?: string;
	startedAt?: string;
}

export interface OpenTabInput {
	url: string;
	active?: boolean;
}

export interface OpenTabResult {
	tabId: number;
	url: string;
	windowId?: number;
	active: boolean;
	browser?: string;
}

export interface BrowserBridgeClientOptions {
	homeDir?: string;
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
}

export type MouseButton = "left" | "right" | "middle";

export interface ScreenshotInput {
	tabId?: number;
}

export interface ScreenshotResult {
	tabId: number;
	dataUrl: string;
	width: number;
	height: number;
}

// biome-ignore lint/complexity/noBannedTypes: list_tabs takes no parameters; this is intentionally an empty object type.
export type ListTabsInput = {};

export interface BrowserTabSummary {
	tabId: number;
	url: string;
	title: string;
	active: boolean;
	windowId: number;
}

export interface ListTabsResult {
	tabs: BrowserTabSummary[];
}

export interface NavigateInput {
	tabId?: number;
	url: string;
}

export interface NavigateResult {
	tabId: number;
	url: string;
}

export interface CloseTabInput {
	tabId: number;
}

export interface OkResult {
	ok: true;
}

export interface ClickInput {
	tabId: number;
	x: number;
	y: number;
	button?: MouseButton;
	clickCount?: number;
}

export interface DoubleClickInput {
	tabId: number;
	x: number;
	y: number;
	button?: MouseButton;
}

export interface TypeInput {
	tabId: number;
	text: string;
}

export interface KeyModifiers {
	ctrl?: boolean;
	shift?: boolean;
	alt?: boolean;
	meta?: boolean;
}

export interface KeyInput {
	tabId: number;
	key: string;
	modifiers?: KeyModifiers;
}

export interface ScrollInput {
	tabId: number;
	x: number;
	y: number;
	deltaX: number;
	deltaY: number;
}

export interface WaitInput {
	ms: number;
}

export interface WaitResult {
	ok: true;
	waitedMs: number;
}

export class BrowserBridgeUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BrowserBridgeUnavailableError";
	}
}

export async function loadBrowserBridgeState(options: BrowserBridgeClientOptions = {}): Promise<BrowserBridgeState> {
	const env = options.env ?? process.env;
	const paths = resolveBrowserBridgePaths({
		...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
		env,
	});
	let raw: string;
	try {
		raw = await readFile(paths.stateFile, "utf8");
	} catch {
		throw new BrowserBridgeUnavailableError(
			`Browser bridge state file not found at ${paths.stateFile}. Run "pnpm browser-bridge:install" and load the unpacked extension in Helium/Chrome/Brave so the native host can register.`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new BrowserBridgeUnavailableError(`Browser bridge state file ${paths.stateFile} is not valid JSON.`);
	}
	if (parsed === null || typeof parsed !== "object") {
		throw new BrowserBridgeUnavailableError(`Browser bridge state file ${paths.stateFile} is not an object.`);
	}
	const record = parsed as Record<string, unknown>;
	const port = record.port;
	const pid = record.pid;
	const secret = record.secret;
	if (typeof port !== "number" || typeof pid !== "number" || typeof secret !== "string") {
		throw new BrowserBridgeUnavailableError(
			`Browser bridge state at ${paths.stateFile} is missing required fields (port/pid/secret). Reopen the extension in your browser to re-register.`,
		);
	}
	return {
		port,
		pid,
		secret,
		...(typeof record.browser === "string" ? { browser: record.browser } : {}),
		...(typeof record.startedAt === "string" ? { startedAt: record.startedAt } : {}),
	};
}

interface BridgeFetchContext {
	state: BrowserBridgeState;
	fetchImpl: typeof fetch;
}

async function prepareBridge(options: BrowserBridgeClientOptions): Promise<BridgeFetchContext> {
	const state = await loadBrowserBridgeState(options);
	const fetchImpl = options.fetchImpl ?? fetch;
	return { state, fetchImpl };
}

async function postBridge(
	ctx: BridgeFetchContext,
	path: string,
	body: Record<string, unknown>,
	opLabel: string,
): Promise<Record<string, unknown>> {
	const response = await ctx.fetchImpl(`http://127.0.0.1:${ctx.state.port}${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-clanky-token": ctx.state.secret,
		},
		body: JSON.stringify(body),
	});
	const bodyText = await response.text();
	if (!response.ok) {
		throw new BrowserBridgeUnavailableError(
			`Browser bridge ${opLabel} failed (${response.status}): ${bodyText.slice(0, 400)}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(bodyText);
	} catch {
		throw new BrowserBridgeUnavailableError(`Browser bridge returned non-JSON response: ${bodyText.slice(0, 200)}`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new BrowserBridgeUnavailableError(`Browser bridge ${opLabel} returned an unexpected response shape.`);
	}
	return parsed as Record<string, unknown>;
}

function malformed(op: string, snippet: string): BrowserBridgeUnavailableError {
	return new BrowserBridgeUnavailableError(`Browser bridge returned malformed ${op} result: ${snippet}`);
}

function isValidNavigationUrl(url: string): boolean {
	return /^https?:\/\//i.test(url) || url.startsWith("about:") || url.startsWith("chrome://");
}

export async function browserOpenTab(
	input: OpenTabInput,
	options: BrowserBridgeClientOptions = {},
): Promise<OpenTabResult> {
	if (typeof input.url !== "string" || input.url.trim().length === 0) {
		throw new Error("browser_open_tab requires a non-empty url.");
	}
	const url = input.url.trim();
	if (!isValidNavigationUrl(url)) {
		throw new Error("browser_open_tab url must be http(s), about:, or chrome://.");
	}
	const ctx = await prepareBridge(options);
	const record = await postBridge(ctx, "/tabs", { url, active: input.active ?? true }, "open_tab");
	const tabId = record.tabId;
	const tabUrl = record.url;
	if (typeof tabId !== "number" || typeof tabUrl !== "string") {
		throw malformed("open_tab", JSON.stringify(record).slice(0, 200));
	}
	return {
		tabId,
		url: tabUrl,
		active: record.active === true,
		...(typeof record.windowId === "number" ? { windowId: record.windowId } : {}),
		...(typeof record.browser === "string"
			? { browser: record.browser }
			: { ...(ctx.state.browser === undefined ? {} : { browser: ctx.state.browser }) }),
	};
}

export async function browserScreenshot(
	input: ScreenshotInput = {},
	options: BrowserBridgeClientOptions = {},
): Promise<ScreenshotResult> {
	if (input.tabId !== undefined && (typeof input.tabId !== "number" || !Number.isFinite(input.tabId))) {
		throw new Error("browser_screenshot tabId must be a finite number when provided.");
	}
	const ctx = await prepareBridge(options);
	const body: Record<string, unknown> = {};
	if (input.tabId !== undefined) body.tabId = input.tabId;
	const record = await postBridge(ctx, "/screenshot", body, "screenshot");
	const tabId = record.tabId;
	const dataUrl = record.dataUrl;
	const width = record.width;
	const height = record.height;
	if (
		typeof tabId !== "number" ||
		typeof dataUrl !== "string" ||
		typeof width !== "number" ||
		typeof height !== "number"
	) {
		throw malformed("screenshot", JSON.stringify(record).slice(0, 200));
	}
	return { tabId, dataUrl, width, height };
}

export async function browserListTabs(
	_input: ListTabsInput = {},
	options: BrowserBridgeClientOptions = {},
): Promise<ListTabsResult> {
	const ctx = await prepareBridge(options);
	const record = await postBridge(ctx, "/tabs/list", {}, "list_tabs");
	const rawTabs = record.tabs;
	if (!Array.isArray(rawTabs)) {
		throw malformed("list_tabs", JSON.stringify(record).slice(0, 200));
	}
	const tabs: BrowserTabSummary[] = [];
	for (const entry of rawTabs) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
			throw malformed("list_tabs", JSON.stringify(entry).slice(0, 200));
		}
		const r = entry as Record<string, unknown>;
		const tabId = r.tabId;
		const url = r.url;
		const title = r.title;
		const active = r.active;
		const windowId = r.windowId;
		if (
			typeof tabId !== "number" ||
			typeof url !== "string" ||
			typeof title !== "string" ||
			typeof active !== "boolean" ||
			typeof windowId !== "number"
		) {
			throw malformed("list_tabs", JSON.stringify(entry).slice(0, 200));
		}
		tabs.push({ tabId, url, title, active, windowId });
	}
	return { tabs };
}

export async function browserNavigate(
	input: NavigateInput,
	options: BrowserBridgeClientOptions = {},
): Promise<NavigateResult> {
	if (typeof input.url !== "string" || input.url.trim().length === 0) {
		throw new Error("browser_navigate requires a non-empty url.");
	}
	const url = input.url.trim();
	if (!isValidNavigationUrl(url)) {
		throw new Error("browser_navigate url must be http(s), about:, or chrome://.");
	}
	if (input.tabId !== undefined && (typeof input.tabId !== "number" || !Number.isFinite(input.tabId))) {
		throw new Error("browser_navigate tabId must be a finite number when provided.");
	}
	const ctx = await prepareBridge(options);
	const body: Record<string, unknown> = { url };
	if (input.tabId !== undefined) body.tabId = input.tabId;
	const record = await postBridge(ctx, "/tabs/navigate", body, "navigate");
	const tabId = record.tabId;
	const tabUrl = record.url;
	if (typeof tabId !== "number" || typeof tabUrl !== "string") {
		throw malformed("navigate", JSON.stringify(record).slice(0, 200));
	}
	return { tabId, url: tabUrl };
}

export async function browserCloseTab(
	input: CloseTabInput,
	options: BrowserBridgeClientOptions = {},
): Promise<OkResult> {
	if (typeof input.tabId !== "number" || !Number.isFinite(input.tabId)) {
		throw new Error("browser_close_tab requires a finite tabId.");
	}
	const ctx = await prepareBridge(options);
	const record = await postBridge(ctx, "/tabs/close", { tabId: input.tabId }, "close_tab");
	if (record.ok !== true) {
		throw malformed("close_tab", JSON.stringify(record).slice(0, 200));
	}
	return { ok: true };
}

function validateMouseButton(button: MouseButton | undefined, opName: string): void {
	if (button !== undefined && button !== "left" && button !== "right" && button !== "middle") {
		throw new Error(`${opName} button must be "left", "right", or "middle".`);
	}
}

function validatePoint(input: { tabId: unknown; x: unknown; y: unknown }, opName: string): void {
	if (typeof input.tabId !== "number" || !Number.isFinite(input.tabId)) {
		throw new Error(`${opName} requires a finite tabId.`);
	}
	if (typeof input.x !== "number" || !Number.isFinite(input.x)) {
		throw new Error(`${opName} requires a finite x coordinate.`);
	}
	if (typeof input.y !== "number" || !Number.isFinite(input.y)) {
		throw new Error(`${opName} requires a finite y coordinate.`);
	}
}

export async function browserClick(input: ClickInput, options: BrowserBridgeClientOptions = {}): Promise<OkResult> {
	validatePoint(input, "browser_click");
	validateMouseButton(input.button, "browser_click");
	if (input.clickCount !== undefined && (typeof input.clickCount !== "number" || !Number.isFinite(input.clickCount))) {
		throw new Error("browser_click clickCount must be a finite number when provided.");
	}
	const ctx = await prepareBridge(options);
	const body: Record<string, unknown> = { tabId: input.tabId, x: input.x, y: input.y };
	if (input.button !== undefined) body.button = input.button;
	if (input.clickCount !== undefined) body.clickCount = input.clickCount;
	const record = await postBridge(ctx, "/input/click", body, "click");
	if (record.ok !== true) {
		throw malformed("click", JSON.stringify(record).slice(0, 200));
	}
	return { ok: true };
}

export async function browserDoubleClick(
	input: DoubleClickInput,
	options: BrowserBridgeClientOptions = {},
): Promise<OkResult> {
	validatePoint(input, "browser_double_click");
	validateMouseButton(input.button, "browser_double_click");
	const ctx = await prepareBridge(options);
	const body: Record<string, unknown> = { tabId: input.tabId, x: input.x, y: input.y };
	if (input.button !== undefined) body.button = input.button;
	const record = await postBridge(ctx, "/input/double-click", body, "double_click");
	if (record.ok !== true) {
		throw malformed("double_click", JSON.stringify(record).slice(0, 200));
	}
	return { ok: true };
}

export async function browserType(input: TypeInput, options: BrowserBridgeClientOptions = {}): Promise<OkResult> {
	if (typeof input.tabId !== "number" || !Number.isFinite(input.tabId)) {
		throw new Error("browser_type requires a finite tabId.");
	}
	if (typeof input.text !== "string") {
		throw new Error("browser_type requires a string text payload.");
	}
	const ctx = await prepareBridge(options);
	const record = await postBridge(ctx, "/input/type", { tabId: input.tabId, text: input.text }, "type");
	if (record.ok !== true) {
		throw malformed("type", JSON.stringify(record).slice(0, 200));
	}
	return { ok: true };
}

export async function browserKey(input: KeyInput, options: BrowserBridgeClientOptions = {}): Promise<OkResult> {
	if (typeof input.tabId !== "number" || !Number.isFinite(input.tabId)) {
		throw new Error("browser_key requires a finite tabId.");
	}
	if (typeof input.key !== "string" || input.key.length === 0) {
		throw new Error("browser_key requires a non-empty key string (matching KeyboardEvent.key).");
	}
	const modifiers = input.modifiers;
	if (modifiers !== undefined) {
		if (modifiers === null || typeof modifiers !== "object" || Array.isArray(modifiers)) {
			throw new Error("browser_key modifiers must be an object when provided.");
		}
		for (const flagName of ["ctrl", "shift", "alt", "meta"] as const) {
			const value = modifiers[flagName];
			if (value !== undefined && typeof value !== "boolean") {
				throw new Error(`browser_key modifiers.${flagName} must be boolean when provided.`);
			}
		}
	}
	const ctx = await prepareBridge(options);
	const body: Record<string, unknown> = { tabId: input.tabId, key: input.key };
	if (modifiers !== undefined) body.modifiers = modifiers;
	const record = await postBridge(ctx, "/input/key", body, "key");
	if (record.ok !== true) {
		throw malformed("key", JSON.stringify(record).slice(0, 200));
	}
	return { ok: true };
}

export async function browserScroll(input: ScrollInput, options: BrowserBridgeClientOptions = {}): Promise<OkResult> {
	validatePoint(input, "browser_scroll");
	if (typeof input.deltaX !== "number" || !Number.isFinite(input.deltaX)) {
		throw new Error("browser_scroll requires a finite deltaX.");
	}
	if (typeof input.deltaY !== "number" || !Number.isFinite(input.deltaY)) {
		throw new Error("browser_scroll requires a finite deltaY.");
	}
	const ctx = await prepareBridge(options);
	const record = await postBridge(
		ctx,
		"/input/scroll",
		{ tabId: input.tabId, x: input.x, y: input.y, deltaX: input.deltaX, deltaY: input.deltaY },
		"scroll",
	);
	if (record.ok !== true) {
		throw malformed("scroll", JSON.stringify(record).slice(0, 200));
	}
	return { ok: true };
}

export async function browserWait(input: WaitInput, options: BrowserBridgeClientOptions = {}): Promise<WaitResult> {
	if (typeof input.ms !== "number" || !Number.isFinite(input.ms) || input.ms < 0) {
		throw new Error("browser_wait requires a non-negative finite ms value.");
	}
	if (input.ms > 30_000) {
		throw new Error("browser_wait ms must be <= 30000 ms.");
	}
	const ctx = await prepareBridge(options);
	const record = await postBridge(ctx, "/wait", { ms: input.ms }, "wait");
	const waitedMs = record.waitedMs;
	if (record.ok !== true || typeof waitedMs !== "number") {
		throw malformed("wait", JSON.stringify(record).slice(0, 200));
	}
	return { ok: true, waitedMs };
}
