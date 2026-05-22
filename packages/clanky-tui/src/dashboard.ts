import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import {
	type AuthRemoveResult,
	type AuthSetApiKeyResult,
	type AuthStatusResult,
	type CronListResult,
	requestGateway,
	type SessionListResult,
	type StatusResult,
	type SwarmSnapshotGatewayResult,
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
import { renderSwarmView } from "./views/swarm.ts";

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
	swarm: SwarmSnapshotGatewayResult;
}

const DEFAULT_INTERVAL_MS = 3000;
const DASHBOARD_SESSION_LIMIT = 8;
const DASHBOARD_RESUME_KEYS: readonly KeyId[] = ["1", "2", "3", "4", "5", "6", "7", "8"];
const DASHBOARD_QUIT_KEYS: readonly KeyId[] = ["ctrl+c", "q"];
const DASHBOARD_OPENAI_AUTH_KEYS: readonly KeyId[] = ["a"];

type DashboardAction =
	| {
			type: "openai-auth";
	  }
	| {
			sessionId: string;
			type: "resume-session";
	  };

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
	const dashboard = new DashboardComponent(renderDashboardData(initialData));
	tui.addChild(dashboard);
	let webSocket: WebSocket | undefined;
	let interval: NodeJS.Timeout | undefined;
	let stopped = false;
	let latestSessions: SessionListResult | undefined = initialData.sessions;
	let nextAction: DashboardAction | undefined;

	const redraw = async () => {
		try {
			const data = await fetchDashboardData(options.socketFile);
			latestSessions = data.sessions;
			dashboard.setText(renderDashboardData(data));
		} catch (error) {
			dashboard.setText(
				`Clanky Dashboard\n================\n\nError: ${error instanceof Error ? error.message : String(error)}`,
			);
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
		tui.addInputListener((data) => {
			if (matchesDashboardKey(data, DASHBOARD_QUIT_KEYS)) {
				stopDashboard();
				return { consume: true };
			}
			if (matchesDashboardKey(data, DASHBOARD_OPENAI_AUTH_KEYS)) {
				stopDashboard({ type: "openai-auth" });
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
	if (nextAction?.type === "openai-auth") {
		await runOpenAiAuthSetup(options.socketFile);
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

class DashboardComponent implements Component {
	private text: string;

	constructor(text: string) {
		this.text = text;
	}

	setText(text: string): void {
		this.text = text;
	}

	render(width: number): string[] {
		return this.text.split("\n").map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {}
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
		"Actions: [a] OpenAI auth  [1-8] resume  [q] quit",
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
		"",
		renderSwarmView(data.swarm),
	].join("\n");
}

async function fetchDashboardData(socketFile: string): Promise<DashboardData> {
	const [auth, status, sessions, tasks, cron, swarm] = await Promise.all([
		requestGateway({ socketFile, method: "auth.status" }) as Promise<AuthStatusResult>,
		requestGateway({ socketFile, method: "status" }) as Promise<StatusResult>,
		requestGateway({ socketFile, method: "session.list" }) as Promise<SessionListResult>,
		requestGateway({ socketFile, method: "task.list", params: { limit: 8 } }) as Promise<TaskListResult>,
		requestGateway({ socketFile, method: "cron.list" }) as Promise<CronListResult>,
		requestGateway({ socketFile, method: "swarm.snapshot" }) as Promise<SwarmSnapshotGatewayResult>,
	]);
	return { auth, status, sessions, tasks, cron, swarm };
}

function renderStatus(status: StatusResult): string {
	const uptimeSeconds = Math.floor(status.uptimeMs / 1000);
	return [
		`Daemon: running pid=${status.pid} uptime=${uptimeSeconds}s`,
		`Profile: ${status.profile} (${status.profileDir})`,
		`Sessions: ${status.liveSessions} live`,
		`Linear: configured=${status.linearConfigured} outbox_pending=${status.linearOutboxPending}`,
		`Cron: ${status.enabledCronJobs}/${status.cronJobs} enabled`,
		`Swarm: ${status.swarm.state} enabled=${status.swarm.enabled} peers=${status.swarmPeers} tasks=${status.swarmTasks}`,
		...status.warnings.map((warning) => `Warning: ${warning}`),
	].join("\n");
}

function renderAuth(auth: AuthStatusResult): string {
	const openAi = auth.providers.find((provider) => provider.provider === "openai");
	const authProviders = auth.authProviders.length === 0 ? "none" : auth.authProviders.join(",");
	const availableProviders = auth.availableProviders.length === 0 ? "none" : auth.availableProviders.join(",");
	return [
		"Model Auth",
		`  credentials=${auth.configured ? "set" : "missing"} available_models=${auth.availableModels} available_providers=${availableProviders}`,
		`  stored_providers=${authProviders}`,
		`  OpenAI: ${formatProviderAuth(openAi)}`,
		`  auth_file=${auth.authFile}`,
	].join("\n");
}

function formatProviderAuth(provider: AuthStatusResult["providers"][number] | undefined): string {
	if (provider === undefined || !provider.configured) return "missing";
	if (provider.source === "environment" && provider.label !== undefined) return `environment:${provider.label}`;
	if (provider.source === "stored") return "stored";
	return provider.source ?? "configured";
}

async function runOpenAiAuthSetup(socketFile: string): Promise<void> {
	const auth = (await requestGateway({ socketFile, method: "auth.status" })) as AuthStatusResult;
	output.write("\nOpenAI Auth\n===========\n");
	output.write(`Profile auth file: ${auth.authFile}\n`);
	output.write(
		`Current OpenAI status: ${formatProviderAuth(auth.providers.find((provider) => provider.provider === "openai"))}\n`,
	);
	output.write("Enter a new OpenAI API key to store it. Enter '-' to remove stored OpenAI auth.\n");
	const secret = await readSecretLine("OPENAI_API_KEY: ");
	const value = secret?.trim();
	if (value === undefined || value.length === 0) {
		output.write("OpenAI auth unchanged.\n\n");
		return;
	}
	if (value === "-") {
		const result = (await requestGateway({
			socketFile,
			method: "auth.remove",
			params: { provider: "openai" },
		})) as AuthRemoveResult;
		output.write(`Removed stored OpenAI auth. available_models=${result.status.availableModels}\n\n`);
		return;
	}
	const result = (await requestGateway({
		socketFile,
		method: "auth.set_api_key",
		params: { provider: "openai", apiKey: value },
	})) as AuthSetApiKeyResult;
	output.write(`Stored OpenAI auth. available_models=${result.status.availableModels}\n\n`);
}

async function readSecretLine(prompt: string): Promise<string | undefined> {
	if (!input.isTTY || !output.isTTY || input.setRawMode === undefined) {
		const reader = createInterface({ input, output });
		try {
			return await reader.question(prompt);
		} finally {
			reader.close();
		}
	}

	output.write(prompt);
	const wasRaw = input.isRaw;
	return await new Promise<string | undefined>((resolve) => {
		let value = "";
		const cleanup = () => {
			input.off("data", onData);
			if (!wasRaw) input.setRawMode(false);
			input.pause();
		};
		const finish = (result: string | undefined) => {
			cleanup();
			output.write("\n");
			resolve(result);
		};
		const onData = (chunk: Buffer) => {
			for (const char of chunk.toString("utf8")) {
				if (char === "\u0003") {
					finish(undefined);
					return;
				}
				if (char === "\r" || char === "\n") {
					finish(value);
					return;
				}
				if (char === "\u007f" || char === "\b") {
					value = value.slice(0, -1);
					continue;
				}
				if (char === "\u0015") {
					value = "";
					continue;
				}
				if (char >= " " && char !== "\u007f") value += char;
			}
		};
		input.setRawMode(true);
		input.resume();
		input.on("data", onData);
	});
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
