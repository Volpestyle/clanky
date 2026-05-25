import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import {
	type AuthOAuthBeginResult,
	type AuthOAuthWaitResult,
	type AuthRemoveResult,
	type AuthSetApiKeyResult,
	type AuthStatusResult,
	type CronListResult,
	requestGateway,
	type SessionListResult,
	type StatusResult,
	type TaskListResult,
} from "@clanky/gateway";
import {
	type Component,
	type KeyId,
	matchesKey,
	ProcessTerminal,
	TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { WebSocket } from "ws";
import { runChat } from "./chat.ts";
import { type AuthProviderInfo, fetchAuthProviders } from "./rpc-client.ts";

export interface RunDashboardOptions {
	socketFile: string;
	watch: boolean;
	eventStreamUrl?: string;
	intervalMs?: number;
}

interface DashboardData {
	auth: AuthStatusResult;
	status: StatusResult;
	sessions: SessionListResult;
	tasks: TaskListResult;
	cron: CronListResult;
}

const DEFAULT_INTERVAL_MS = 3000;
const DEFAULT_OAUTH_WAIT_TIMEOUT_MS = 16 * 60 * 1000;
const DASHBOARD_SESSION_LIMIT = 8;
const DASHBOARD_RESUME_KEYS: readonly KeyId[] = ["1", "2", "3", "4", "5", "6", "7", "8"];
const DASHBOARD_QUIT_KEYS: readonly KeyId[] = ["ctrl+c", "q"];
const DASHBOARD_AUTH_MENU_KEYS: readonly KeyId[] = ["a"];
const DASHBOARD_CHAT_KEYS: readonly KeyId[] = ["c"];
const DASHBOARD_SCROLL_UP_KEYS: readonly KeyId[] = ["up", "k"];
const DASHBOARD_SCROLL_DOWN_KEYS: readonly KeyId[] = ["down", "j"];
const DASHBOARD_PAGE_UP_KEYS: readonly KeyId[] = ["pageUp"];
const DASHBOARD_PAGE_DOWN_KEYS: readonly KeyId[] = ["pageDown"];
const DASHBOARD_HOME_KEYS: readonly KeyId[] = ["home"];
const DASHBOARD_END_KEYS: readonly KeyId[] = ["end"];
const AUTH_BACK_KEYS: readonly KeyId[] = ["escape"];
const AUTH_SUBMIT_KEYS: readonly KeyId[] = ["return"];
const AUTH_SELECT_NUMERIC_KEYS: readonly KeyId[] = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
const TOAST_DURATION_MS = 3000;

type DashboardAction =
	| { type: "new-chat" }
	| { type: "oauth"; provider: string }
	| { sessionId: string; type: "resume-session" };

export async function runDashboard(options: RunDashboardOptions): Promise<void> {
	if (process.stdin.isTTY && process.stdout.isTTY) {
		await runInteractiveDashboard(options);
		return;
	}
	if (!options.watch) {
		process.stdout.write(`${await renderDashboard(options.socketFile)}\n`);
		return;
	}
	if (options.eventStreamUrl !== undefined) {
		await runEventDashboard(options);
		return;
	}

	let stopped = false;
	const stop = () => {
		stopped = true;
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		while (!stopped) {
			process.stdout.write("\x1b[2J\x1b[H");
			process.stdout.write(`${await renderDashboard(options.socketFile)}\n`);
			await delay(options.intervalMs ?? DEFAULT_INTERVAL_MS);
		}
	} finally {
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
	}
}

async function runInteractiveDashboard(options: RunDashboardOptions): Promise<void> {
	const initialData = await fetchDashboardData(options.socketFile);
	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal, false);
	tui.setClearOnShrink(true);
	const dashboard = new DashboardComponent(initialData, options.socketFile, () => tui.requestRender());
	tui.addChild(dashboard);
	tui.setFocus(dashboard);
	let webSocket: WebSocket | undefined;
	let interval: NodeJS.Timeout | undefined;
	let stopped = false;
	let latestSessions: SessionListResult | undefined = initialData.sessions;
	let nextAction: DashboardAction | undefined;

	const redraw = async () => {
		try {
			const data = await fetchDashboardData(options.socketFile);
			latestSessions = data.sessions;
			dashboard.setData(data);
		} catch (error) {
			dashboard.setError(error instanceof Error ? error.message : String(error));
		}
		tui.requestRender();
	};

	await new Promise<void>((resolve) => {
		const stopDashboard = (action?: DashboardAction) => {
			if (stopped) return;
			stopped = true;
			nextAction = action;
			if (interval !== undefined) clearInterval(interval);
			webSocket?.close();
			tui.stop();
			process.off("SIGINT", stop);
			process.off("SIGTERM", stop);
			resolve();
		};
		const stop = () => {
			stopDashboard();
		};
		dashboard.onExit = () => {
			stopDashboard();
		};
		dashboard.onOAuth = (provider) => {
			stopDashboard({ type: "oauth", provider });
		};
		tui.addInputListener((data) => {
			if (dashboard.isInAuthMode()) return undefined;
			if (matchesDashboardKey(data, DASHBOARD_QUIT_KEYS)) {
				stopDashboard();
				return { consume: true };
			}
			if (matchesDashboardKey(data, DASHBOARD_AUTH_MENU_KEYS)) {
				dashboard.openAuthMenu();
				return { consume: true };
			}
			if (matchesDashboardKey(data, DASHBOARD_CHAT_KEYS)) {
				stopDashboard({ type: "new-chat" });
				return { consume: true };
			}
			const sessionId = dashboardSessionIdForKey(latestSessions, data);
			if (sessionId !== undefined) {
				stopDashboard({ type: "resume-session", sessionId });
				return { consume: true };
			}
			return undefined;
		});
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
		tui.start();
		tui.requestRender(true);
		void redraw();
		interval = setInterval(() => {
			void redraw();
		}, options.intervalMs ?? DEFAULT_INTERVAL_MS);
		if (options.eventStreamUrl !== undefined) {
			webSocket = new WebSocket(options.eventStreamUrl);
			webSocket.on("message", () => {
				void redraw();
			});
			webSocket.on("error", () => {
				webSocket?.close();
			});
		}
	});

	if (nextAction?.type === "resume-session") {
		const chatOptions: Parameters<typeof runChat>[0] = {
			socketFile: options.socketFile,
			sessionId: nextAction.sessionId,
		};
		if (options.eventStreamUrl !== undefined) chatOptions.eventStreamUrl = options.eventStreamUrl;
		await runChat(chatOptions);
	}
	if (nextAction?.type === "new-chat") {
		const chatOptions: Parameters<typeof runChat>[0] = {
			socketFile: options.socketFile,
		};
		if (options.eventStreamUrl !== undefined) chatOptions.eventStreamUrl = options.eventStreamUrl;
		await runChat(chatOptions);
	}
	if (nextAction?.type === "oauth") {
		await runProviderOAuthSetup(options.socketFile, nextAction.provider);
		await runInteractiveDashboard(options);
	}
}

async function runEventDashboard(options: RunDashboardOptions): Promise<void> {
	let stopped = false;
	let webSocket: WebSocket | undefined;
	const stop = () => {
		stopped = true;
		webSocket?.close();
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		await redrawDashboard(options.socketFile);
		while (!stopped) {
			try {
				await new Promise<void>((resolve) => {
					const url = options.eventStreamUrl;
					if (url === undefined) {
						resolve();
						return;
					}
					webSocket = new WebSocket(url);
					webSocket.on("message", () => {
						redrawDashboard(options.socketFile).catch((error: unknown) => {
							process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
						});
					});
					webSocket.on("close", resolve);
					webSocket.on("error", resolve);
				});
			} finally {
				webSocket = undefined;
			}
			if (!stopped) await delay(options.intervalMs ?? DEFAULT_INTERVAL_MS);
		}
	} finally {
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
		webSocket?.close();
	}
}

async function redrawDashboard(socketFile: string): Promise<void> {
	process.stdout.write("\x1b[2J\x1b[H");
	process.stdout.write(`${await renderDashboard(socketFile)}\n`);
}

type AuthView =
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| { kind: "providers"; providers: AuthProviderInfo[]; selected: number }
	| { kind: "actions"; provider: AuthProviderInfo; actions: AuthAction[]; selected: number }
	| { kind: "api-key"; provider: AuthProviderInfo; value: string; submitting: boolean };

type AuthAction = { kind: "oauth" } | { kind: "api-key" } | { kind: "remove" };

interface Toast {
	tone: "error" | "info" | "success";
	expiresAt: number;
	text: string;
}

export interface DashboardAuthRpc {
	fetchProviders(): Promise<AuthProviderInfo[]>;
	setApiKey(provider: string, apiKey: string): Promise<AuthSetApiKeyResult>;
	removeAuth(provider: string): Promise<AuthRemoveResult>;
}

class DashboardComponent implements Component {
	onExit: (() => void) | undefined;
	onOAuth: ((provider: string) => void) | undefined;

	private data: DashboardData | undefined;
	private error: string | undefined;
	private scrollOffset = 0;
	private view: "main" | "auth" = "main";
	private authView: AuthView = { kind: "loading" };
	private toast: Toast | undefined;
	private readonly requestRender: () => void;
	private readonly rpc: DashboardAuthRpc;

	constructor(data: DashboardData, socketFile: string, requestRender: () => void, rpc?: DashboardAuthRpc) {
		this.data = data;
		this.requestRender = requestRender;
		this.rpc = rpc ?? createDefaultAuthRpc(socketFile);
	}

	setData(data: DashboardData): void {
		this.data = data;
		this.error = undefined;
	}

	setError(error: string): void {
		this.error = error;
	}

	isInAuthMode(): boolean {
		return this.view === "auth";
	}

	openAuthMenu(): void {
		this.view = "auth";
		this.authView = { kind: "loading" };
		this.requestRender();
		void this.loadProviders();
	}

	render(width: number): string[] {
		const height = Math.max(1, output.rows ?? 24);
		const viewportHeight = Math.max(1, height - 1);
		const safeWidth = Math.max(40, width);
		const content =
			this.view === "auth"
				? renderAuthMenu(this.authView, this.data?.auth, safeWidth, this.toast)
				: renderInteractiveDashboard(this.data, this.error, safeWidth, this.toast);
		const maxScrollOffset = Math.max(0, content.length - viewportHeight);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScrollOffset));
		const visible = content.slice(this.scrollOffset, this.scrollOffset + viewportHeight);
		if (this.view === "main" && maxScrollOffset > 0) {
			visible[1] = paintLine(
				`${actionsLine()}   ${scrollStatus(this.scrollOffset, viewportHeight, content.length)}`,
				safeWidth,
				ANSI_SURFACE_HEADER,
			);
		}
		return fillViewport(visible, safeWidth, height);
	}

	handleInput(data: string): void {
		if (this.view === "auth") {
			this.handleAuthInput(data);
			return;
		}
		if (matchesDashboardKey(data, DASHBOARD_SCROLL_UP_KEYS)) {
			this.scrollBy(-1);
			return;
		}
		if (matchesDashboardKey(data, DASHBOARD_SCROLL_DOWN_KEYS)) {
			this.scrollBy(1);
			return;
		}
		if (matchesDashboardKey(data, DASHBOARD_PAGE_UP_KEYS)) {
			this.scrollBy(-Math.max(4, Math.floor((output.rows ?? 24) * 0.7)));
			return;
		}
		if (matchesDashboardKey(data, DASHBOARD_PAGE_DOWN_KEYS)) {
			this.scrollBy(Math.max(4, Math.floor((output.rows ?? 24) * 0.7)));
			return;
		}
		if (matchesDashboardKey(data, DASHBOARD_HOME_KEYS)) {
			this.scrollTo(0);
			return;
		}
		if (matchesDashboardKey(data, DASHBOARD_END_KEYS)) {
			this.scrollTo(Number.MAX_SAFE_INTEGER);
		}
	}

	invalidate(): void {}

	showToast(toast: Omit<Toast, "expiresAt">, now: number = Date.now()): void {
		this.toast = { ...toast, expiresAt: now + TOAST_DURATION_MS };
		this.requestRender();
		setTimeout(() => {
			if (this.toast !== undefined && this.toast.expiresAt <= Date.now()) {
				this.toast = undefined;
				this.requestRender();
			}
		}, TOAST_DURATION_MS + 50).unref?.();
	}

	currentView(): "main" | "auth" {
		return this.view;
	}

	currentAuthView(): AuthView {
		return this.authView;
	}

	private scrollBy(delta: number): void {
		this.scrollTo(this.scrollOffset + delta);
	}

	private scrollTo(offset: number): void {
		const nextOffset = Math.max(0, offset);
		if (nextOffset === this.scrollOffset) return;
		this.scrollOffset = nextOffset;
		this.requestRender();
	}

	private async loadProviders(): Promise<void> {
		try {
			const providers = await this.rpc.fetchProviders();
			if (this.view !== "auth") return;
			if (providers.length === 0) {
				this.authView = { kind: "error", message: "No providers reported by daemon." };
			} else {
				this.authView = { kind: "providers", providers, selected: 0 };
			}
		} catch (error) {
			if (this.view !== "auth") return;
			this.authView = { kind: "error", message: error instanceof Error ? error.message : String(error) };
		}
		this.requestRender();
	}

	private handleAuthInput(data: string): void {
		if (matchesDashboardKey(data, DASHBOARD_QUIT_KEYS) && data !== "q") {
			this.onExit?.();
			return;
		}
		switch (this.authView.kind) {
			case "loading":
				if (matchesDashboardKey(data, AUTH_BACK_KEYS)) this.exitAuthMenu();
				return;
			case "error":
				if (matchesDashboardKey(data, AUTH_BACK_KEYS)) this.exitAuthMenu();
				return;
			case "providers":
				this.handleProvidersInput(data, this.authView);
				return;
			case "actions":
				this.handleActionsInput(data, this.authView);
				return;
			case "api-key":
				this.handleApiKeyInput(data, this.authView);
				return;
		}
	}

	private handleProvidersInput(data: string, view: Extract<AuthView, { kind: "providers" }>): void {
		if (matchesDashboardKey(data, AUTH_BACK_KEYS)) {
			this.exitAuthMenu();
			return;
		}
		if (matchesDashboardKey(data, DASHBOARD_SCROLL_UP_KEYS)) {
			this.authView = { ...view, selected: Math.max(0, view.selected - 1) };
			this.requestRender();
			return;
		}
		if (matchesDashboardKey(data, DASHBOARD_SCROLL_DOWN_KEYS)) {
			this.authView = { ...view, selected: Math.min(view.providers.length - 1, view.selected + 1) };
			this.requestRender();
			return;
		}
		const numericIndex = numericShortcutIndex(data, view.providers.length);
		if (numericIndex !== undefined) {
			const provider = view.providers[numericIndex];
			if (provider !== undefined) this.openProviderActions(provider);
			return;
		}
		if (matchesDashboardKey(data, AUTH_SUBMIT_KEYS)) {
			const provider = view.providers[view.selected];
			if (provider !== undefined) this.openProviderActions(provider);
		}
	}

	private handleActionsInput(data: string, view: Extract<AuthView, { kind: "actions" }>): void {
		if (matchesDashboardKey(data, AUTH_BACK_KEYS)) {
			this.returnToProviders();
			return;
		}
		if (matchesDashboardKey(data, DASHBOARD_SCROLL_UP_KEYS)) {
			this.authView = { ...view, selected: Math.max(0, view.selected - 1) };
			this.requestRender();
			return;
		}
		if (matchesDashboardKey(data, DASHBOARD_SCROLL_DOWN_KEYS)) {
			this.authView = { ...view, selected: Math.min(view.actions.length - 1, view.selected + 1) };
			this.requestRender();
			return;
		}
		const numericIndex = numericShortcutIndex(data, view.actions.length);
		if (numericIndex !== undefined) {
			const action = view.actions[numericIndex];
			if (action !== undefined) this.invokeAuthAction(view.provider, action);
			return;
		}
		if (matchesDashboardKey(data, AUTH_SUBMIT_KEYS)) {
			const action = view.actions[view.selected];
			if (action !== undefined) this.invokeAuthAction(view.provider, action);
		}
	}

	private handleApiKeyInput(data: string, view: Extract<AuthView, { kind: "api-key" }>): void {
		if (view.submitting) return;
		if (matchesDashboardKey(data, AUTH_BACK_KEYS)) {
			this.openProviderActions(view.provider);
			return;
		}
		if (matchesDashboardKey(data, AUTH_SUBMIT_KEYS)) {
			const value = view.value.trim();
			if (value.length === 0) {
				this.showToast({ tone: "error", text: "API key cannot be empty" });
				return;
			}
			this.authView = { ...view, submitting: true };
			this.requestRender();
			void this.submitApiKey(view.provider, value);
			return;
		}
		const nextValue = applyMaskedInput(view.value, data);
		if (nextValue !== view.value) {
			this.authView = { ...view, value: nextValue };
			this.requestRender();
		}
	}

	private async submitApiKey(provider: AuthProviderInfo, apiKey: string): Promise<void> {
		try {
			await this.rpc.setApiKey(provider.id, apiKey);
			this.showToast({ tone: "success", text: `Stored ${provider.name} API key` });
			this.openProviderActions(provider);
		} catch (error) {
			this.showToast({ tone: "error", text: error instanceof Error ? error.message : String(error) });
			if (this.authView.kind === "api-key") {
				this.authView = { ...this.authView, submitting: false };
				this.requestRender();
			}
		}
	}

	private async removeProviderAuth(provider: AuthProviderInfo): Promise<void> {
		try {
			await this.rpc.removeAuth(provider.id);
			this.showToast({ tone: "success", text: `Removed ${provider.name} credentials` });
			this.openProviderActions(provider);
		} catch (error) {
			this.showToast({ tone: "error", text: error instanceof Error ? error.message : String(error) });
		}
	}

	private invokeAuthAction(provider: AuthProviderInfo, action: AuthAction): void {
		if (action.kind === "oauth") {
			this.onOAuth?.(provider.id);
			return;
		}
		if (action.kind === "api-key") {
			this.authView = { kind: "api-key", provider, value: "", submitting: false };
			this.requestRender();
			return;
		}
		if (action.kind === "remove") void this.removeProviderAuth(provider);
	}

	private openProviderActions(provider: AuthProviderInfo): void {
		const actions = providerActionsFor(provider, this.data?.auth);
		this.authView = { kind: "actions", provider, actions, selected: 0 };
		this.requestRender();
	}

	private returnToProviders(): void {
		const providers = providersFromAuthView(this.authView);
		if (providers !== undefined) {
			this.authView = { kind: "providers", providers: providers.list, selected: providers.selected };
		} else {
			this.authView = { kind: "loading" };
			void this.loadProviders();
		}
		this.requestRender();
	}

	private exitAuthMenu(): void {
		this.view = "main";
		this.authView = { kind: "loading" };
		this.requestRender();
	}
}

function createDefaultAuthRpc(socketFile: string): DashboardAuthRpc {
	return {
		fetchProviders: () => fetchAuthProviders(socketFile),
		setApiKey: (provider, apiKey) =>
			requestGateway({
				socketFile,
				method: "auth.set_api_key",
				params: { provider, apiKey },
			}) as Promise<AuthSetApiKeyResult>,
		removeAuth: (provider) =>
			requestGateway({
				socketFile,
				method: "auth.remove",
				params: { provider },
			}) as Promise<AuthRemoveResult>,
	};
}

function providersFromAuthView(view: AuthView): { list: AuthProviderInfo[]; selected: number } | undefined {
	if (view.kind === "actions") {
		return { list: [view.provider], selected: 0 };
	}
	return undefined;
}

function providerActionsFor(provider: AuthProviderInfo, auth: AuthStatusResult | undefined): AuthAction[] {
	const actions: AuthAction[] = [];
	if (provider.supportsOAuth) actions.push({ kind: "oauth" });
	if (provider.supportsApiKey) actions.push({ kind: "api-key" });
	if (auth !== undefined) {
		const stored = auth.providers.find((entry) => entry.provider === provider.id);
		if (stored?.configured && stored.source === "stored") {
			actions.push({ kind: "remove" });
		}
	}
	return actions;
}

function applyMaskedInput(current: string, data: string): string {
	if (data === "" || data === "\b") return current.slice(0, -1);
	if (data === "") return "";
	let next = current;
	for (const char of data) {
		if (char === "\r" || char === "\n" || char === "") return next;
		if (char === "" || char === "\b") {
			next = next.slice(0, -1);
			continue;
		}
		if (char < " ") continue;
		next += char;
	}
	return next;
}

function numericShortcutIndex(data: string, max: number): number | undefined {
	const limit = Math.min(max, AUTH_SELECT_NUMERIC_KEYS.length);
	for (let index = 0; index < limit; index++) {
		const candidate = AUTH_SELECT_NUMERIC_KEYS[index];
		if (candidate !== undefined && matchesKey(data, candidate)) return index;
	}
	return undefined;
}

const ANSI_RESET = "\x1b[0m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_BOLD_RESET = "\x1b[22m";
const ANSI_FG_RESET = "\x1b[39m";
const ANSI_SURFACE_HEADER = "";
const ANSI_SURFACE_PANEL = "";

const COLOR_ACCENT = 81;
const COLOR_BORDER = 244;
const COLOR_ERROR = 203;
const COLOR_MUTED = 245;
const COLOR_SUCCESS = 114;
const COLOR_TEXT = 252;
const COLOR_WARNING = 221;

function renderInteractiveDashboard(
	data: DashboardData | undefined,
	error: string | undefined,
	width: number,
	toast: Toast | undefined,
): string[] {
	const safeWidth = Math.max(40, width);
	const lines: string[] = [
		paintLine(headerLine(data), safeWidth, ANSI_SURFACE_HEADER),
		paintLine(actionsLine(), safeWidth, ANSI_SURFACE_PANEL),
	];
	if (toast !== undefined && toast.expiresAt > Date.now()) {
		lines.push(paintLine(toastLine(toast), safeWidth, ANSI_SURFACE_PANEL));
	}
	lines.push(paintLine("", safeWidth, ANSI_SURFACE_PANEL));
	if (error !== undefined) {
		lines.push(...renderSinglePanel("Error", [fg(COLOR_ERROR, error)], safeWidth, 5));
		return lines;
	}
	if (data === undefined) {
		lines.push(...renderSinglePanel("Loading", [muted("Waiting for daemon data...")], safeWidth, 5));
		return lines;
	}

	if (safeWidth >= 96) {
		const leftWidth = Math.floor((safeWidth - 3) * 0.48);
		const rightWidth = safeWidth - leftWidth - 3;
		lines.push(
			...joinPanels(
				panel("Daemon", statusPanelLines(data.status), leftWidth, 8),
				panel("Model Auth", authPanelLines(data.auth), rightWidth, 8),
				safeWidth,
			),
		);
	} else {
		lines.push(...renderSinglePanel("Daemon", statusPanelLines(data.status), safeWidth, 8));
		lines.push(...renderSinglePanel("Model Auth", authPanelLines(data.auth), safeWidth, 8));
	}

	lines.push(paintLine("", safeWidth, ANSI_SURFACE_PANEL));
	lines.push(...renderSinglePanel("Sessions", sessionsPanelLines(data.sessions), safeWidth, 6));
	lines.push(paintLine("", safeWidth, ANSI_SURFACE_PANEL));
	if (safeWidth >= 112) {
		const leftWidth = Math.floor((safeWidth - 3) * 0.5);
		const rightWidth = safeWidth - leftWidth - 3;
		lines.push(
			...joinPanels(
				panel("Tasks", tasksPanelLines(data.tasks), leftWidth, 7),
				panel("Cron", cronPanelLines(data.cron), rightWidth, 7),
				safeWidth,
			),
		);
	} else {
		lines.push(...renderSinglePanel("Tasks", tasksPanelLines(data.tasks), safeWidth, 7));
		lines.push(...renderSinglePanel("Cron", cronPanelLines(data.cron), safeWidth, 7));
	}
	return lines;
}

export function renderAuthMenu(
	view: AuthView,
	auth: AuthStatusResult | undefined,
	width: number,
	toast: Toast | undefined,
): string[] {
	const safeWidth = Math.max(40, width);
	const lines: string[] = [
		paintLine(bold(fg(COLOR_ACCENT, "Clanky Auth")), safeWidth, ANSI_SURFACE_HEADER),
		paintLine(authActionsLine(view), safeWidth, ANSI_SURFACE_PANEL),
	];
	if (toast !== undefined && toast.expiresAt > Date.now()) {
		lines.push(paintLine(toastLine(toast), safeWidth, ANSI_SURFACE_PANEL));
	}
	lines.push(paintLine("", safeWidth, ANSI_SURFACE_PANEL));
	lines.push(...renderSinglePanel(authPanelTitle(view), authPanelBody(view, auth, safeWidth), safeWidth, 8));
	return lines;
}

function authPanelTitle(view: AuthView): string {
	if (view.kind === "providers") return "Select Provider";
	if (view.kind === "actions") return `Provider: ${view.provider.name}`;
	if (view.kind === "api-key") return `Paste API key: ${view.provider.name}`;
	if (view.kind === "loading") return "Auth";
	return "Auth Error";
}

function authPanelBody(view: AuthView, auth: AuthStatusResult | undefined, width: number): string[] {
	if (view.kind === "loading") return [muted("Loading providers...")];
	if (view.kind === "error") return [fg(COLOR_ERROR, view.message), "", muted("Press Esc to return.")];
	if (view.kind === "providers") {
		return view.providers.map((provider, index) => {
			const marker = index === view.selected ? fg(COLOR_ACCENT, ">") : " ";
			const shortcut = index < AUTH_SELECT_NUMERIC_KEYS.length ? `[${index + 1}]` : "   ";
			const stored = auth?.providers.find((entry) => entry.provider === provider.id);
			const status = stored?.configured ? fg(COLOR_SUCCESS, "stored") : muted("missing");
			const methods = providerMethodsLabel(provider);
			return `${marker} ${key(shortcut)} ${fixedCell(provider.name, 24)}  ${fixedAnsiCell(status, 10)}  ${muted(methods)}`;
		});
	}
	if (view.kind === "actions") {
		if (view.actions.length === 0) return [muted("No actions available for this provider.")];
		return view.actions.map((action, index) => {
			const marker = index === view.selected ? fg(COLOR_ACCENT, ">") : " ";
			const shortcut = index < AUTH_SELECT_NUMERIC_KEYS.length ? `[${index + 1}]` : "   ";
			return `${marker} ${key(shortcut)} ${authActionLabel(action)}`;
		});
	}
	const masked = "•".repeat(view.value.length);
	const inputWidth = Math.max(8, width - 12);
	const cursor = view.submitting ? "" : fg(COLOR_ACCENT, "_");
	const display = truncateToWidth(`${masked}${cursor}`, inputWidth, "");
	return [
		muted(`Provider: ${view.provider.name} (${view.provider.id})`),
		"",
		`  ${border("|")} ${fitAnsi(display, inputWidth)} ${border("|")}`,
		"",
		view.submitting ? muted("Submitting...") : muted("Enter saves. Esc cancels. Input is hidden."),
	];
}

function authActionLabel(action: AuthAction): string {
	if (action.kind === "oauth") return "Sign in with OAuth";
	if (action.kind === "api-key") return "Paste API key";
	return "Remove stored credentials";
}

function providerMethodsLabel(provider: AuthProviderInfo): string {
	const parts: string[] = [];
	if (provider.supportsOAuth) parts.push("oauth");
	if (provider.supportsApiKey) parts.push("api-key");
	return parts.length === 0 ? "no methods" : parts.join(", ");
}

function authActionsLine(view: AuthView): string {
	if (view.kind === "providers")
		return `${muted("Actions")}  ${key("[Up/Down]")} select   ${key("[Enter]")} open   ${key("[1-9]")} jump   ${key("[Esc]")} back`;
	if (view.kind === "actions")
		return `${muted("Actions")}  ${key("[Up/Down]")} select   ${key("[Enter]")} run   ${key("[1-9]")} jump   ${key("[Esc]")} back`;
	if (view.kind === "api-key")
		return `${muted("Actions")}  ${key("[Enter]")} save   ${key("[Esc]")} cancel   ${key("[Backspace]")} delete`;
	return `${muted("Actions")}  ${key("[Esc]")} back`;
}

function toastLine(toast: Toast): string {
	const color = toast.tone === "error" ? COLOR_ERROR : toast.tone === "success" ? COLOR_SUCCESS : COLOR_WARNING;
	return `${muted("status")}  ${fg(color, toast.text)}`;
}

function headerLine(data: DashboardData | undefined): string {
	const profile = data?.status.profile ?? "default";
	const live = data?.status.liveSessions ?? 0;
	return `${bold(fg(COLOR_ACCENT, "Clanky Dashboard"))}  ${muted("profile")} ${fg(
		COLOR_TEXT,
		profile,
	)}  ${muted("live")} ${statusTone(live > 0, String(live))}`;
}

function actionsLine(): string {
	return `${muted("Actions")}  ${key("[c]")} chat   ${key("[a]")} auth menu   ${key("[1-8]")} resume   ${key("[PgUp/PgDn]")} scroll   ${key("[q]")} quit`;
}

function scrollStatus(scrollOffset: number, viewportHeight: number, totalLines: number): string {
	const start = Math.min(totalLines, scrollOffset + 1);
	const end = Math.min(totalLines, scrollOffset + viewportHeight);
	return muted(`${start}-${end}/${totalLines}`);
}

function statusPanelLines(status: StatusResult): string[] {
	const uptimeSeconds = Math.floor(status.uptimeMs / 1000);
	return [
		field("Daemon", `${statusTone(true, "running")} ${muted(`pid ${status.pid}`)} ${muted(`up ${uptimeSeconds}s`)}`),
		field("Profile", `${status.profile} ${muted(status.profileDir)}`),
		field("Sessions", `${status.liveSessions} live`),
		field("Linear", `${booleanText(status.linearConfigured)} ${muted(`outbox ${status.linearOutboxPending}`)}`),
		field("Cron", `${status.enabledCronJobs}/${status.cronJobs} enabled`),
		...status.warnings.map((warning) => fg(COLOR_WARNING, warning)),
	];
}

function authPanelLines(auth: AuthStatusResult): string[] {
	const openAi = auth.providers.find((provider) => provider.provider === "openai");
	const openAiCodex = auth.providers.find((provider) => provider.provider === "openai-codex");
	const authProviders = auth.authProviders.length === 0 ? muted("none") : auth.authProviders.join(", ");
	const availableProviders = auth.availableProviders.length === 0 ? muted("none") : auth.availableProviders.join(", ");
	return [
		field("Credentials", booleanText(auth.configured)),
		field("Models", `${auth.availableModels} ${muted("available")}`),
		field("Providers", availableProviders),
		field("Stored", authProviders),
		field("OpenAI", providerText(openAi)),
		field("Codex OAuth", providerText(openAiCodex)),
		field("Auth file", muted(auth.authFile)),
	];
}

function sessionsPanelLines(result: SessionListResult): string[] {
	if (result.sessions.length === 0) return [muted("No sessions")];
	const lines = [muted("Key  Session   State  Msgs  Label")];
	let shortcutIndex = 0;
	for (const session of result.sessions.slice(0, DASHBOARD_SESSION_LIMIT)) {
		const state = session.live ? fg(COLOR_SUCCESS, "live") : muted("saved");
		const shortcut =
			session.sessionFile === undefined || shortcutIndex >= DASHBOARD_RESUME_KEYS.length
				? "-"
				: DASHBOARD_RESUME_KEYS[shortcutIndex++];
		const label = session.name ?? session.firstMessage ?? "";
		lines.push(
			`${key(`[${shortcut}]`)} ${fixedCell(session.id.slice(0, 8), 8)}  ${fixedAnsiCell(state, 5)}  ${fixedCell(
				`${session.messageCount ?? 0}`,
				4,
			)}  ${label}`,
		);
	}
	if (result.sessions.length > DASHBOARD_SESSION_LIMIT)
		lines.push(muted(`${result.sessions.length - DASHBOARD_SESSION_LIMIT} more sessions`));
	return lines;
}

function tasksPanelLines(result: TaskListResult): string[] {
	if (result.tasks.length === 0) return [muted("No tasks")];
	const lines = [muted("Task      Status       Pri     Linear        Session")];
	for (const task of result.tasks.slice(0, 8)) {
		const linear = task.linearIssue ?? "-";
		const session = task.sessionId?.slice(0, 8) ?? "-";
		lines.push(
			`${fixedCell(task.id.slice(0, 8), 8)}  ${fixedCell(task.status, 11)}  ${fixedCell(
				task.priority,
				6,
			)}  ${fixedCell(linear, 12)}  ${fixedCell(session, 8)}  ${task.title}`,
		);
	}
	if (result.tasks.length > 8) lines.push(muted(`${result.tasks.length - 8} more tasks`));
	return lines;
}

function cronPanelLines(result: CronListResult): string[] {
	if (result.jobs.length === 0) return [muted("No cron jobs")];
	const lines = [muted("Job       State     Next          Schedule")];
	for (const job of result.jobs.slice(0, 8)) {
		const state = job.enabled ? fg(COLOR_SUCCESS, "enabled") : muted("disabled");
		lines.push(
			`${fixedCell(job.id.slice(0, 8), 8)}  ${fixedAnsiCell(state, 8)}  ${fixedCell(
				nextFireCountdown(job.nextFire),
				12,
			)}  ${job.schedule}`,
		);
	}
	if (result.jobs.length > 8) lines.push(muted(`${result.jobs.length - 8} more cron jobs`));
	return lines;
}

function panel(title: string, body: string[], width: number, minBodyRows: number): string[] {
	const safeWidth = Math.max(24, width);
	const innerWidth = safeWidth - 4;
	const rows = body.slice(0, Math.max(minBodyRows, body.length));
	while (rows.length < minBodyRows) rows.push("");
	const titleText = ` ${title} `;
	const titleWidth = visibleWidth(titleText);
	const ruleWidth = Math.max(0, safeWidth - titleWidth - 3);
	const top = `${border("+")}${border("-")}${bold(fg(COLOR_TEXT, titleText))}${border(
		"-".repeat(ruleWidth),
	)}${border("+")}`;
	const rendered = [fitAnsi(top, safeWidth)];
	for (const row of rows) {
		rendered.push(`${border("|")} ${fitAnsi(row, innerWidth)} ${border("|")}`);
	}
	rendered.push(border(`+${"-".repeat(safeWidth - 2)}+`));
	return rendered;
}

function renderSinglePanel(title: string, body: string[], width: number, minBodyRows: number): string[] {
	return panel(title, body, width, minBodyRows).map((line) => paintLine(line, width, ANSI_SURFACE_PANEL));
}

function joinPanels(left: string[], right: string[], width: number): string[] {
	const rows = Math.max(left.length, right.length);
	const leftWidth = visibleWidth(left[0] ?? "");
	const rightWidth = visibleWidth(right[0] ?? "");
	const result: string[] = [];
	for (let index = 0; index < rows; index++) {
		const row = `${fitAnsi(left[index] ?? "", leftWidth)}${" ".repeat(3)}${fitAnsi(right[index] ?? "", rightWidth)}`;
		result.push(paintLine(row, width, ANSI_SURFACE_PANEL));
	}
	return result;
}

function fillViewport(lines: string[], width: number, height: number): string[] {
	const result = lines.slice(0, Math.max(1, height - 1));
	while (result.length < Math.max(1, height - 1)) result.push(paintLine("", width, ANSI_SURFACE_PANEL));
	return result;
}

function field(label: string, value: string): string {
	return `${muted(fixedCell(label, 12))} ${value}`;
}

function booleanText(value: boolean): string {
	return value ? fg(COLOR_SUCCESS, "set") : fg(COLOR_WARNING, "missing");
}

function providerText(provider: AuthStatusResult["providers"][number] | undefined): string {
	if (provider === undefined || !provider.configured) return fg(COLOR_WARNING, "missing");
	if (provider.source === "environment" && provider.label !== undefined)
		return fg(COLOR_SUCCESS, `env:${provider.label}`);
	if (provider.source === "stored") return fg(COLOR_SUCCESS, "stored");
	return fg(COLOR_SUCCESS, provider.source ?? "configured");
}

function statusTone(ok: boolean, text: string): string {
	return fg(ok ? COLOR_SUCCESS : COLOR_WARNING, text);
}

function key(text: string): string {
	return bold(fg(COLOR_ACCENT, text));
}

function border(text: string): string {
	return fg(COLOR_BORDER, text);
}

function muted(text: string): string {
	return fg(COLOR_MUTED, text);
}

function bold(text: string): string {
	return `${ANSI_BOLD}${text}${ANSI_BOLD_RESET}`;
}

function fg(color: number, text: string): string {
	return `\x1b[38;5;${color}m${text}${ANSI_FG_RESET}`;
}

function paintLine(text: string, width: number, background: string): string {
	const line = fitAnsi(text, width);
	return `${background}${line}${ANSI_RESET}`;
}

function fitAnsi(text: string, width: number): string {
	const truncated = truncateToWidth(text, width, "");
	return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function fixedAnsiCell(value: string, width: number): string {
	const text = truncateToWidth(value.replace(/\s+/g, " ").trim(), width);
	return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

export async function renderDashboard(socketFile: string): Promise<string> {
	const data = await fetchDashboardData(socketFile);
	return renderDashboardData(data);
}

function renderDashboardData(data: DashboardData): string {
	return [
		"Clanky Dashboard",
		"================",
		"",
		"Actions: [c] chat  [a] auth menu  [1-8] resume  [q] quit",
		"",
		renderStatus(data.status),
		"",
		renderAuth(data.auth),
		"",
		renderSessions(data.sessions),
		"",
		renderTasks(data.tasks),
		"",
		renderCron(data.cron),
	].join("\n");
}

async function fetchDashboardData(socketFile: string): Promise<DashboardData> {
	const [auth, status, sessions, tasks, cron] = await Promise.all([
		requestGateway({ socketFile, method: "auth.status" }) as Promise<AuthStatusResult>,
		requestGateway({ socketFile, method: "status" }) as Promise<StatusResult>,
		requestGateway({ socketFile, method: "session.list" }) as Promise<SessionListResult>,
		requestGateway({ socketFile, method: "task.list", params: { limit: 8 } }) as Promise<TaskListResult>,
		requestGateway({ socketFile, method: "cron.list" }) as Promise<CronListResult>,
	]);
	return { auth, status, sessions, tasks, cron };
}

function renderStatus(status: StatusResult): string {
	const uptimeSeconds = Math.floor(status.uptimeMs / 1000);
	return [
		`Daemon: running pid=${status.pid} uptime=${uptimeSeconds}s`,
		`Profile: ${status.profile} (${status.profileDir})`,
		`Sessions: ${status.liveSessions} live`,
		`Linear: configured=${status.linearConfigured} outbox_pending=${status.linearOutboxPending}`,
		`Cron: ${status.enabledCronJobs}/${status.cronJobs} enabled`,
		...status.warnings.map((warning) => `Warning: ${warning}`),
	].join("\n");
}

function renderAuth(auth: AuthStatusResult): string {
	const openAi = auth.providers.find((provider) => provider.provider === "openai");
	const openAiCodex = auth.providers.find((provider) => provider.provider === "openai-codex");
	const authProviders = auth.authProviders.length === 0 ? "none" : auth.authProviders.join(",");
	const availableProviders = auth.availableProviders.length === 0 ? "none" : auth.availableProviders.join(",");
	return [
		"Model Auth",
		`  credentials=${auth.configured ? "set" : "missing"} available_models=${auth.availableModels} available_providers=${availableProviders}`,
		`  stored_providers=${authProviders}`,
		`  OpenAI: ${formatProviderAuth(openAi)}`,
		`  OpenAI Codex OAuth: ${formatProviderAuth(openAiCodex)}`,
		`  auth_file=${auth.authFile}`,
	].join("\n");
}

function formatProviderAuth(provider: AuthStatusResult["providers"][number] | undefined): string {
	if (provider === undefined || !provider.configured) return "missing";
	if (provider.source === "environment" && provider.label !== undefined) return `environment:${provider.label}`;
	if (provider.source === "stored") return "stored";
	return provider.source ?? "configured";
}

async function runProviderOAuthSetup(socketFile: string, provider: string): Promise<void> {
	const begin = (await requestGateway({
		socketFile,
		method: "auth.oauth.begin",
		params: { provider },
	})) as AuthOAuthBeginResult;
	output.write(`\n${provider} OAuth\n${"=".repeat(provider.length + 6)}\n`);
	output.write(`${begin.instructions}\n\n`);
	output.write(`URL: ${begin.verificationUrl}\n`);
	output.write(`Code: ${begin.userCode}\n`);
	output.write(`Expires: ${begin.expiresAt}\n\n`);
	output.write("Waiting for login to complete...\n");
	const result = (await requestGateway({
		socketFile,
		method: "auth.oauth.wait",
		params: { loginId: begin.loginId },
		timeoutMs: oauthWaitTimeoutMs(begin.expiresAt),
	})) as AuthOAuthWaitResult;
	output.write(`Stored ${provider} OAuth. available_models=${result.status.availableModels}\n\n`);
	if (input.isTTY && output.isTTY) {
		const reader = createInterface({ input, output });
		try {
			await reader.question("Press Enter to return to the dashboard...");
		} finally {
			reader.close();
		}
	}
}

function oauthWaitTimeoutMs(expiresAt: string): number {
	const expiresAtMs = Date.parse(expiresAt);
	if (!Number.isFinite(expiresAtMs)) return DEFAULT_OAUTH_WAIT_TIMEOUT_MS;
	return Math.max(60_000, expiresAtMs - Date.now() + 60_000);
}

function renderSessions(result: SessionListResult): string {
	const lines = ["Sessions"];
	if (result.sessions.length === 0) {
		lines.push("  none");
		return lines.join("\n");
	}
	let shortcutIndex = 0;
	for (const session of result.sessions.slice(0, DASHBOARD_SESSION_LIMIT)) {
		const state = session.live ? "live" : "saved";
		const label = session.name ?? session.firstMessage ?? "";
		const shortcut =
			session.sessionFile === undefined || shortcutIndex >= DASHBOARD_RESUME_KEYS.length
				? "-"
				: DASHBOARD_RESUME_KEYS[shortcutIndex++];
		lines.push(
			`  [${shortcut}] ${session.id.slice(0, 8)}  ${fixedCell(state, 5)}  ${fixedCell(`${session.messageCount ?? 0}`, 4)}  ${fixedCell(label, 60)}`,
		);
	}
	if (result.sessions.length > DASHBOARD_SESSION_LIMIT)
		lines.push(`  ... ${result.sessions.length - DASHBOARD_SESSION_LIMIT} more`);
	return lines.join("\n");
}

function renderTasks(result: TaskListResult): string {
	const lines = ["Tasks"];
	if (result.tasks.length === 0) {
		lines.push("  none");
		return lines.join("\n");
	}
	for (const task of result.tasks.slice(0, 8)) {
		const linear = task.linearIssue ?? "-";
		const session = task.sessionId?.slice(0, 8) ?? "-";
		lines.push(
			`  ${task.id.slice(0, 8)}  ${fixedCell(task.status, 11)}  ${fixedCell(task.priority, 6)}  ${fixedCell(linear, 12)}  ${fixedCell(session, 8)}  ${fixedCell(task.title, 52)}`,
		);
	}
	if (result.tasks.length > 8) lines.push(`  ... ${result.tasks.length - 8} more`);
	return lines.join("\n");
}

function renderCron(result: CronListResult): string {
	const lines = ["Cron"];
	if (result.jobs.length === 0) {
		lines.push("  none");
		return lines.join("\n");
	}
	for (const job of result.jobs.slice(0, 8)) {
		const state = job.enabled ? "enabled" : "disabled";
		lines.push(
			`  ${job.id.slice(0, 8)}  ${fixedCell(state, 8)}  ${fixedCell(nextFireCountdown(job.nextFire), 12)}  ${fixedCell(job.nextFire ?? "(none)", 24)}  ${fixedCell(job.schedule, 28)}`,
		);
	}
	if (result.jobs.length > 8) lines.push(`  ... ${result.jobs.length - 8} more`);
	return lines.join("\n");
}

function nextFireCountdown(nextFire: string | undefined, now = Date.now()): string {
	if (nextFire === undefined) return "(none)";
	const nextTime = Date.parse(nextFire);
	if (!Number.isFinite(nextTime)) return "invalid";
	const totalSeconds = Math.ceil((nextTime - now) / 1000);
	if (totalSeconds <= 0) return "due";
	const days = Math.floor(totalSeconds / 86_400);
	const hours = Math.floor((totalSeconds % 86_400) / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	if (days > 0) return `in ${days}d ${hours}h`;
	if (hours > 0) return `in ${hours}h ${minutes}m`;
	if (minutes > 0) return `in ${minutes}m`;
	return `in ${totalSeconds}s`;
}

function fixedCell(value: string, width: number): string {
	const text = truncateToWidth(value.replace(/\s+/g, " ").trim(), width);
	return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

export function dashboardSessionIdForKey(sessions: SessionListResult | undefined, keyData: string): string | undefined {
	if (sessions === undefined) return undefined;
	const keyIndex = DASHBOARD_RESUME_KEYS.findIndex((key) => matchesKey(keyData, key));
	if (keyIndex === -1) return undefined;
	return resumableDashboardSessions(sessions)[keyIndex]?.id;
}

function resumableDashboardSessions(sessions: SessionListResult): SessionListResult["sessions"] {
	return sessions.sessions.slice(0, DASHBOARD_SESSION_LIMIT).filter((session) => session.sessionFile !== undefined);
}

function matchesDashboardKey(keyData: string, keys: readonly KeyId[]): boolean {
	return keys.some((key) => matchesKey(keyData, key));
}

async function delay(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

export { DashboardComponent, applyMaskedInput };
export type { AuthAction, AuthView, Toast };
