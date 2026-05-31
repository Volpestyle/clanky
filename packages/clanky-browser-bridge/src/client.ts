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
	/** Image width in CSS pixels — identical to the coordinate space used by click/scroll input ops. */
	width: number;
	/** Image height in CSS pixels — identical to the coordinate space used by click/scroll input ops. */
	height: number;
	/** Raw capture width before downscaling to CSS pixels (device/backing-store pixels). */
	capturedWidth?: number;
	/** Raw capture height before downscaling to CSS pixels (device/backing-store pixels). */
	capturedHeight?: number;
	devicePixelRatio?: number;
	url?: string;
	title?: string;
}

export interface ReadTextInput {
	tabId: number;
	maxChars?: number;
}

export interface ReadTextResult {
	tabId: number;
	url: string;
	title: string;
	text: string;
	/** Full innerText length before truncation. */
	length: number;
	truncated: boolean;
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
	const result: ScreenshotResult = { tabId, dataUrl, width, height };
	if (typeof record.capturedWidth === "number") result.capturedWidth = record.capturedWidth;
	if (typeof record.capturedHeight === "number") result.capturedHeight = record.capturedHeight;
	if (typeof record.devicePixelRatio === "number") result.devicePixelRatio = record.devicePixelRatio;
	if (typeof record.url === "string") result.url = record.url;
	if (typeof record.title === "string") result.title = record.title;
	return result;
}

export async function browserReadText(
	input: ReadTextInput,
	options: BrowserBridgeClientOptions = {},
): Promise<ReadTextResult> {
	if (typeof input.tabId !== "number" || !Number.isFinite(input.tabId)) {
		throw new Error("browser_read_text requires a finite tabId.");
	}
	if (
		input.maxChars !== undefined &&
		(typeof input.maxChars !== "number" || !Number.isFinite(input.maxChars) || input.maxChars <= 0)
	) {
		throw new Error("browser_read_text maxChars must be a positive finite number when provided.");
	}
	const ctx = await prepareBridge(options);
	const body: Record<string, unknown> = { tabId: input.tabId };
	if (input.maxChars !== undefined) body.maxChars = input.maxChars;
	const record = await postBridge(ctx, "/read-text", body, "read_text");
	const tabId = record.tabId;
	const url = record.url;
	const title = record.title;
	const text = record.text;
	const length = record.length;
	const truncated = record.truncated;
	if (
		typeof tabId !== "number" ||
		typeof url !== "string" ||
		typeof title !== "string" ||
		typeof text !== "string" ||
		typeof length !== "number" ||
		typeof truncated !== "boolean"
	) {
		throw malformed("read_text", JSON.stringify(record).slice(0, 200));
	}
	return { tabId, url, title, text, length, truncated };
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

export interface HoverInput {
	tabId: number;
	x: number;
	y: number;
}

export async function browserHover(input: HoverInput, options: BrowserBridgeClientOptions = {}): Promise<OkResult> {
	validatePoint(input, "browser_hover");
	const ctx = await prepareBridge(options);
	const record = await postBridge(ctx, "/input/hover", { tabId: input.tabId, x: input.x, y: input.y }, "hover");
	if (record.ok !== true) {
		throw malformed("hover", JSON.stringify(record).slice(0, 200));
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

export interface DragInput {
	tabId: number;
	/** Start point (CSS px) — same space as browser_query rects. */
	x: number;
	y: number;
	/** End point (CSS px). */
	toX: number;
	toY: number;
	/** Mouse button to hold (default "left"). */
	button?: MouseButton;
	/** Number of interpolated move events between start and end (default 12, max 100). */
	steps?: number;
	/** Pause after pressing before moving, in ms (default 0, max 2000) — for libs with a drag-start delay. */
	holdMs?: number;
}

export async function browserDrag(input: DragInput, options: BrowserBridgeClientOptions = {}): Promise<OkResult> {
	for (const field of ["tabId", "x", "y", "toX", "toY"] as const) {
		if (typeof input[field] !== "number" || !Number.isFinite(input[field])) {
			throw new Error(`browser_drag requires a finite ${field}.`);
		}
	}
	validateMouseButton(input.button, "browser_drag");
	if (
		input.steps !== undefined &&
		(typeof input.steps !== "number" || !Number.isFinite(input.steps) || input.steps < 1)
	) {
		throw new Error("browser_drag steps must be a finite number >= 1 when provided.");
	}
	if (
		input.holdMs !== undefined &&
		(typeof input.holdMs !== "number" || !Number.isFinite(input.holdMs) || input.holdMs < 0)
	) {
		throw new Error("browser_drag holdMs must be a non-negative finite number when provided.");
	}
	const ctx = await prepareBridge(options);
	const body: Record<string, unknown> = { tabId: input.tabId, x: input.x, y: input.y, toX: input.toX, toY: input.toY };
	if (input.button !== undefined) body.button = input.button;
	if (input.steps !== undefined) body.steps = input.steps;
	if (input.holdMs !== undefined) body.holdMs = input.holdMs;
	const record = await postBridge(ctx, "/input/drag", body, "drag");
	if (record.ok !== true) {
		throw malformed("drag", JSON.stringify(record).slice(0, 200));
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

export interface EvalInput {
	tabId: number;
	/** A JS expression evaluated in the page's main world. Use an IIFE for multi-statement logic. */
	expression: string;
	/** Await the expression if it returns a Promise (default true). */
	awaitPromise?: boolean;
}

export interface EvalResult {
	tabId: number;
	/** The JSON-serialized return value of the expression (null if undefined). */
	value: unknown;
}

export async function browserEval(input: EvalInput, options: BrowserBridgeClientOptions = {}): Promise<EvalResult> {
	if (typeof input.tabId !== "number" || !Number.isFinite(input.tabId)) {
		throw new Error("browser_eval requires a finite tabId.");
	}
	if (typeof input.expression !== "string" || input.expression.trim().length === 0) {
		throw new Error("browser_eval requires a non-empty expression.");
	}
	const ctx = await prepareBridge(options);
	const body: Record<string, unknown> = { tabId: input.tabId, expression: input.expression };
	if (input.awaitPromise !== undefined) body.awaitPromise = input.awaitPromise;
	const record = await postBridge(ctx, "/eval", body, "eval");
	const tabId = record.tabId;
	if (typeof tabId !== "number") throw malformed("eval", JSON.stringify(record).slice(0, 200));
	return { tabId, value: "value" in record ? record.value : null };
}

export interface ElementRect {
	x: number;
	y: number;
	width: number;
	height: number;
	/** Center in CSS pixels — pass straight to browser_click / browser_scroll. */
	centerX: number;
	centerY: number;
}

export interface ElementInfo {
	tag: string;
	rect: ElementRect;
	text: string;
	value: string | null;
	href: string | null;
	visible: boolean;
	inViewport: boolean;
}

export interface FillInput {
	tabId: number;
	selector: string;
	/**
	 * The value to set. Pass "" to clear a text field.
	 * - text/textarea/contenteditable/range/number/date: set literally.
	 * - <select>: match an option by its value OR visible label.
	 * - checkbox/radio: boolean-ish ("true"/"false"/"on"/"off"/"1"/"0") sets `.checked`.
	 */
	value: string;
	/** Also search inside open shadow roots if the selector misses the light DOM. */
	pierce?: boolean;
}

export interface FillResult {
	tabId: number;
	selector: string;
	/** The element's value after filling. */
	value: string;
}

export async function browserFill(input: FillInput, options: BrowserBridgeClientOptions = {}): Promise<FillResult> {
	if (typeof input.tabId !== "number" || !Number.isFinite(input.tabId)) {
		throw new Error("browser_fill requires a finite tabId.");
	}
	if (typeof input.selector !== "string" || input.selector.trim().length === 0) {
		throw new Error("browser_fill requires a non-empty selector.");
	}
	if (typeof input.value !== "string") {
		throw new Error('browser_fill requires a string value (use "" to clear).');
	}
	const ctx = await prepareBridge(options);
	const fillBody: Record<string, unknown> = { tabId: input.tabId, selector: input.selector, value: input.value };
	if (input.pierce !== undefined) fillBody.pierce = input.pierce;
	const record = await postBridge(ctx, "/fill", fillBody, "fill");
	const tabId = record.tabId;
	const value = record.value;
	if (typeof tabId !== "number" || typeof value !== "string") {
		throw malformed("fill", JSON.stringify(record).slice(0, 200));
	}
	return { tabId, selector: input.selector, value };
}

export interface QueryInput {
	tabId: number;
	selector: string;
	/** Return up to 50 matches in `elements` instead of the single first match in `element`. */
	all?: boolean;
	/** Scroll the first match into view (block/inline center) before measuring its rect. */
	scrollIntoView?: boolean;
	/** Also search inside open shadow roots (per-scope), so web-component content is reachable. */
	pierce?: boolean;
}

export interface QueryResult {
	tabId: number;
	selector: string;
	found: boolean;
	count: number;
	element?: ElementInfo | null;
	elements?: ElementInfo[];
}

export async function browserQuery(input: QueryInput, options: BrowserBridgeClientOptions = {}): Promise<QueryResult> {
	if (typeof input.tabId !== "number" || !Number.isFinite(input.tabId)) {
		throw new Error("browser_query requires a finite tabId.");
	}
	if (typeof input.selector !== "string" || input.selector.trim().length === 0) {
		throw new Error("browser_query requires a non-empty selector.");
	}
	const ctx = await prepareBridge(options);
	const body: Record<string, unknown> = { tabId: input.tabId, selector: input.selector };
	if (input.all !== undefined) body.all = input.all;
	if (input.scrollIntoView !== undefined) body.scrollIntoView = input.scrollIntoView;
	if (input.pierce !== undefined) body.pierce = input.pierce;
	const record = await postBridge(ctx, "/query", body, "query");
	const tabId = record.tabId;
	const found = record.found;
	const count = record.count;
	if (typeof tabId !== "number" || typeof found !== "boolean" || typeof count !== "number") {
		throw malformed("query", JSON.stringify(record).slice(0, 200));
	}
	const result: QueryResult = { tabId, selector: input.selector, found, count };
	if ("element" in record) result.element = record.element as ElementInfo | null;
	if (Array.isArray(record.elements)) result.elements = record.elements as ElementInfo[];
	return result;
}

export interface WaitForInput {
	tabId: number;
	/** Wait until this CSS selector matches an element. */
	selector?: string;
	/** Wait until this JS expression (page main world) evaluates truthy. */
	jsCondition?: string;
	/** Wait until document.readyState reaches this ("interactive" | "complete"). */
	readyState?: string;
	/** Combined with selector: also require the element to be visible. */
	visible?: boolean;
	/** Combined with selector: also search inside open shadow roots. */
	pierce?: boolean;
	/** Max time to poll in ms (default 10000, capped at 30000). */
	timeoutMs?: number;
	/** Poll interval in ms (default 150, min 50). */
	pollMs?: number;
}

export interface WaitForResult {
	tabId: number;
	ok: boolean;
	waitedMs: number;
	timedOut: boolean;
}

export async function browserWaitFor(
	input: WaitForInput,
	options: BrowserBridgeClientOptions = {},
): Promise<WaitForResult> {
	if (typeof input.tabId !== "number" || !Number.isFinite(input.tabId)) {
		throw new Error("browser_wait_for requires a finite tabId.");
	}
	if (
		(input.selector === undefined || input.selector.length === 0) &&
		(input.jsCondition === undefined || input.jsCondition.length === 0) &&
		(input.readyState === undefined || input.readyState.length === 0)
	) {
		throw new Error("browser_wait_for requires one of: selector, jsCondition, readyState.");
	}
	const ctx = await prepareBridge(options);
	const body: Record<string, unknown> = { tabId: input.tabId };
	if (input.selector !== undefined) body.selector = input.selector;
	if (input.jsCondition !== undefined) body.jsCondition = input.jsCondition;
	if (input.readyState !== undefined) body.readyState = input.readyState;
	if (input.visible !== undefined) body.visible = input.visible;
	if (input.pierce !== undefined) body.pierce = input.pierce;
	if (input.timeoutMs !== undefined) body.timeoutMs = input.timeoutMs;
	if (input.pollMs !== undefined) body.pollMs = input.pollMs;
	const record = await postBridge(ctx, "/wait-for", body, "wait_for");
	const tabId = record.tabId;
	const ok = record.ok;
	const waitedMs = record.waitedMs;
	const timedOut = record.timedOut;
	if (
		typeof tabId !== "number" ||
		typeof ok !== "boolean" ||
		typeof waitedMs !== "number" ||
		typeof timedOut !== "boolean"
	) {
		throw malformed("wait_for", JSON.stringify(record).slice(0, 200));
	}
	return { tabId, ok, waitedMs, timedOut };
}

export interface HistoryNavInput {
	tabId: number;
	/** reload only: bypass the HTTP cache. */
	bypassCache?: boolean;
}

export interface HistoryNavResult {
	tabId: number;
	url: string;
	title: string;
}

async function historyNav(
	path: string,
	op: string,
	input: HistoryNavInput,
	options: BrowserBridgeClientOptions,
): Promise<HistoryNavResult> {
	if (typeof input.tabId !== "number" || !Number.isFinite(input.tabId)) {
		throw new Error(`browser_${op} requires a finite tabId.`);
	}
	const ctx = await prepareBridge(options);
	const body: Record<string, unknown> = { tabId: input.tabId };
	if (op === "reload" && input.bypassCache !== undefined) body.bypassCache = input.bypassCache;
	const record = await postBridge(ctx, path, body, op);
	const tabId = record.tabId;
	const url = record.url;
	const title = record.title;
	if (typeof tabId !== "number" || typeof url !== "string" || typeof title !== "string") {
		throw malformed(op, JSON.stringify(record).slice(0, 200));
	}
	return { tabId, url, title };
}

export function browserBack(
	input: HistoryNavInput,
	options: BrowserBridgeClientOptions = {},
): Promise<HistoryNavResult> {
	return historyNav("/tabs/back", "back", input, options);
}

export function browserForward(
	input: HistoryNavInput,
	options: BrowserBridgeClientOptions = {},
): Promise<HistoryNavResult> {
	return historyNav("/tabs/forward", "forward", input, options);
}

export function browserReload(
	input: HistoryNavInput,
	options: BrowserBridgeClientOptions = {},
): Promise<HistoryNavResult> {
	return historyNav("/tabs/reload", "reload", input, options);
}
