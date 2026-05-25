import type { AuthRemoveResult, AuthSetApiKeyResult, AuthStatusResult } from "@clanky/gateway";
import { applyMaskedInput, type DashboardAuthRpc, DashboardComponent } from "../src/dashboard.ts";
import type { AuthProviderInfo } from "../src/rpc-client.ts";

const baseAuth: AuthStatusResult = {
	authFile: "/tmp/auth.json",
	authProviders: [],
	availableModels: 0,
	availableProviders: [],
	configured: false,
	providers: [],
	totalModels: 0,
	totalProviders: [],
};

const baseStatus = {
	cronJobs: 0,
	daemonLockFile: "/tmp/daemon.lock",
	enabledCronJobs: 0,
	externalMcpServers: [],
	homeDir: "/tmp/home",
	linearConfigured: false,
	linearOutboxPending: 0,
	liveSessions: 0,
	ok: true as const,
	pid: 1,
	profile: "default",
	profileDir: "/tmp/profile",
	running: true as const,
	sessionIds: [],
	socketFile: "/tmp/socket",
	uptimeMs: 0,
	warnings: [],
};

const baseData = {
	auth: baseAuth,
	status: baseStatus,
	sessions: { sessions: [] },
	tasks: { tasks: [] },
	cron: { jobs: [] },
};

const providers: AuthProviderInfo[] = [
	{ id: "anthropic", name: "Anthropic", supportsOAuth: true, supportsApiKey: true },
	{ id: "openai", name: "OpenAI", supportsOAuth: false, supportsApiKey: true },
];

const ESC = String.fromCharCode(27);
const DEL = String.fromCharCode(127);
const CTRL_U = String.fromCharCode(21);
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

function stubSetApiKey(provider: string, _apiKey: string): Promise<AuthSetApiKeyResult> {
	return Promise.resolve({ provider, status: baseAuth });
}

function defaultRemove(): Promise<AuthRemoveResult> {
	return Promise.resolve({ provider: "openai", status: baseAuth });
}

function visiblePlain(lines: string[]): string {
	return lines.join("\n").replaceAll(ANSI_PATTERN, "");
}

async function waitForCondition(check: () => boolean, label: string): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for: ${label}`);
}

async function testMenuOpenCloseProvidersRender(): Promise<void> {
	let renders = 0;
	const rpc: DashboardAuthRpc = {
		fetchProviders: () => Promise.resolve(providers),
		setApiKey: stubSetApiKey,
		removeAuth: defaultRemove,
	};
	const dashboard = new DashboardComponent(
		baseData,
		"/tmp/socket",
		() => {
			renders++;
		},
		rpc,
	);
	if (dashboard.isInAuthMode()) throw new Error("Dashboard should start on main view");
	dashboard.openAuthMenu();
	if (!dashboard.isInAuthMode()) throw new Error("openAuthMenu did not switch to auth view");
	await waitForCondition(() => dashboard.currentAuthView().kind === "providers", "providers loaded");
	const view1 = dashboard.currentAuthView();
	if (view1.kind !== "providers" || view1.providers.length !== 2) {
		throw new Error(`Expected providers list, got ${JSON.stringify(view1)}`);
	}
	const rendered = visiblePlain(dashboard.render(120));
	if (!rendered.includes("Clanky Auth")) throw new Error(`Auth header missing: ${rendered}`);
	if (!rendered.includes("Anthropic") || !rendered.includes("OpenAI"))
		throw new Error(`Provider names missing: ${rendered}`);
	if (!rendered.includes("oauth, api-key")) throw new Error(`Method label missing: ${rendered}`);
	if (!rendered.includes("[1]") || !rendered.includes("[2]")) throw new Error(`Numeric shortcuts missing: ${rendered}`);
	dashboard.handleInput(ESC);
	if (dashboard.isInAuthMode()) throw new Error("Esc on providers list did not return to main");
	if (renders === 0) throw new Error("requestRender was not invoked");
}

async function testMaskedApiKeyEntry(): Promise<void> {
	let savedKey: string | undefined;
	let savedProvider: string | undefined;
	const rpc: DashboardAuthRpc = {
		fetchProviders: () => Promise.resolve(providers),
		setApiKey: (provider, apiKey) => {
			savedProvider = provider;
			savedKey = apiKey;
			return Promise.resolve({ provider, status: baseAuth });
		},
		removeAuth: defaultRemove,
	};
	const dashboard = new DashboardComponent(baseData, "/tmp/socket", () => {}, rpc);
	dashboard.openAuthMenu();
	await waitForCondition(() => dashboard.currentAuthView().kind === "providers", "providers loaded");
	dashboard.handleInput("2");
	const actionsView = dashboard.currentAuthView();
	if (actionsView.kind !== "actions" || actionsView.provider.id !== "openai") {
		throw new Error(`Expected openai actions view, got ${JSON.stringify(actionsView)}`);
	}
	dashboard.handleInput("1");
	const apiKeyView = dashboard.currentAuthView();
	if (apiKeyView.kind !== "api-key") throw new Error(`Expected api-key view, got ${JSON.stringify(apiKeyView)}`);
	const secret = "sk-test-12345";
	for (const char of secret) dashboard.handleInput(char);
	const mid = dashboard.currentAuthView();
	if (mid.kind !== "api-key" || mid.value !== secret) throw new Error(`Value not captured: ${JSON.stringify(mid)}`);
	const renderedMasked = visiblePlain(dashboard.render(120));
	if (renderedMasked.includes(secret)) throw new Error(`Masked input leaked secret: ${renderedMasked}`);
	const bullets = "•".repeat(secret.length);
	if (!renderedMasked.includes(bullets)) throw new Error(`Masked input not rendered as bullets: ${renderedMasked}`);
	dashboard.handleInput("\r");
	await waitForCondition(() => savedKey === secret, "setApiKey called");
	if (savedProvider !== "openai") throw new Error(`Unexpected provider: ${savedProvider}`);
}

async function testSetApiKeyErrorToast(): Promise<void> {
	const rpc: DashboardAuthRpc = {
		fetchProviders: () => Promise.resolve(providers),
		setApiKey: () => Promise.reject(new Error("daemon offline")),
		removeAuth: defaultRemove,
	};
	const dashboard = new DashboardComponent(baseData, "/tmp/socket", () => {}, rpc);
	dashboard.openAuthMenu();
	await waitForCondition(() => dashboard.currentAuthView().kind === "providers", "providers loaded");
	dashboard.handleInput("2");
	dashboard.handleInput("1");
	for (const char of "sk-bad") dashboard.handleInput(char);
	dashboard.handleInput("\r");
	await waitForCondition(() => visiblePlain(dashboard.render(120)).includes("daemon offline"), "error toast appears");
}

async function testFetchProvidersErrorView(): Promise<void> {
	const rpc: DashboardAuthRpc = {
		fetchProviders: () => Promise.reject(new Error("no auth.providers method")),
		setApiKey: stubSetApiKey,
		removeAuth: defaultRemove,
	};
	const dashboard = new DashboardComponent(baseData, "/tmp/socket", () => {}, rpc);
	dashboard.openAuthMenu();
	await waitForCondition(() => dashboard.currentAuthView().kind === "error", "error view");
	const rendered = visiblePlain(dashboard.render(120));
	if (!rendered.includes("no auth.providers method"))
		throw new Error(`Error view did not surface message: ${rendered}`);
}

function testApplyMaskedInputPure(): void {
	if (applyMaskedInput("", "a") !== "a") throw new Error("applyMaskedInput should append char");
	if (applyMaskedInput("abc", DEL) !== "ab") throw new Error("applyMaskedInput should handle DEL backspace");
	if (applyMaskedInput("abc", "\b") !== "ab") throw new Error("applyMaskedInput should handle BS backspace");
	if (applyMaskedInput("abc", CTRL_U) !== "") throw new Error("applyMaskedInput should clear on Ctrl-U");
	if (applyMaskedInput("a", "\r") !== "a") throw new Error("applyMaskedInput should ignore Enter");
	if (applyMaskedInput("a", ESC) !== "a") throw new Error("applyMaskedInput should ignore Esc");
}

await testMenuOpenCloseProvidersRender();
await testMaskedApiKeyEntry();
await testSetApiKeyErrorToast();
await testFetchProvidersErrorView();
testApplyMaskedInputPure();

console.log(JSON.stringify({ ok: true, tests: 5 }));
