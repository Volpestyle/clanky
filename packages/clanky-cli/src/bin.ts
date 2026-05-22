#!/usr/bin/env node

import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, realpathSync } from "node:fs";
import { access, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
	createProfile,
	DEFAULT_PROFILE,
	getModelCredentialsStatus,
	listProfiles,
	renderSessionHtml,
	resolveClankyPaths,
	SessionRegistry,
	type SessionSearchResult,
	startDaemon,
	useProfile,
	validateProfileName,
} from "@clanky/core";
import {
	type CronAddResult,
	type CronJobResult,
	type CronListResult,
	type CronRemoveResult,
	type CronRunNowResult,
	type LinearCreateResult,
	type LinearFlushResult,
	type LinearLinkResult,
	type LinearListResult,
	type LinearOutboxResult,
	requestGateway,
	type SendResult,
	type SessionForkResult,
	type SessionListResult,
	type SkillAddResult,
	type SkillListResult,
	type SkillRemoveResult,
	type SkillUsageResult,
	type StatusResult,
	type SwarmCompleteGatewayResult,
	type SwarmDispatchGatewayResult,
	type SwarmFileLockGatewayResult,
	type SwarmMessageGatewayResult,
	type SwarmQueryGatewayResult,
	type SwarmSnapshotGatewayResult,
	type SwarmStatusResult,
	startGatewayServer,
	startMcpServer,
	type TaskAddResult,
	type TaskListResult,
	type TaskUpdateResult,
} from "@clanky/gateway";
import { runChat, runDashboard } from "@clanky/tui";

export interface ParsedArgs {
	command: string;
	profile?: string;
	homeDir?: string;
	cwd?: string;
	http?: string;
	defaultHttp: boolean;
	deliver?: string;
	skill?: string;
	provider?: string;
	model?: string;
	idempotencyKey?: string;
	output?: string;
	html?: string;
	description?: string;
	linearIssue?: string;
	taskId?: string;
	swarmType?: string;
	status?: string;
	priority?: string;
	limit?: number;
	timeoutSeconds?: number;
	prompt?: string;
	sessionId?: string;
	files: string[];
	serviceEnv: ServiceEnvEntry[];
	serviceEnvFromCurrent: string[];
	print: boolean;
	launchd: boolean;
	systemd: boolean;
	spawn: boolean;
	wait: boolean;
	watch: boolean;
	detach: boolean;
	enable: boolean;
	newToken: boolean;
	mcp: boolean;
	once: boolean;
	json: boolean;
	positional: string[];
}

export interface ServiceEnvEntry {
	key: string;
	value: string;
}

function usage(): string {
	return [
		"Usage:",
		"  clanky start [--profile <name>] [--home <path>] [--cwd <path>] [--http [host:port] | --bind [host:port]] [--new-token] [--detach] [--mcp] [--once]",
		"  clanky send [--profile <name>] [--home <path>] [--cwd <path>] [--http <host:port>] [--session <id>] [--skill <name>] [--provider <provider>] [--model <model>] <prompt>",
		"  clanky session list [--profile <name>] [--home <path>]",
		"  clanky session resume [--profile <name>] [--home <path>] <id> <prompt>",
		"  clanky session fork [--profile <name>] [--home <path>] [--cwd <path>] <id>",
		"  clanky session search [--profile <name>] [--home <path>] <query>",
		"  clanky session export [--profile <name>] [--home <path>] [--output <path> | --html <path>] <id>",
		"  clanky skill list|usage|add|remove [--profile <name>] [--home <path>] [--description <text>] [--prompt <markdown>] [name]",
		"  clanky task list|add|update [--profile <name>] [--home <path>] [--session <id>] [--linear-issue <id>] [--status open|in_progress|done|cancelled] [--priority low|normal|high] [--limit <n>] [--description <text>] [id] [title]",
		"  clanky linear list|create|link|outbox|flush [--profile <name>] [--home <path>] [--session <id>] [--task <id>] [--description <note>] [team-id title|issue-id]",
		"  clanky swarm status|peers|tasks|snapshot|lock|message|complete|dispatch [--profile <name>] [--home <path>] [--type implement|fix|review|research] [--status done|failed|cancelled] [--file <path> | --files <paths>] [--description <text>] [--provider <provider>] [--model <model>] [--linear-issue <id>] [--task <id>] [--wait] [--no-spawn] [--idempotency-key <key>] [args...]",
		"  clanky profile list|new|use [--home <path>] [name]",
		"  clanky install [--launchd | --systemd] [--profile <name>] [--home <path>] [--http [host:port]] [--env NAME=value] [--env-from-current NAME] [--output <path>] [--print] [--enable]",
		"  clanky uninstall [--launchd | --systemd] [--profile <name>] [--home <path>] [--output <path>] [--print]",
		"  clanky mcp [config] [--profile <name>] [--home <path>]",
		"  clanky tui [--profile <name>] [--home <path>] [--watch] [--http <host:port>] [--session <id>]",
		"  clanky cron list [--profile <name>] [--home <path>]",
		"  clanky cron add [--profile <name>] [--home <path>] [--cwd <path>] [--deliver stdout|file|session:<id>|swarm:<peer>|linear:<issue>] [--skill <name>] [--provider <provider>] [--model <model>] [--idempotency-key <key>] [--timeout <seconds>] <schedule> <prompt>",
		"  clanky cron rm|enable|disable|run-now [--profile <name>] [--home <path>] <job-id>",
		"  clanky status [--profile <name>] [--home <path>] [--http <host:port>]",
		"  clanky doctor [--profile <name>] [--home <path>] [--json]",
		"  clanky stop [--profile <name>] [--home <path>]",
		"",
		"`start` runs a foreground daemon unless --once is supplied for smoke testing.",
	].join("\n");
}

function readFlagValue(args: string[], index: number, flag: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) {
		throw new Error(`Missing value for ${flag}`);
	}
	return value;
}

function parseServiceEnvAssignment(value: string): ServiceEnvEntry {
	const separator = value.indexOf("=");
	if (separator <= 0) throw new Error("--env must be in NAME=value form");
	const key = parseServiceEnvName(value.slice(0, separator));
	return { key, value: value.slice(separator + 1) };
}

function parseServiceEnvName(value: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
		throw new Error(`Invalid environment variable name: ${value}`);
	}
	return value;
}

function parseArgs(argv: string[]): ParsedArgs {
	if (argv[0] === "--help" || argv[0] === "-h") argv = ["help", ...argv.slice(1)];
	const [command = "help", ...rest] = argv;
	const parsed: ParsedArgs = {
		command,
		files: [],
		serviceEnv: [],
		serviceEnvFromCurrent: [],
		defaultHttp: false,
		print: false,
		launchd: false,
		systemd: false,
		spawn: true,
		wait: false,
		watch: false,
		detach: false,
		enable: false,
		newToken: false,
		mcp: false,
		once: false,
		json: false,
		positional: [],
	};

	for (let index = 0; index < rest.length; index += 1) {
		const arg = rest[index];
		if (arg === "--profile") {
			parsed.profile = readFlagValue(rest, index, arg);
			index += 1;
		} else if (arg === "--home") {
			parsed.homeDir = readFlagValue(rest, index, arg);
			index += 1;
		} else if (arg === "--cwd") {
			parsed.cwd = readFlagValue(rest, index, arg);
			index += 1;
		} else if (arg === "--http" || arg === "--bind") {
			const value = rest[index + 1];
			if (value === undefined || value.startsWith("--")) {
				parsed.defaultHttp = true;
			} else {
				parsed.http = value;
				index += 1;
			}
		} else if (arg === "--deliver") {
			parsed.deliver = readFlagValue(rest, index, arg);
			index += 1;
		} else if (arg === "--skill") {
			parsed.skill = readFlagValue(rest, index, arg);
			index += 1;
		} else if (arg === "--provider") {
			parsed.provider = readFlagValue(rest, index, arg);
			index += 1;
		} else if (arg === "--model") {
			parsed.model = readFlagValue(rest, index, arg);
			index += 1;
		} else if (arg === "--idempotency-key") {
			parsed.idempotencyKey = readFlagValue(rest, index, arg);
			index += 1;
		} else if (arg === "--description") {
			parsed.description = readFlagValue(rest, index, arg);
			index += 1;
		} else if (arg === "--linear-issue") {
			parsed.linearIssue = readFlagValue(rest, index, arg);
			index += 1;
		} else if (arg === "--task") {
			parsed.taskId = readFlagValue(rest, index, arg);
			index += 1;
		} else if (arg === "--type") {
			parsed.swarmType = readFlagValue(rest, index, arg);
			index += 1;
		} else if (arg === "--status") {
			parsed.status = readFlagValue(rest, index, arg);
			index += 1;
		} else if (arg === "--priority") {
			parsed.priority = readFlagValue(rest, index, arg);
			index += 1;
		} else if (arg === "--limit") {
			const value = Number.parseInt(readFlagValue(rest, index, arg), 10);
			if (!Number.isInteger(value) || value <= 0) throw new Error("--limit must be a positive integer");
			parsed.limit = value;
			index += 1;
		} else if (arg === "--file") {
			parsed.files.push(readFlagValue(rest, index, arg));
			index += 1;
		} else if (arg === "--files") {
			for (const file of readFlagValue(rest, index, arg).split(",")) {
				const trimmed = file.trim();
				if (trimmed.length > 0) parsed.files.push(trimmed);
			}
			index += 1;
		} else if (arg === "--output") {
			parsed.output = readFlagValue(rest, index, arg);
			index += 1;
		} else if (arg === "--env") {
			parsed.serviceEnv.push(parseServiceEnvAssignment(readFlagValue(rest, index, arg)));
			index += 1;
		} else if (arg === "--env-from-current" || arg === "--env-current") {
			parsed.serviceEnvFromCurrent.push(parseServiceEnvName(readFlagValue(rest, index, arg)));
			index += 1;
		} else if (arg === "--html") {
			parsed.html = readFlagValue(rest, index, arg);
			index += 1;
		} else if (arg === "--timeout") {
			const value = Number.parseInt(readFlagValue(rest, index, arg), 10);
			if (!Number.isInteger(value) || value <= 0) throw new Error("--timeout must be a positive integer");
			parsed.timeoutSeconds = value;
			index += 1;
		} else if (arg === "--prompt") {
			parsed.prompt = readFlagValue(rest, index, arg);
			index += 1;
		} else if (arg === "--session") {
			parsed.sessionId = readFlagValue(rest, index, arg);
			index += 1;
		} else if (arg === "--once") {
			parsed.once = true;
		} else if (arg === "--json") {
			parsed.json = true;
		} else if (arg === "--launchd") {
			parsed.launchd = true;
		} else if (arg === "--systemd") {
			parsed.systemd = true;
		} else if (arg === "--print") {
			parsed.print = true;
		} else if (arg === "--wait") {
			parsed.wait = true;
		} else if (arg === "--watch") {
			parsed.watch = true;
		} else if (arg === "--detach") {
			parsed.detach = true;
		} else if (arg === "--enable") {
			parsed.enable = true;
		} else if (arg === "--new-token") {
			parsed.newToken = true;
		} else if (arg === "--mcp") {
			parsed.mcp = true;
		} else if (arg === "--no-spawn") {
			parsed.spawn = false;
		} else if (arg === "--help" || arg === "-h") {
			parsed.command = "help";
		} else if (arg?.startsWith("--")) {
			throw new Error(`Unknown argument: ${arg}`);
		} else {
			parsed.positional.push(arg ?? "");
		}
	}

	return parsed;
}

export async function runStart(args: ParsedArgs): Promise<void> {
	if (args.detach && args.once) {
		throw new Error("Choose either `clanky start --detach` or `clanky start --once`.");
	}
	if (args.mcp && args.detach) {
		throw new Error("Choose either `clanky start --mcp` or `clanky start --detach`.");
	}
	if (args.mcp && args.once) {
		throw new Error("Choose either `clanky start --mcp` or `clanky start --once`.");
	}
	if (args.mcp) {
		await runStartMcp(args);
		return;
	}
	if (args.detach && args.prompt === undefined) {
		startDetachedDaemon(args);
		return;
	}
	if (!args.once && args.prompt === undefined) {
		const options: Parameters<typeof startGatewayServer>[0] = {};
		if (args.profile !== undefined) options.profile = args.profile;
		if (args.homeDir !== undefined) options.homeDir = args.homeDir;
		if (args.cwd !== undefined) options.cwd = args.cwd;
		if (hasHttp(args)) options.http = parseHttpAddress(httpAddress(args));
		if (args.newToken) options.newHttpToken = true;
		const server = await startGatewayServer(options);
		console.log(`clanky daemon listening on ${server.socketFile}`);
		if (server.http) {
			console.log(`clanky http listening on http://${server.http.hostname}:${server.http.port}`);
		}

		let closing = false;
		const close = async () => {
			if (closing) return;
			closing = true;
			await server.close();
		};
		const stoppedBySignal = new Promise<void>((resolve) => {
			const stop = () => {
				void close().then(resolve);
			};
			process.once("SIGINT", stop);
			process.once("SIGTERM", stop);
		});
		await Promise.race([server.closed, stoppedBySignal]);
		await server.registry.dispose();
		return;
	}

	const options: Parameters<typeof startDaemon>[0] = {};
	if (args.profile !== undefined) options.profile = args.profile;
	if (args.homeDir !== undefined) options.homeDir = args.homeDir;
	if (args.cwd !== undefined) options.cwd = args.cwd;
	if (args.prompt !== undefined) options.prompt = args.prompt;
	const result = await startDaemon(options);

	console.log("clanky daemon smoke booted");
	console.log(`session: ${result.sessionId}`);
	console.log(`session_file: ${result.sessionFile ?? "(none)"}`);
	if (result.promptResult) {
		console.log("");
		console.log(result.promptResult);
	}
	await result.registry.dispose();
}

async function runStartMcp(args: ParsedArgs): Promise<void> {
	const server = await startGatewayServer(gatewayOptions(args));
	let closing = false;
	const close = async () => {
		if (closing) return;
		closing = true;
		await server.close();
	};
	process.once("SIGINT", () => {
		void close();
	});
	process.once("SIGTERM", () => {
		void close();
	});
	process.stdin.once("end", () => {
		void close();
	});
	process.stdin.once("close", () => {
		void close();
	});
	try {
		await startMcpServer({ socketFile: server.socketFile });
		await server.closed;
	} finally {
		await close();
	}
}

function startDetachedDaemon(args: ParsedArgs): void {
	const command = serviceCommandPrefix();
	const childArgs = [...command.slice(1), "--dir", repoRoot(), "--silent", "clanky", "start"];
	if (args.homeDir !== undefined) childArgs.push("--home", args.homeDir);
	if (args.profile !== undefined) childArgs.push("--profile", args.profile);
	if (args.cwd !== undefined) childArgs.push("--cwd", args.cwd);
	if (hasHttp(args)) childArgs.push("--http", httpAddress(args));
	if (args.newToken) childArgs.push("--new-token");
	const child = spawn(command[0] ?? "pnpm", childArgs, {
		cwd: repoRoot(),
		detached: true,
		stdio: "ignore",
		env: process.env,
	});
	child.unref();
	console.log(`clanky daemon starting detached pid=${child.pid}`);
}

export async function runSend(args: ParsedArgs): Promise<void> {
	const prompt = args.prompt ?? args.positional.join(" ").trim();
	if (!prompt) {
		throw new Error("Missing prompt for `clanky send`.");
	}
	const params = buildSendParams(prompt, args.sessionId, args.skill, args.provider, args.model);
	const result = hasHttp(args)
		? await sendHttpGateway(args, params)
		: ((await requestGateway({
				socketFile: resolveSocketFile(args),
				method: "send",
				params,
				timeoutMs: 10 * 60 * 1000,
			})) as SendResult);
	if (result.text) console.log(result.text);
	if (!result.text) console.log(`session: ${result.sessionId}`);
}

export async function runStatus(args: ParsedArgs): Promise<void> {
	if (hasHttp(args)) {
		printStatus(await statusHttpGateway(args));
		return;
	}
	let status: StatusResult;
	try {
		status = (await requestGateway({
			socketFile: resolveSocketFile(args),
			method: "status",
		})) as StatusResult;
	} catch (error) {
		if (!isDaemonUnavailableError(error)) throw error;
		await printOfflineStatus(args);
		return;
	}
	printStatus(status);
}

function printStatus(status: StatusResult): void {
	console.log(`running: ${status.running}`);
	console.log(`pid: ${status.pid}`);
	console.log(`profile: ${status.profile}`);
	console.log(`home: ${status.homeDir}`);
	console.log(`profile_dir: ${status.profileDir}`);
	console.log(`socket: ${status.socketFile}`);
	console.log(`lock: ${status.daemonLockFile}`);
	console.log(`live_sessions: ${status.liveSessions}`);
	console.log(`linear_configured: ${status.linearConfigured}`);
	console.log(`linear_outbox_pending: ${status.linearOutboxPending}`);
	console.log(`cron_jobs: ${status.cronJobs}`);
	console.log(`enabled_cron_jobs: ${status.enabledCronJobs}`);
	console.log(`swarm_state: ${status.swarm.state}`);
	console.log(`swarm_enabled: ${status.swarm.enabled}`);
	console.log(`swarm_peers: ${status.swarmPeers}`);
	console.log(`swarm_tasks: ${status.swarmTasks}`);
	console.log(`external_mcp_servers: ${status.externalMcpServers.length}`);
	console.log(`external_mcp_booted: ${status.externalMcpServers.filter((server) => server.state === "booted").length}`);
	for (const warning of status.warnings) console.log(`warning: ${warning}`);
	console.log(`uptime_ms: ${status.uptimeMs}`);
}

export async function runDoctor(args: ParsedArgs): Promise<void> {
	const lines: string[] = [];
	const json: Record<string, DoctorJsonValue> = {};
	const add = (key: string, value: string) => appendDoctorField(lines, json, key, value);
	const addJson = (key: string, value: string) => appendDoctorJsonField(json, key, value);
	const addWarning = (value: string) => {
		appendDoctorField(lines, json, "warning", value);
		appendDoctorJsonField(json, "warnings", value);
	};
	const paths = resolveClankyPaths(pathOptions(args));
	add("home", paths.homeDir);
	add("profile", paths.profile);
	add("profile_dir", paths.profileDir);
	add("socket", paths.socketFile);
	add("lock", paths.daemonLockFile);
	add("node", process.version);
	add("pnpm", (await findExecutable("pnpm")) ?? "missing");
	add("launchd_label", launchdLabel(paths.profile));
	const launchdPlist = launchdPlistFile(paths.profile);
	const launchdPlistState = (await pathExists(launchdPlist)) ? "present" : "missing";
	add("launchd_plist", `${launchdPlist}\t${launchdPlistState}`);
	addJson("launchd_plist_path", launchdPlist);
	addJson("launchd_plist_state", launchdPlistState);
	const launchdState = await launchdServiceState(paths.profile);
	add("launchd_service", launchdState);
	const modelStatus = getModelCredentialsStatus(pathOptions(args));
	add("model_credentials", modelStatus.configured ? "set" : "missing");
	add("model_available_models", String(modelStatus.availableModels));
	add("model_available_providers", modelStatus.availableProviders.join(",") || "missing");
	add("model_auth_providers", modelStatus.authProviders.join(",") || "missing");
	add("model_total_models", String(modelStatus.totalModels));
	if (modelStatus.modelConfigError !== undefined) add("model_config_error", modelStatus.modelConfigError);
	if (!modelStatus.configured) {
		addWarning("no configured Pi model credentials; model-backed send and cron live gates will fail");
	}
	const calendarTooling = detectCalendarTooling();
	add("calendar_tooling", calendarTooling.configured ? "configured" : "missing");
	add("calendar_tooling_servers", calendarTooling.servers.join(",") || "missing");
	if (calendarTooling.error !== undefined) add("calendar_tooling_error", calendarTooling.error);
	const linearConfigured = linearCredentialsConfigured();
	add("linear_credentials", linearConfigured ? "set" : "missing");
	const swarmEnabled = isTruthyEnv(process.env.CLANKY_SWARM_ENABLED);
	const swarmCommand = normalizedEnv(process.env.CLANKY_SWARM_COMMAND);
	const swarmCommandFound = swarmCommand === undefined ? false : await commandExists(swarmCommand);
	add("swarm_enabled", String(swarmEnabled));
	add("swarm_command", swarmCommand ?? "missing");
	if (swarmCommand !== undefined) add("swarm_command_absolute", String(swarmCommand.includes("/")));
	add("swarm_command_found", String(swarmCommandFound));
	if (swarmEnabled && swarmCommand !== undefined && !swarmCommand.includes("/")) {
		addWarning("launchd services should set CLANKY_SWARM_COMMAND to an absolute executable path");
	}
	const swarmArgs = readSwarmArgsStatus(process.env.CLANKY_SWARM_ARGS_JSON);
	add("swarm_args_json", swarmArgs.state);
	if (swarmArgs.error !== undefined) add("swarm_args_error", swarmArgs.error);
	for (const file of swarmArgs.files) {
		const fileState = (await pathExists(file)) ? "present" : "missing";
		add("swarm_args_file", `${file}\t${fileState}`);
		addJson("swarm_args_file_path", file);
		addJson("swarm_args_file_state", fileState);
	}
	const localSwarmDist = "/Users/jamesvolpe/web/swarm-mcp/dist/index.js";
	const localSwarmDistState = (await pathExists(localSwarmDist)) ? "present" : "missing";
	add("swarm_mcp_dist", `${localSwarmDist}\t${localSwarmDistState}`);
	addJson("swarm_mcp_dist_path", localSwarmDist);
	addJson("swarm_mcp_dist_state", localSwarmDistState);
	add("herdr", (await findExecutable("herdr")) ?? "missing");
	const herdrPaneId = normalizedEnv(process.env.HERDR_PANE_ID);
	add("herdr_pane_id", herdrPaneId ?? "missing");
	const herdrSocketPath = normalizedEnv(process.env.HERDR_SOCKET_PATH);
	const herdrSocket = herdrSocketPath ?? normalizedEnv(process.env.HERDR_SOCKET);
	add("herdr_socket", herdrSocket ?? "missing");
	add("herdr_socket_path", herdrSocketPath ?? "missing");
	const herdrSocketFile =
		herdrSocket === undefined ? "missing" : (await pathExists(herdrSocket)) ? "present" : "missing";
	add("herdr_socket_file", herdrSocketFile);
	add("herdr_context", herdrContext(herdrPaneId, herdrSocket, herdrSocketFile));
	const claudeMcpMount = await detectClaudeCodeMcpMount();
	add("claude_code_mcp_config", claudeMcpMount.configFound ? claudeMcpMount.configFile : "missing");
	add("claude_code_mcp_mount", claudeMcpMount.mounted ? "mounted" : "missing");
	add("claude_code_mcp_servers", claudeMcpMount.serverNames.join(",") || "missing");
	const profileDaemonStates = await launchdProfileDaemonStates();
	add("profile_daemon_work", profileDaemonStates.work);
	add("profile_daemon_work_label", profileDaemonStates.workLabel);
	add("profile_daemon_work_plist", `${profileDaemonStates.workPlist}\t${profileDaemonStates.workPlistState}`);
	addJson("profile_daemon_work_plist_path", profileDaemonStates.workPlist);
	addJson("profile_daemon_work_plist_state", profileDaemonStates.workPlistState);
	add("profile_daemon_personal", profileDaemonStates.personal);
	add("profile_daemon_personal_label", profileDaemonStates.personalLabel);
	add(
		"profile_daemon_personal_plist",
		`${profileDaemonStates.personalPlist}\t${profileDaemonStates.personalPlistState}`,
	);
	addJson("profile_daemon_personal_plist_path", profileDaemonStates.personalPlist);
	addJson("profile_daemon_personal_plist_state", profileDaemonStates.personalPlistState);
	const liveGates: DoctorLiveGates = {
		launchd_restart:
			launchdState === "installed"
				? "installed"
				: launchdState === "not_applicable"
					? "not_applicable"
					: "approval_required",
		model_calendar: modelCalendarGate(modelStatus.configured, calendarTooling),
		linear_cron: linearConfigured ? "ready_credentials" : "blocked_credentials",
		swarm_mcp: swarmMcpGate(swarmEnabled, swarmCommand, swarmCommandFound, swarmArgs),
		claude_code_mcp: claudeMcpMount.mounted ? "mounted" : "requires_client_mount",
		profile_daemons: profileDaemonStates.gate,
	};
	add("live_gate_launchd_restart", liveGates.launchd_restart);
	add("live_gate_model_calendar", liveGates.model_calendar);
	add("live_gate_linear_cron", liveGates.linear_cron);
	add("live_gate_swarm_mcp", liveGates.swarm_mcp);
	add("live_gate_claude_code_mcp", liveGates.claude_code_mcp);
	add("live_gate_profile_daemons", liveGates.profile_daemons);
	if (args.json) {
		json.live_gates = liveGates;
		json.live_gate_blockers = blockedLiveGates(liveGates);
		if (json.warnings === undefined) json.warnings = [];
		if (typeof json.warnings === "string") json.warnings = [json.warnings];
		printJson(json);
		return;
	}
	for (const line of lines) console.log(line);
}

interface DoctorLiveGates {
	launchd_restart: string;
	model_calendar: string;
	linear_cron: string;
	swarm_mcp: string;
	claude_code_mcp: string;
	profile_daemons: string;
}

const doctorLiveGateNames = [
	"launchd_restart",
	"model_calendar",
	"linear_cron",
	"swarm_mcp",
	"claude_code_mcp",
	"profile_daemons",
] as const satisfies readonly (keyof DoctorLiveGates)[];

type DoctorLiveGateBlockers = Partial<Record<keyof DoctorLiveGates, string>>;
type DoctorJsonValue = string | string[] | DoctorLiveGates | DoctorLiveGateBlockers;

function blockedLiveGates(liveGates: DoctorLiveGates): DoctorLiveGateBlockers {
	const blockers: DoctorLiveGateBlockers = {};
	for (const name of doctorLiveGateNames) {
		const status = liveGates[name];
		if (!doctorLiveGateReady(status)) blockers[name] = status;
	}
	return blockers;
}

function doctorLiveGateReady(status: string): boolean {
	return (
		status === "installed" ||
		status === "mounted" ||
		status === "not_applicable" ||
		status === "ready_credentials" ||
		status === "ready_preflight"
	);
}

function appendDoctorField(lines: string[], json: Record<string, DoctorJsonValue>, key: string, value: string): void {
	lines.push(`${key}: ${value}`);
	appendDoctorJsonField(json, key, value);
}

function appendDoctorJsonField(json: Record<string, DoctorJsonValue>, key: string, value: string): void {
	const existing = json[key];
	if (existing === undefined) {
		json[key] = value;
	} else if (Array.isArray(existing)) {
		existing.push(value);
	} else if (typeof existing === "string") {
		json[key] = [existing, value];
	} else {
		throw new Error(`Cannot append string value to object doctor JSON key: ${key}`);
	}
}

export async function runStop(args: ParsedArgs): Promise<void> {
	try {
		await requestGateway({
			socketFile: resolveSocketFile(args),
			method: "shutdown",
		});
	} catch (error) {
		if (!isDaemonUnavailableError(error)) throw error;
		console.log("clanky daemon not running");
		return;
	}
	console.log("clanky daemon stopped");
}

export async function runMcp(args: ParsedArgs): Promise<void> {
	const subcommand = args.positional[0];
	if (subcommand === "config") {
		printJson(mcpClientConfig(args));
		return;
	}
	if (subcommand !== undefined) throw new Error("Usage: clanky mcp [config]");
	await startMcpServer({ socketFile: resolveSocketFile(args) });
}

function mcpClientConfig(args: ParsedArgs): {
	mcpServers: Record<string, { command: string; args: string[]; cwd: string }>;
} {
	const paths = resolveClankyPaths(pathOptions(args));
	const serverName = paths.profile === DEFAULT_PROFILE ? "clanky" : `clanky-${paths.profile}`;
	const commandArgs = ["--silent", "clanky", "mcp", "--home", paths.homeDir];
	if (paths.profile !== DEFAULT_PROFILE) commandArgs.push("--profile", paths.profile);
	return {
		mcpServers: {
			[serverName]: {
				command: "pnpm",
				args: commandArgs,
				cwd: repoRoot(),
			},
		},
	};
}

export async function runTui(args: ParsedArgs): Promise<void> {
	if (args.watch && args.sessionId !== undefined) {
		throw new Error("Choose either `clanky tui --watch` or `clanky tui --session <id>`.");
	}
	try {
		await runTuiWithSocket(args, resolveSocketFile(args));
	} catch (error) {
		if (!isDaemonUnavailableError(error)) throw error;
		if (!(await confirmStartDaemon())) {
			throw new Error("Clanky daemon is not running. Start it with `clanky start` first.");
		}
		const server = await startGatewayServer(gatewayOptions(args));
		try {
			console.log(`Started temporary Clanky daemon on ${server.socketFile}`);
			await runTuiWithSocket(args, server.socketFile);
		} finally {
			await server.close();
		}
	}
}

async function runTuiWithSocket(args: ParsedArgs, socketFile: string): Promise<void> {
	if (args.sessionId !== undefined) {
		const chatOptions: Parameters<typeof runChat>[0] = { socketFile, sessionId: args.sessionId };
		if (hasHttp(args)) chatOptions.eventStreamUrl = await eventStreamUrl(args);
		await runChat(chatOptions);
		return;
	}
	const dashboardOptions: Parameters<typeof runDashboard>[0] = { socketFile, watch: args.watch };
	if (args.watch && hasHttp(args)) dashboardOptions.eventStreamUrl = await eventStreamUrl(args);
	await runDashboard(dashboardOptions);
}

async function confirmStartDaemon(): Promise<boolean> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
	const readline = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await readline.question("Clanky daemon is not running. Start it now? [y/N] ");
		const normalized = answer.trim().toLowerCase();
		return normalized === "y" || normalized === "yes";
	} finally {
		readline.close();
	}
}

async function printOfflineStatus(args: ParsedArgs): Promise<void> {
	const paths = resolveClankyPaths(pathOptions(args));
	console.log("running: false");
	console.log(`profile: ${paths.profile}`);
	console.log(`home: ${paths.homeDir}`);
	console.log(`profile_dir: ${paths.profileDir}`);
	console.log(`socket: ${paths.socketFile}`);
	console.log(`lock: ${paths.daemonLockFile}`);
	const lockPid = await readLockPid(paths.daemonLockFile);
	if (lockPid !== undefined) console.log(`lock_pid: ${lockPid}`);
}

export async function runSession(args: ParsedArgs): Promise<void> {
	const subcommand = args.positional[0];
	if (subcommand === "list") {
		const result = await listSessionsFromDaemon(args);
		if (result.sessions.length === 0) {
			console.log("No sessions.");
			return;
		}
		for (const session of result.sessions) {
			const state = session.live ? "live" : "saved";
			const label = session.name ?? session.firstMessage ?? "";
			console.log(`${session.id}\t${state}\t${session.messageCount ?? 0}\t${label}`);
		}
		return;
	}

	if (subcommand === "resume") {
		const sessionId = args.positional[1];
		const prompt = args.positional.slice(2).join(" ").trim();
		if (!sessionId || !prompt) throw new Error("Usage: clanky session resume <id> <prompt>");
		const result = (await requestGateway({
			socketFile: resolveSocketFile(args),
			method: "send",
			params: buildSendParams(prompt, sessionId, args.skill, args.provider, args.model),
			timeoutMs: 10 * 60 * 1000,
		})) as SendResult;
		if (result.text) console.log(result.text);
		if (!result.text) console.log(`session: ${result.sessionId}`);
		return;
	}

	if (subcommand === "fork") {
		const sessionId = args.positional[1];
		if (!sessionId) throw new Error("Usage: clanky session fork <id>");
		const result = (await requestGateway({
			socketFile: resolveSocketFile(args),
			method: "session.fork",
			params: buildSessionForkParams(args, sessionId),
		})) as SessionForkResult;
		console.log(`session: ${result.sessionId}`);
		console.log(`session_file: ${result.sessionFile ?? "(none)"}`);
		console.log(`parent_session: ${result.sourceSessionId}`);
		console.log(`cwd: ${result.cwd}`);
		return;
	}

	if (subcommand === "search") {
		const query = args.positional.slice(1).join(" ").trim();
		if (query.length === 0) throw new Error("Usage: clanky session search <query>");
		const registry = new SessionRegistry(registryOptions(args));
		await registry.start();
		try {
			const results = await registry.searchSessions({ query });
			printSessionSearchResults(results);
		} finally {
			await registry.dispose();
		}
		return;
	}

	if (subcommand === "export") {
		await exportSession(args);
		return;
	}

	throw new Error("Usage: clanky session list|resume|fork|search|export");
}

export async function runCron(args: ParsedArgs): Promise<void> {
	const subcommand = args.positional[0];
	if (subcommand === "list") {
		const result = (await requestGateway({
			socketFile: resolveSocketFile(args),
			method: "cron.list",
		})) as CronListResult;
		if (result.jobs.length === 0) {
			console.log("No cron jobs.");
			return;
		}
		for (const job of result.jobs) {
			const state = job.enabled ? "enabled" : "disabled";
			const nextFire = job.nextFire ?? "(none)";
			console.log(`${job.id}\t${state}\t${nextFire}\t${job.schedule}\t${job.prompt}`);
		}
		return;
	}

	if (subcommand === "add") {
		const schedule = args.positional[1];
		const prompt = args.positional.slice(2).join(" ").trim();
		if (!schedule || !prompt) {
			throw new Error("Usage: clanky cron add <schedule> <prompt>");
		}
		const result = (await requestGateway({
			socketFile: resolveSocketFile(args),
			method: "cron.add",
			params: buildCronAddParams(args, schedule, prompt),
		})) as CronAddResult;
		console.log(`cron_job: ${result.job.id}`);
		console.log(`next_fire: ${result.job.nextFire ?? "(none)"}`);
		return;
	}

	if (subcommand === "rm") {
		const result = (await requestGateway({
			socketFile: resolveSocketFile(args),
			method: "cron.remove",
			params: buildCronJobIdParams(args),
		})) as CronRemoveResult;
		console.log(result.removed ? "cron job removed" : "cron job not found");
		return;
	}

	if (subcommand === "enable" || subcommand === "disable") {
		const result = (await requestGateway({
			socketFile: resolveSocketFile(args),
			method: subcommand === "enable" ? "cron.enable" : "cron.disable",
			params: buildCronJobIdParams(args),
		})) as CronJobResult;
		console.log(`${result.job.id}\t${result.job.enabled ? "enabled" : "disabled"}`);
		return;
	}

	if (subcommand === "run-now") {
		const result = (await requestGateway({
			socketFile: resolveSocketFile(args),
			method: "cron.run_now",
			params: buildCronJobIdParams(args),
			timeoutMs: 10 * 60 * 1000,
		})) as CronRunNowResult;
		if (!result.result.ok) {
			throw new Error(result.result.error ?? "Cron job failed");
		}
		if (result.result.text) console.log(result.result.text);
		if (!result.result.text) console.log(`session: ${result.result.sessionId ?? "(none)"}`);
		return;
	}

	throw new Error("Usage: clanky cron list|add|rm|enable|disable|run-now");
}

export async function runSkill(args: ParsedArgs): Promise<void> {
	const subcommand = args.positional[0];
	if (subcommand === "list") {
		const result = (await requestGateway({
			socketFile: resolveSocketFile(args),
			method: "skill.list",
		})) as SkillListResult;
		if (result.skills.length === 0) {
			console.log("No skills.");
			return;
		}
		for (const skill of result.skills) {
			console.log(`${skill.name}\t${skill.description}`);
		}
		for (const diagnostic of result.diagnostics) {
			console.error(`warning: ${diagnostic}`);
		}
		return;
	}

	if (subcommand === "usage") {
		const result = (await requestGateway({
			socketFile: resolveSocketFile(args),
			method: "skill.usage",
		})) as SkillUsageResult;
		if (result.usage.length === 0) {
			console.log("No skill usage.");
			return;
		}
		for (const usage of result.usage) {
			console.log(`${usage.name}\t${usage.useCount}\t${usage.lastUsedAt}\t${usage.source ?? "-"}`);
		}
		return;
	}

	if (subcommand === "add") {
		const name = args.positional[1];
		if (!name) throw new Error("Usage: clanky skill add <name>");
		const result = (await requestGateway({
			socketFile: resolveSocketFile(args),
			method: "skill.add",
			params: buildSkillAddParams(args, name),
		})) as SkillAddResult;
		console.log(`skill: ${result.skill.name}`);
		console.log(`file: ${result.skill.filePath}`);
		return;
	}

	if (subcommand === "remove") {
		const name = args.positional[1];
		if (!name) throw new Error("Usage: clanky skill remove <name>");
		const result = (await requestGateway({
			socketFile: resolveSocketFile(args),
			method: "skill.remove",
			params: { name },
		})) as SkillRemoveResult;
		if (!result.removed) {
			console.log("skill not found");
			return;
		}
		console.log(`removed: ${result.skill?.name ?? name}`);
		return;
	}

	throw new Error("Usage: clanky skill list|usage|add|remove");
}

export async function runTask(args: ParsedArgs): Promise<void> {
	const subcommand = args.positional[0];
	if (subcommand === "list") {
		const result = (await requestGateway({
			socketFile: resolveSocketFile(args),
			method: "task.list",
			params: buildTaskListParams(args),
		})) as TaskListResult;
		if (result.tasks.length === 0) {
			console.log("No tasks.");
			return;
		}
		for (const task of result.tasks) {
			const session = task.sessionId ?? "-";
			const linear = task.linearIssue ?? "-";
			const source = task.source ?? "-";
			console.log(
				`${task.id}\t${task.status}\t${task.priority}\tsession:${session}\tlinear:${linear}\tsource:${source}\t${task.title}`,
			);
		}
		return;
	}

	if (subcommand === "add") {
		const title = args.positional.slice(1).join(" ").trim();
		if (title.length === 0) throw new Error("Usage: clanky task add <title>");
		const result = (await requestGateway({
			socketFile: resolveSocketFile(args),
			method: "task.add",
			params: buildTaskAddParams(args, title),
		})) as TaskAddResult;
		console.log(`task: ${result.task.id}`);
		console.log(`status: ${result.task.status}`);
		console.log(`priority: ${result.task.priority}`);
		if (result.task.sessionId !== undefined) console.log(`session: ${result.task.sessionId}`);
		if (result.task.linearIssue !== undefined) console.log(`linear: ${result.task.linearIssue}`);
		console.log(`title: ${result.task.title}`);
		return;
	}

	if (subcommand === "update") {
		const taskId = args.positional[1];
		if (taskId === undefined) throw new Error("Usage: clanky task update <id>");
		const title = args.positional.slice(2).join(" ").trim();
		const result = (await requestGateway({
			socketFile: resolveSocketFile(args),
			method: "task.update",
			params: buildTaskUpdateParams(args, taskId, title),
		})) as TaskUpdateResult;
		if (!result.updated || result.task === undefined) {
			console.log("task not found");
			return;
		}
		console.log(`task: ${result.task.id}`);
		console.log(`status: ${result.task.status}`);
		console.log(`priority: ${result.task.priority}`);
		if (result.task.sessionId !== undefined) console.log(`session: ${result.task.sessionId}`);
		if (result.task.linearIssue !== undefined) console.log(`linear: ${result.task.linearIssue}`);
		console.log(`title: ${result.task.title}`);
		return;
	}

	throw new Error("Usage: clanky task list|add|update");
}

export async function runLinear(args: ParsedArgs): Promise<void> {
	const subcommand = args.positional[0];
	if (subcommand === "list") {
		const result = (await requestGateway({
			socketFile: resolveSocketFile(args),
			method: "linear.list",
		})) as LinearListResult;
		if (result.links.length === 0) {
			console.log("No Linear links.");
			return;
		}
		for (const link of result.links) {
			const session = link.sessionId ?? "-";
			const task = link.taskId ?? "-";
			console.log(`${link.issueId}\tsession:${session}\ttask:${task}\t${link.note ?? ""}`);
		}
		return;
	}

	if (subcommand === "link") {
		const issueId = args.positional[1] ?? args.linearIssue;
		if (!issueId) throw new Error("Usage: clanky linear link [--session <id>] [--task <id>] <issue-id>");
		const result = (await requestGateway({
			socketFile: resolveSocketFile(args),
			method: "linear.link",
			params: buildLinearLinkParams(args, issueId),
		})) as LinearLinkResult;
		console.log(`issue: ${result.link.issueId}`);
		console.log(`link: ${result.link.id}`);
		if (result.link.sessionId !== undefined) console.log(`session: ${result.link.sessionId}`);
		if (result.link.taskId !== undefined) console.log(`task: ${result.link.taskId}`);
		return;
	}

	if (subcommand === "create") {
		const teamId = args.positional[1];
		const title = args.positional.slice(2).join(" ").trim();
		if (!teamId || !title) throw new Error("Usage: clanky linear create [--description <text>] <team-id> <title>");
		const result = (await requestGateway({
			socketFile: resolveSocketFile(args),
			method: "linear.create",
			params: buildLinearCreateParams(args, teamId, title),
		})) as LinearCreateResult;
		console.log(`issue_id: ${result.issue.issueId}`);
		console.log(`identifier: ${result.issue.identifier}`);
		console.log(`title: ${result.issue.title}`);
		if (result.issue.url !== undefined) console.log(`url: ${result.issue.url}`);
		return;
	}

	if (subcommand === "outbox") {
		const result = (await requestGateway({
			socketFile: resolveSocketFile(args),
			method: "linear.outbox",
		})) as LinearOutboxResult;
		if (result.entries.length === 0) {
			console.log("No Linear outbox entries.");
			return;
		}
		for (const entry of result.entries) {
			const job = entry.jobId ?? "-";
			const output = entry.outputFile ?? "-";
			console.log(`${entry.issueId}\t${entry.status}\t${entry.kind}\tjob:${job}\toutput:${output}`);
		}
		return;
	}

	if (subcommand === "flush") {
		const result = (await requestGateway({
			socketFile: resolveSocketFile(args),
			method: "linear.flush",
		})) as LinearFlushResult;
		console.log(`posted: ${result.posted.length}`);
		console.log(`failed: ${result.failed.length}`);
		for (const entry of result.failed) {
			console.log(`${entry.id}\t${entry.issueId}\t${entry.error ?? "unknown error"}`);
		}
		if (result.failed.length > 0) process.exitCode = 1;
		return;
	}

	throw new Error("Usage: clanky linear list|create|link|outbox|flush");
}

export async function runSwarm(args: ParsedArgs): Promise<void> {
	const subcommand = args.positional[0];
	if (subcommand === "status") {
		const status = (await requestGateway({
			socketFile: resolveSocketFile(args),
			method: "swarm.status",
		})) as SwarmStatusResult;
		printSwarmStatus(status);
		return;
	}
	if (subcommand === "peers") {
		const result = (await requestGateway({
			socketFile: resolveSocketFile(args),
			method: "swarm.peers",
		})) as SwarmQueryGatewayResult;
		printJson(result);
		if (!result.ok) process.exitCode = 1;
		return;
	}
	if (subcommand === "tasks") {
		const result = (await requestGateway({
			socketFile: resolveSocketFile(args),
			method: "swarm.tasks",
		})) as SwarmQueryGatewayResult;
		printJson(result);
		if (!result.ok) process.exitCode = 1;
		return;
	}
	if (subcommand === "snapshot") {
		const result = (await requestGateway({
			socketFile: resolveSocketFile(args),
			method: "swarm.snapshot",
		})) as SwarmSnapshotGatewayResult;
		printJson(result);
		if (!result.ok) process.exitCode = 1;
		return;
	}
	if (subcommand === "lock" || subcommand === "file-lock") {
		const file = args.positional[1] ?? args.files[0];
		if (file === undefined) throw new Error("Usage: clanky swarm lock <path>");
		const result = (await requestGateway({
			socketFile: resolveSocketFile(args),
			method: "swarm.file_lock",
			params: { file },
		})) as SwarmFileLockGatewayResult;
		printSwarmFileLock(result);
		if (result.blocked || !result.ok) process.exitCode = 1;
		return;
	}
	if (subcommand === "message") {
		const recipient = args.positional[1];
		const message = args.positional.slice(2).join(" ").trim();
		if (recipient === undefined || message.length === 0) {
			throw new Error("Usage: clanky swarm message <peer-id> <message>");
		}
		const result = (await requestGateway({
			socketFile: resolveSocketFile(args),
			method: "swarm.message",
			params: buildSwarmMessageParams(args, recipient, message),
		})) as SwarmMessageGatewayResult;
		console.log(`ok: ${result.ok}`);
		console.log(`state: ${result.state}`);
		console.log(`recipient: ${result.request.recipient}`);
		console.log(`message: ${result.message}`);
		if (!result.ok) process.exitCode = 1;
		return;
	}
	if (subcommand === "complete") {
		const taskId = args.positional[1];
		const summary = args.description ?? args.positional.slice(2).join(" ").trim();
		if (taskId === undefined || summary.length === 0) {
			throw new Error("Usage: clanky swarm complete <task-id> --description <summary>");
		}
		const result = (await requestGateway({
			socketFile: resolveSocketFile(args),
			method: "swarm.complete",
			params: buildSwarmCompleteParams(args, taskId, summary),
		})) as SwarmCompleteGatewayResult;
		console.log(`ok: ${result.ok}`);
		console.log(`state: ${result.state}`);
		console.log(`task_id: ${result.request.taskId}`);
		console.log(`status: ${result.request.status}`);
		console.log(`message: ${result.message}`);
		if (!result.ok) process.exitCode = 1;
		return;
	}
	if (subcommand === "dispatch") {
		const title = args.positional.slice(1).join(" ").trim();
		if (title.length === 0 || args.swarmType === undefined) {
			throw new Error("Usage: clanky swarm dispatch --type implement|fix|review|research <title>");
		}
		const result = (await requestGateway({
			socketFile: resolveSocketFile(args),
			method: "swarm.dispatch",
			params: buildSwarmDispatchParams(args, title),
			timeoutMs: 10 * 60 * 1000,
		})) as SwarmDispatchGatewayResult;
		console.log(`ok: ${result.ok}`);
		console.log(`state: ${result.state}`);
		if (result.taskId !== undefined) console.log(`task_id: ${result.taskId}`);
		if (result.dispatchStatus !== undefined) console.log(`dispatch_status: ${result.dispatchStatus}`);
		console.log(`message: ${result.message}`);
		if (!result.ok) process.exitCode = 1;
		return;
	}
	throw new Error("Usage: clanky swarm status|peers|tasks|snapshot|lock|message|complete|dispatch");
}

export async function runProfile(args: ParsedArgs): Promise<void> {
	const subcommand = args.positional[0];
	const homeDir = resolveHomeDir(args);
	if (subcommand === "list") {
		const profiles = await listProfiles(homeDir);
		for (const profile of profiles) {
			const marker = profile.active ? "*" : " ";
			console.log(`${marker}\t${profile.name}\t${profile.profileDir}`);
		}
		return;
	}
	if (subcommand === "new") {
		const name = args.positional[1];
		if (!name) throw new Error("Usage: clanky profile new <name>");
		const profile = await createProfile(homeDir, name);
		console.log(`profile: ${profile.name}`);
		console.log(`path: ${profile.profileDir}`);
		return;
	}
	if (subcommand === "use") {
		const name = args.positional[1];
		if (!name) throw new Error("Usage: clanky profile use <name>");
		const profile = await useProfile(homeDir, name);
		console.log(`active_profile: ${profile.name}`);
		console.log(`path: ${profile.profileDir}`);
		return;
	}
	throw new Error("Usage: clanky profile list|new|use");
}

async function listSessionsFromDaemon(args: ParsedArgs): Promise<SessionListResult> {
	return (await requestGateway({
		socketFile: resolveSocketFile(args),
		method: "session.list",
	})) as SessionListResult;
}

async function exportSession(args: ParsedArgs): Promise<void> {
	if (args.output !== undefined && args.html !== undefined)
		throw new Error("Choose only one export target: --output or --html");
	const sessionId = args.positional[1];
	if (!sessionId) throw new Error("Usage: clanky session export <id>");
	const registry = new SessionRegistry(registryOptions(args));
	await registry.start();
	try {
		const session = await findSessionForExport(registry, sessionId);
		const content = await readFile(session.sessionFile, "utf8");
		if (args.html !== undefined) {
			await writeFile(args.html, await renderSessionHtml({ sessionId: session.id, content }), { mode: 0o644 });
			console.log(`wrote: ${args.html}`);
			return;
		}
		if (args.output !== undefined) {
			await writeFile(args.output, content, { mode: 0o600 });
			console.log(`wrote: ${args.output}`);
			return;
		}
		console.log(content.trimEnd());
	} finally {
		await registry.dispose();
	}
}

async function findSessionForExport(
	registry: SessionRegistry,
	sessionId: string,
): Promise<{ id: string; sessionFile: string }> {
	const sessions = await registry.listSummaries();
	const matches = sessions.filter((session) => session.id.startsWith(sessionId));
	if (matches.length > 1) throw new Error(`Ambiguous session id: ${sessionId}`);
	const match = matches[0];
	if (match?.sessionFile !== undefined) return { id: match.id, sessionFile: match.sessionFile };

	const files = await readdir(registry.paths.sessionsDir).catch(() => []);
	const fileMatches = files.filter((file) => file.endsWith(".jsonl") && file.includes(sessionId));
	if (fileMatches.length === 0) throw new Error(`Unknown session: ${sessionId}`);
	if (fileMatches.length > 1) throw new Error(`Ambiguous session id: ${sessionId}`);
	const file = fileMatches[0];
	if (file === undefined) throw new Error(`Unknown session: ${sessionId}`);
	const id = extractSessionId(file) ?? sessionId;
	return { id, sessionFile: join(registry.paths.sessionsDir, file) };
}

export async function runInstall(args: ParsedArgs): Promise<void> {
	const target = installTarget(args);
	const options = installOptions(args);
	if (target === "launchd") {
		const plistPath = args.output ?? launchdPlistFile(args.profile ?? DEFAULT_PROFILE);
		const plist = launchdPlist(options);
		if (args.print) {
			console.log(plist);
			return;
		}
		await mkdir(options.homeDir, { recursive: true, mode: 0o700 });
		await mkdir(dirname(plistPath), { recursive: true, mode: 0o700 });
		await writeFile(plistPath, plist, { mode: 0o644 });
		console.log(`wrote: ${plistPath}`);
		const domain = launchdDomain();
		if (args.enable) {
			await runCommand("launchctl", ["bootstrap", domain, plistPath]);
			await runCommand("launchctl", ["kickstart", "-k", `${domain}/${options.launchdLabel}`]);
			console.log(`enabled: launchctl bootstrap ${domain} ${plistPath}`);
			console.log(`started: launchctl kickstart -k ${domain}/${options.launchdLabel}`);
			return;
		}
		console.log(`enable: launchctl bootstrap ${domain} ${plistPath}`);
		console.log(`start: launchctl kickstart -k ${domain}/${options.launchdLabel}`);
		return;
	}

	const unitPath = args.output ?? join(homedir(), ".config", "systemd", "user", options.systemdUnit);
	const unit = systemdUnit(options);
	if (args.print) {
		console.log(unit);
		return;
	}
	await mkdir(options.homeDir, { recursive: true, mode: 0o700 });
	await mkdir(dirname(unitPath), { recursive: true, mode: 0o700 });
	await writeFile(unitPath, unit, { mode: 0o644 });
	console.log(`wrote: ${unitPath}`);
	if (args.enable) {
		await runCommand("systemctl", ["--user", "daemon-reload"]);
		await runCommand("systemctl", ["--user", "enable", "--now", unitPath]);
		console.log(`enabled: systemctl --user enable --now ${basename(unitPath)}`);
		return;
	}
	console.log(`enable: systemctl --user enable --now ${unitPath}`);
}

export async function runUninstall(args: ParsedArgs): Promise<void> {
	const target = installTarget(args);
	const options = installOptions(args);
	if (target === "launchd") {
		const plistPath = args.output ?? launchdPlistFile(args.profile ?? DEFAULT_PROFILE);
		const service = `${launchdDomain()}/${options.launchdLabel}`;
		if (args.print) {
			console.log(`launchctl bootout ${service}`);
			console.log(`rm ${plistPath}`);
			return;
		}
		await runCommandAllowFailure("launchctl", ["bootout", service]);
		await unlinkIfExists(plistPath);
		console.log(`disabled: launchctl bootout ${service}`);
		console.log(`removed: ${plistPath}`);
		return;
	}

	const unitPath = args.output ?? join(homedir(), ".config", "systemd", "user", options.systemdUnit);
	if (args.print) {
		console.log(`systemctl --user disable --now ${basename(unitPath)}`);
		console.log(`rm ${unitPath}`);
		console.log("systemctl --user daemon-reload");
		return;
	}
	await runCommandAllowFailure("systemctl", ["--user", "disable", "--now", basename(unitPath)]);
	await unlinkIfExists(unitPath);
	await runCommandAllowFailure("systemctl", ["--user", "daemon-reload"]);
	console.log(`disabled: systemctl --user disable --now ${basename(unitPath)}`);
	console.log(`removed: ${unitPath}`);
}

function buildSendParams(
	prompt: string,
	sessionId: string | undefined,
	skill: string | undefined,
	provider: string | undefined,
	model: string | undefined,
): { prompt: string; sessionId?: string; skill?: string; provider?: string; model?: string } {
	const params: { prompt: string; sessionId?: string; skill?: string; provider?: string; model?: string } = { prompt };
	if (sessionId !== undefined) params.sessionId = sessionId;
	if (skill !== undefined) params.skill = skill;
	if (provider !== undefined) params.provider = provider;
	if (model !== undefined) params.model = model;
	return params;
}

function buildCronAddParams(args: ParsedArgs, schedule: string, prompt: string): Record<string, unknown> {
	const params: Record<string, unknown> = { schedule, prompt };
	if (args.deliver !== undefined) params.deliver = args.deliver;
	if (args.skill !== undefined) params.skill = args.skill;
	if (args.provider !== undefined) params.provider = args.provider;
	if (args.model !== undefined) params.model = args.model;
	if (args.idempotencyKey !== undefined) params.idempotencyKey = args.idempotencyKey;
	if (args.timeoutSeconds !== undefined) params.timeoutSeconds = args.timeoutSeconds;
	if (args.cwd !== undefined) params.workdir = args.cwd;
	return params;
}

function buildSwarmDispatchParams(args: ParsedArgs, title: string): Record<string, unknown> {
	const params: Record<string, unknown> = {
		title,
		type: args.swarmType,
		description: args.description ?? title,
	};
	if (args.files.length > 0) params.files = args.files;
	if (!args.spawn) params.spawn = false;
	if (args.wait) params.waitForCompletion = true;
	if (args.provider !== undefined) params.provider = args.provider;
	if (args.model !== undefined) params.model = args.model;
	if (args.linearIssue !== undefined) params.linearIssue = args.linearIssue;
	if (args.idempotencyKey !== undefined) params.idempotencyKey = args.idempotencyKey;
	return params;
}

function buildSwarmMessageParams(args: ParsedArgs, recipient: string, message: string): Record<string, unknown> {
	const params: Record<string, unknown> = { recipient, message };
	if (args.taskId !== undefined) params.taskId = args.taskId;
	return params;
}

function buildSwarmCompleteParams(args: ParsedArgs, taskId: string, summary: string): Record<string, unknown> {
	const params: Record<string, unknown> = { taskId, summary };
	if (args.status !== undefined) params.status = args.status;
	if (args.files.length > 0) params.filesChanged = args.files;
	return params;
}

function buildSessionForkParams(args: ParsedArgs, sourceSessionId: string): Record<string, unknown> {
	const params: Record<string, unknown> = { sourceSessionId };
	if (args.cwd !== undefined) params.cwd = args.cwd;
	return params;
}

function buildSkillAddParams(args: ParsedArgs, name: string): Record<string, unknown> {
	const params: Record<string, unknown> = { name };
	if (args.description !== undefined) params.description = args.description;
	if (args.prompt !== undefined) params.body = args.prompt;
	return params;
}

function buildTaskListParams(args: ParsedArgs): Record<string, unknown> {
	const params: Record<string, unknown> = {};
	if (args.sessionId !== undefined) params.sessionId = args.sessionId;
	if (args.linearIssue !== undefined) params.linearIssue = args.linearIssue;
	if (args.status !== undefined) params.status = args.status;
	if (args.priority !== undefined) params.priority = args.priority;
	if (args.limit !== undefined) params.limit = args.limit;
	return params;
}

function buildTaskAddParams(args: ParsedArgs, title: string): Record<string, unknown> {
	const params: Record<string, unknown> = { title, source: "cli" };
	if (args.description !== undefined) params.description = args.description;
	if (args.status !== undefined) params.status = args.status;
	if (args.priority !== undefined) params.priority = args.priority;
	if (args.sessionId !== undefined) params.sessionId = args.sessionId;
	if (args.linearIssue !== undefined) params.linearIssue = args.linearIssue;
	return params;
}

function buildTaskUpdateParams(args: ParsedArgs, id: string, title: string): Record<string, unknown> {
	const params: Record<string, unknown> = { id };
	if (title.length > 0) params.title = title;
	if (args.description !== undefined) params.description = args.description;
	if (args.status !== undefined) params.status = args.status;
	if (args.priority !== undefined) params.priority = args.priority;
	if (args.sessionId !== undefined) params.sessionId = args.sessionId;
	if (args.linearIssue !== undefined) params.linearIssue = args.linearIssue;
	return params;
}

function buildLinearLinkParams(args: ParsedArgs, issueId: string): Record<string, unknown> {
	const params: Record<string, unknown> = { issueId };
	if (args.sessionId !== undefined) params.sessionId = args.sessionId;
	if (args.taskId !== undefined) params.taskId = args.taskId;
	if (args.description !== undefined) params.note = args.description;
	return params;
}

function buildLinearCreateParams(args: ParsedArgs, teamId: string, title: string): Record<string, unknown> {
	const params: Record<string, unknown> = { teamId, title };
	if (args.description !== undefined) params.description = args.description;
	return params;
}

function buildCronJobIdParams(args: ParsedArgs): { jobId: string } {
	const jobId = args.positional[1];
	if (!jobId) throw new Error("Missing cron job id");
	return { jobId };
}

function printSwarmStatus(status: SwarmStatusResult): void {
	console.log(`enabled: ${status.enabled}`);
	console.log(`state: ${status.state}`);
	console.log(`profile: ${status.profile}`);
	console.log(`identity: ${status.identity}`);
	console.log(`cwd: ${status.cwd}`);
	console.log(`database: ${status.databasePath}`);
	if (status.command !== undefined) console.log(`command: ${status.command}`);
	if (status.args.length > 0) console.log(`args: ${status.args.join(" ")}`);
	if (status.instanceId !== undefined) console.log(`instance_id: ${status.instanceId}`);
	if (status.bootedAt !== undefined) console.log(`booted_at: ${status.bootedAt}`);
	if (status.scope !== undefined) console.log(`scope: ${status.scope}`);
	if (status.label !== undefined) console.log(`label: ${status.label}`);
	if (status.workspaceHandle !== undefined) {
		console.log(`workspace_backend: ${status.workspaceHandle.backend}`);
		console.log(`workspace_handle_kind: ${status.workspaceHandle.handle_kind}`);
		console.log(`workspace_handle: ${status.workspaceHandle.handle}`);
		if (status.workspaceHandle.socket_path !== undefined) {
			console.log(`workspace_socket: ${status.workspaceHandle.socket_path}`);
		}
	}
	if (status.error !== undefined) console.log(`error: ${status.error}`);
	console.log(`message: ${status.message}`);
}

function printSwarmFileLock(result: SwarmFileLockGatewayResult): void {
	console.log(`ok: ${result.ok}`);
	console.log(`state: ${result.state}`);
	console.log(`file: ${result.file}`);
	console.log(`blocked: ${result.blocked}`);
	if (result.ownerId !== undefined) console.log(`owner_id: ${result.ownerId}`);
	if (result.ownerLabel !== undefined) console.log(`owner_label: ${result.ownerLabel}`);
	if (result.reason !== undefined) console.log(`reason: ${result.reason}`);
	console.log(`message: ${result.message}`);
}

function printSessionSearchResults(results: SessionSearchResult[]): void {
	if (results.length === 0) {
		console.log("No matches.");
		return;
	}
	for (const result of results) {
		console.log(`${result.sessionId}\t${result.role}\t${result.createdAt}\t${singleLineSnippet(result.snippet)}`);
	}
}

function singleLineSnippet(value: string): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= 160) return normalized;
	return `${normalized.slice(0, 157)}...`;
}

function printJson(value: unknown): void {
	console.log(JSON.stringify(value, null, "\t"));
}

function registryOptions(args: ParsedArgs): ConstructorParameters<typeof SessionRegistry>[0] {
	const options: ConstructorParameters<typeof SessionRegistry>[0] = {};
	if (args.homeDir !== undefined) options.homeDir = args.homeDir;
	if (args.profile !== undefined) options.profile = args.profile;
	if (args.cwd !== undefined) options.cwd = args.cwd;
	return options;
}

function extractSessionId(fileName: string): string | undefined {
	const withoutExtension = fileName.endsWith(".jsonl") ? fileName.slice(0, -".jsonl".length) : fileName;
	const separator = withoutExtension.lastIndexOf("_");
	if (separator === -1) return undefined;
	return withoutExtension.slice(separator + 1);
}

function resolveSocketFile(args: ParsedArgs): string {
	return resolveClankyPaths(pathOptions(args)).socketFile;
}

function pathOptions(args: ParsedArgs): Parameters<typeof resolveClankyPaths>[0] {
	const options: Parameters<typeof resolveClankyPaths>[0] = {};
	if (args.homeDir !== undefined) options.homeDir = args.homeDir;
	if (args.profile !== undefined) options.profile = args.profile;
	return options;
}

function gatewayOptions(args: ParsedArgs): Parameters<typeof startGatewayServer>[0] {
	const options: Parameters<typeof startGatewayServer>[0] = {};
	if (args.profile !== undefined) options.profile = args.profile;
	if (args.homeDir !== undefined) options.homeDir = args.homeDir;
	if (args.cwd !== undefined) options.cwd = args.cwd;
	if (hasHttp(args)) options.http = parseHttpAddress(httpAddress(args));
	if (args.newToken) options.newHttpToken = true;
	return options;
}

function resolveHomeDir(args: ParsedArgs): string {
	const options: Parameters<typeof resolveClankyPaths>[0] = { profile: DEFAULT_PROFILE };
	if (args.homeDir !== undefined) options.homeDir = args.homeDir;
	return resolveClankyPaths(options).homeDir;
}

function installTarget(args: ParsedArgs): "launchd" | "systemd" {
	if (args.launchd && args.systemd) throw new Error("Choose only one install target: --launchd or --systemd");
	if (args.launchd) return "launchd";
	if (args.systemd) return "systemd";
	if (process.platform === "darwin") return "launchd";
	return "systemd";
}

function launchdDomain(): string {
	const uid = process.getuid?.();
	if (uid === undefined) throw new Error("launchd install requires a POSIX user id");
	return `gui/${uid}`;
}

async function runCommand(command: string, args: string[]): Promise<void> {
	const child = spawn(command, args, { stdio: "inherit" });
	const code = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	if (code !== 0) {
		throw new Error(`${command} ${args.join(" ")} exited with ${code}`);
	}
}

async function runCommandAllowFailure(command: string, args: string[]): Promise<void> {
	const child = spawn(command, args, { stdio: "inherit" });
	await new Promise<void>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", () => resolve());
	});
}

async function unlinkIfExists(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
		if (code !== "ENOENT") throw error;
	}
}

async function launchdServiceState(profile: string): Promise<string> {
	if (process.platform !== "darwin") return "not_applicable";
	const result = await captureCommand("launchctl", ["print", `${launchdDomain()}/${launchdLabel(profile)}`], 5000);
	if (result.code === 0) return "installed";
	if (result.stderr.includes("Could not find service") || result.stdout.includes("Could not find service"))
		return "missing";
	return `unknown exit=${result.code ?? "signal"}`;
}

interface LaunchdProfileDaemonStates {
	work: string;
	workLabel: string;
	workPlist: string;
	workPlistState: string;
	personal: string;
	personalLabel: string;
	personalPlist: string;
	personalPlistState: string;
	gate: string;
}

async function launchdProfileDaemonStates(): Promise<LaunchdProfileDaemonStates> {
	const workLabel = launchdLabel("work");
	const workPlist = launchdPlistFile("work");
	const workPlistState = (await pathExists(workPlist)) ? "present" : "missing";
	const personalLabel = launchdLabel("personal");
	const personalPlist = launchdPlistFile("personal");
	const personalPlistState = (await pathExists(personalPlist)) ? "present" : "missing";
	if (process.platform !== "darwin") {
		return {
			work: "not_applicable",
			workLabel,
			workPlist,
			workPlistState,
			personal: "not_applicable",
			personalLabel,
			personalPlist,
			personalPlistState,
			gate: "not_applicable",
		};
	}
	const work = await launchdServiceState("work");
	const personal = await launchdServiceState("personal");
	const gate = work === "installed" && personal === "installed" ? "installed" : "approval_required";
	return {
		work,
		workLabel,
		workPlist,
		workPlistState,
		personal,
		personalLabel,
		personalPlist,
		personalPlistState,
		gate,
	};
}

interface CaptureCommandResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

async function captureCommand(command: string, args: string[], timeoutMs: number): Promise<CaptureCommandResult> {
	const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString("utf8");
	});
	const timeout = setTimeout(() => {
		child.kill("SIGTERM");
	}, timeoutMs);
	try {
		const code = await new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		});
		return { code, stdout, stderr };
	} finally {
		clearTimeout(timeout);
	}
}

function installOptions(args: ParsedArgs): {
	homeDir: string;
	profile?: string;
	http?: string;
	cwd: string;
	command: string[];
	env: ServiceEnvEntry[];
	launchdLabel: string;
	systemdUnit: string;
} {
	const homeDir = resolveHomeDir(args);
	const profile = args.profile ?? DEFAULT_PROFILE;
	validateProfileName(profile);
	const command = serviceCommandPrefix();
	command.push("--dir", repoRoot(), "--silent", "clanky", "start", "--home", homeDir);
	const http = hasHttp(args) ? httpAddress(args) : undefined;
	if (args.profile !== undefined) command.push("--profile", args.profile);
	if (http !== undefined) command.push("--http", http);
	const env = serviceEnvironment(args, homeDir);
	return {
		homeDir,
		cwd: args.cwd ?? repoRoot(),
		command,
		env,
		launchdLabel: launchdLabel(profile),
		systemdUnit: systemdUnitFileName(profile),
		...(args.profile === undefined ? {} : { profile: args.profile }),
		...(http === undefined ? {} : { http }),
	};
}

function launchdLabel(profile: string): string {
	if (profile === DEFAULT_PROFILE) return "com.clanky.daemon";
	return `com.clanky.daemon.${profile}`;
}

function launchdPlistFile(profile: string): string {
	return join(homedir(), "Library", "LaunchAgents", `${launchdLabel(profile)}.plist`);
}

function systemdUnitFileName(profile: string): string {
	if (profile === DEFAULT_PROFILE) return "clanky.service";
	return `clanky-${profile}.service`;
}

function serviceEnvironment(args: ParsedArgs, homeDir: string): ServiceEnvEntry[] {
	const env = new Map<string, string>();
	env.set("CLANKY_HOME", homeDir);
	if (args.profile !== undefined) env.set("CLANKY_PROFILE", args.profile);
	for (const entry of args.serviceEnv) {
		assertInstallEnvNotReserved(entry.key);
		env.set(entry.key, entry.value);
	}
	for (const key of args.serviceEnvFromCurrent) {
		assertInstallEnvNotReserved(key);
		const value = normalizedEnv(process.env[key]);
		if (value === undefined) throw new Error(`Environment variable ${key} is not set`);
		env.set(key, value);
	}
	return Array.from(env, ([key, value]) => ({ key, value }));
}

function assertInstallEnvNotReserved(key: string): void {
	if (key === "CLANKY_HOME") throw new Error("Use --home instead of --env CLANKY_HOME=...");
	if (key === "CLANKY_PROFILE") throw new Error("Use --profile instead of --env CLANKY_PROFILE=...");
}

function repoRoot(): string {
	return dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
}

function serviceCommandPrefix(): string[] {
	const pnpmEntrypoint = process.env.npm_execpath;
	if (pnpmEntrypoint !== undefined && basename(pnpmEntrypoint).includes("pnpm")) {
		return [process.execPath, pnpmEntrypoint];
	}
	const path = process.env.PATH ?? "";
	for (const directory of path.split(delimiter)) {
		if (directory.length === 0) continue;
		const candidate = join(directory, "pnpm");
		try {
			accessSync(candidate, fsConstants.X_OK);
			return [candidate];
		} catch {}
	}
	return ["pnpm"];
}

function linearCredentialsConfigured(): boolean {
	return (
		normalizedEnv(process.env.LINEAR_API_KEY) !== undefined ||
		normalizedEnv(process.env.LINEAR_ACCESS_TOKEN) !== undefined
	);
}

interface CalendarToolingStatus {
	configured: boolean;
	servers: string[];
	error?: string;
}

function detectCalendarTooling(): CalendarToolingStatus {
	const raw = normalizedEnv(process.env.CLANKY_MCP_SERVERS_JSON);
	if (raw === undefined) return { configured: false, servers: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		return { configured: false, servers: [], error: "CLANKY_MCP_SERVERS_JSON must be valid JSON" };
	}
	const servers = new Set<string>();
	if (Array.isArray(parsed)) {
		for (const entry of parsed) {
			const name = isJsonRecord(entry) && typeof entry.name === "string" ? entry.name : "unnamed";
			if (isCalendarMcpServer(name, entry)) servers.add(name);
		}
	} else if (isJsonRecord(parsed)) {
		for (const [name, entry] of Object.entries(parsed)) {
			if (isCalendarMcpServer(name, entry)) servers.add(name);
		}
	} else {
		return { configured: false, servers: [], error: "CLANKY_MCP_SERVERS_JSON must be an array or object" };
	}
	const names = [...servers].sort();
	return { configured: names.length > 0, servers: names };
}

function modelCalendarGate(modelConfigured: boolean, calendarTooling: CalendarToolingStatus): string {
	if (!modelConfigured) return "blocked_model_credentials";
	if (calendarTooling.error !== undefined) return "blocked_calendar_config";
	return calendarTooling.configured ? "ready_preflight" : "requires_calendar_tooling";
}

function isCalendarMcpServer(name: string, value: unknown): boolean {
	const terms = ["calendar", "caldav", "gcal", "google-calendar", "google_calendar", "ical", "icalendar"];
	const haystack = [name, ...mcpServerText(value)].join("\n").toLowerCase();
	return terms.some((term) => haystack.includes(term));
}

function mcpServerText(value: unknown): string[] {
	if (!isJsonRecord(value)) return [];
	const parts: string[] = [];
	if (typeof value.command === "string") parts.push(value.command);
	if (Array.isArray(value.args)) {
		for (const item of value.args) {
			if (typeof item === "string") parts.push(item);
		}
	}
	if (isJsonRecord(value.env)) {
		for (const [key, item] of Object.entries(value.env)) {
			parts.push(key);
			if (typeof item === "string") parts.push(item);
		}
	}
	return parts;
}

interface ClaudeCodeMcpMount {
	configFile: string;
	configFound: boolean;
	mounted: boolean;
	serverNames: string[];
}

async function detectClaudeCodeMcpMount(): Promise<ClaudeCodeMcpMount> {
	const configFile = join(homedir(), ".claude", ".claude.json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(configFile, "utf8")) as unknown;
	} catch {
		return { configFile, configFound: false, mounted: false, serverNames: [] };
	}
	const serverNames = new Set<string>();
	collectClankyMcpServers(parsed, serverNames);
	const names = [...serverNames].sort();
	return {
		configFile,
		configFound: true,
		mounted: names.length > 0,
		serverNames: names,
	};
}

function collectClankyMcpServers(value: unknown, serverNames: Set<string>): void {
	if (Array.isArray(value)) {
		for (const item of value) collectClankyMcpServers(item, serverNames);
		return;
	}
	if (!isJsonRecord(value)) return;
	const mcpServers = value.mcpServers;
	if (isJsonRecord(mcpServers)) {
		for (const [name, server] of Object.entries(mcpServers)) {
			if (isClankyMcpServer(name, server)) serverNames.add(name);
		}
	}
	for (const item of Object.values(value)) collectClankyMcpServers(item, serverNames);
}

function isClankyMcpServer(name: string, value: unknown): boolean {
	if (name.toLowerCase().includes("clanky")) return true;
	if (!isJsonRecord(value)) return false;
	const command = typeof value.command === "string" ? value.command : "";
	if (command.toLowerCase().includes("clanky")) return true;
	const args = Array.isArray(value.args) ? value.args.filter((item): item is string => typeof item === "string") : [];
	return args.some((arg) => arg.toLowerCase().includes("clanky"));
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTruthyEnv(value: string | undefined): boolean {
	const normalized = normalizedEnv(value)?.toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function normalizedEnv(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

interface SwarmArgsStatus {
	files: string[];
	state: "missing" | "valid" | "invalid";
	error?: string;
}

function readSwarmArgsStatus(value: string | undefined): SwarmArgsStatus {
	const normalized = normalizedEnv(value);
	if (normalized === undefined) return { files: [], state: "missing" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(normalized);
	} catch {
		return { files: [], state: "invalid", error: "CLANKY_SWARM_ARGS_JSON must be a JSON string array" };
	}
	if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
		return { files: [], state: "invalid", error: "CLANKY_SWARM_ARGS_JSON must be a JSON string array" };
	}
	return {
		files: parsed.filter((item) => item.startsWith("/")),
		state: "valid",
	};
}

function swarmMcpGate(
	enabled: boolean,
	command: string | undefined,
	commandFound: boolean,
	args: SwarmArgsStatus,
): string {
	if (!enabled) return "disabled";
	if (command === undefined) return "blocked_command_missing";
	if (!commandFound) return "blocked_command_not_found";
	if (args.state === "invalid") return "blocked_args_config";
	return "ready_preflight";
}

function herdrContext(paneId: string | undefined, socketPath: string | undefined, socketFile: string): string {
	if (paneId === undefined) return "missing_pane";
	if (socketPath === undefined) return "missing_socket";
	return socketFile === "present" ? "ready_preflight" : "blocked_socket_missing";
}

async function commandExists(command: string): Promise<boolean> {
	return (await findExecutable(command)) !== undefined;
}

async function findExecutable(command: string): Promise<string | undefined> {
	if (command.includes("/")) return (await isExecutable(command)) ? command : undefined;
	const path = process.env.PATH ?? "";
	for (const directory of path.split(delimiter)) {
		if (directory.length === 0) continue;
		const candidate = join(directory, command);
		if (await isExecutable(candidate)) return candidate;
	}
	return undefined;
}

async function isExecutable(path: string): Promise<boolean> {
	try {
		await access(path, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function launchdPlist(options: {
	homeDir: string;
	profile?: string;
	http?: string;
	cwd: string;
	command: string[];
	env: ServiceEnvEntry[];
	launchdLabel: string;
}): string {
	const env = environmentEntries(options);
	const args = options.command.map((arg) => `\t\t<string>${escapeXml(arg)}</string>`).join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${escapeXml(options.launchdLabel)}</string>
\t<key>ProgramArguments</key>
\t<array>
${args}
\t</array>
\t<key>WorkingDirectory</key>
\t<string>${escapeXml(options.cwd)}</string>
\t<key>EnvironmentVariables</key>
\t<dict>
${env}
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>
\t<key>StandardOutPath</key>
\t<string>${escapeXml(launchdLogPath(options.homeDir, options.profile, "out"))}</string>
\t<key>StandardErrorPath</key>
\t<string>${escapeXml(launchdLogPath(options.homeDir, options.profile, "err"))}</string>
</dict>
</plist>
`;
}

function launchdLogPath(homeDir: string, profile: string | undefined, stream: "out" | "err"): string {
	const suffix = profile === undefined || profile === DEFAULT_PROFILE ? "" : `.${profile}`;
	return join(homeDir, `clanky${suffix}.${stream}.log`);
}

function systemdUnit(options: {
	homeDir: string;
	profile?: string;
	http?: string;
	cwd: string;
	command: string[];
	env: ServiceEnvEntry[];
}): string {
	const env = options.env.map((entry) => `Environment=${systemdEscape(`${entry.key}=${entry.value}`)}`);
	return `[Unit]
Description=Clanky daemon
After=network.target

[Service]
Type=simple
WorkingDirectory=${systemdEscape(options.cwd)}
${env.join("\n")}
ExecStart=${options.command.map(systemdEscape).join(" ")}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function environmentEntries(options: { env: ServiceEnvEntry[] }): string {
	return options.env
		.map((entry) => `\t\t<key>${escapeXml(entry.key)}</key>\n\t\t<string>${escapeXml(entry.value)}</string>`)
		.join("\n");
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function systemdEscape(value: string): string {
	if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) return value;
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function readLockPid(lockFile: string): Promise<number | undefined> {
	try {
		const pid = Number.parseInt((await readFile(lockFile, "utf8")).trim(), 10);
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

function isDaemonUnavailableError(error: unknown): boolean {
	const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
	return code === "ENOENT" || code === "ECONNREFUSED" || code === "EINVAL";
}

function parseHttpAddress(value: string): { hostname: string; port: number } {
	const separator = value.lastIndexOf(":");
	if (separator === -1 && /^\d+$/.test(value)) {
		return { hostname: "127.0.0.1", port: parsePort(value, "Expected --http port between 1 and 65535") };
	}
	if (separator === -1) {
		throw new Error("Expected --http value in host:port form");
	}
	const hostname = value.slice(0, separator);
	const portText = value.slice(separator + 1);
	const port = parsePort(portText, "Expected --http value in host:port form");
	if (!hostname) {
		throw new Error("Expected --http value in host:port form");
	}
	return { hostname, port };
}

function hasHttp(args: ParsedArgs): boolean {
	return args.defaultHttp || args.http !== undefined;
}

function httpAddress(args: ParsedArgs): string {
	return args.http ?? defaultHttpAddress(args);
}

function defaultHttpAddress(args: ParsedArgs): string {
	const portEnv = normalizedEnv(process.env.CLANKY_PORT);
	const port =
		portEnv === undefined
			? defaultProfileHttpPort(resolveClankyPaths(pathOptions(args)).profile)
			: parsePort(portEnv, "CLANKY_PORT must be an integer between 1 and 65535");
	return `127.0.0.1:${port}`;
}

function defaultProfileHttpPort(profile: string): number {
	if (profile === DEFAULT_PROFILE) return 7766;
	return 7766 + profilePortOffset(profile);
}

function profilePortOffset(profile: string): number {
	let hash = 0;
	for (const char of profile) {
		hash = (hash * 31 + char.charCodeAt(0)) % 1000;
	}
	return hash + 1;
}

function parsePort(value: string, message: string): number {
	const port = Number.parseInt(value, 10);
	if (!Number.isInteger(port) || String(port) !== value || port <= 0 || port > 65535) throw new Error(message);
	return port;
}

async function eventStreamUrl(args: ParsedArgs): Promise<string> {
	if (!hasHttp(args)) throw new Error("--http is required for WebSocket dashboard events");
	const address = parseHttpAddress(httpAddress(args));
	const token = await httpToken(args);
	const url = new URL(`ws://${address.hostname}:${address.port}/events`);
	url.searchParams.set("token", token);
	return url.toString();
}

async function sendHttpGateway(args: ParsedArgs, params: ReturnType<typeof buildSendParams>): Promise<SendResult> {
	const sessionId = params.sessionId ?? "new";
	return (await requestHttpGateway(args, `/sessions/${encodeURIComponent(sessionId)}/messages`, {
		method: "POST",
		body: sendHttpBody(params),
		timeoutMs: 10 * 60 * 1000,
	})) as SendResult;
}

async function statusHttpGateway(args: ParsedArgs): Promise<StatusResult> {
	return (await requestHttpGateway(args, "/status")) as StatusResult;
}

function sendHttpBody(params: ReturnType<typeof buildSendParams>): Record<string, unknown> {
	const body: Record<string, unknown> = { prompt: params.prompt };
	if (params.skill !== undefined) body.skill = params.skill;
	if (params.provider !== undefined) body.provider = params.provider;
	if (params.model !== undefined) body.model = params.model;
	return body;
}

interface HttpGatewayRequestOptions {
	method?: "GET" | "POST";
	body?: Record<string, unknown>;
	timeoutMs?: number;
}

async function requestHttpGateway(
	args: ParsedArgs,
	path: string,
	options: HttpGatewayRequestOptions = {},
): Promise<unknown> {
	const token = await httpToken(args);
	const headers: Record<string, string> = { authorization: `Bearer ${token}` };
	if (options.body !== undefined) headers["content-type"] = "application/json";
	const controller = new AbortController();
	const timeout =
		options.timeoutMs === undefined
			? undefined
			: setTimeout(() => {
					controller.abort();
				}, options.timeoutMs);
	try {
		const requestInit: NonNullable<Parameters<typeof fetch>[1]> = {
			method: options.method ?? "GET",
			headers,
			signal: controller.signal,
		};
		if (options.body !== undefined) requestInit.body = JSON.stringify(options.body);
		const response = await fetch(new URL(path, httpBaseUrl(args)), requestInit);
		if (!response.ok) {
			throw new Error(await httpErrorMessage(response));
		}
		return (await response.json()) as unknown;
	} catch (error) {
		if (isAbortError(error)) {
			throw new Error(`HTTP request timed out after ${options.timeoutMs}ms`);
		}
		throw error;
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

function httpBaseUrl(args: ParsedArgs): string {
	const address = parseHttpAddress(httpAddress(args));
	return `http://${address.hostname}:${address.port}`;
}

async function httpToken(args: ParsedArgs): Promise<string> {
	const token = (await readFile(resolveClankyPaths(pathOptions(args)).httpTokenFile, "utf8")).trim();
	if (token.length === 0) throw new Error("HTTP token file is empty");
	return token;
}

async function httpErrorMessage(response: Awaited<ReturnType<typeof fetch>>): Promise<string> {
	const text = await response.text();
	const error = parsedErrorMessage(text) ?? text.trim();
	const suffix = error.length === 0 ? "" : `: ${error}`;
	return `HTTP ${response.status} ${response.statusText}${suffix}`;
}

function parsedErrorMessage(text: string): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const error = (parsed as Record<string, unknown>).error;
	return typeof error === "string" ? error : undefined;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

async function main(): Promise<void> {
	const parsed = parseArgs(process.argv.slice(2));
	if (parsed.command === "help") {
		console.log(usage());
		return;
	}
	if (parsed.command === "start") {
		await runStart(parsed);
		return;
	}
	if (parsed.command === "send") {
		await runSend(parsed);
		return;
	}
	if (parsed.command === "session") {
		await runSession(parsed);
		return;
	}
	if (parsed.command === "cron") {
		await runCron(parsed);
		return;
	}
	if (parsed.command === "skill") {
		await runSkill(parsed);
		return;
	}
	if (parsed.command === "task") {
		await runTask(parsed);
		return;
	}
	if (parsed.command === "linear") {
		await runLinear(parsed);
		return;
	}
	if (parsed.command === "swarm") {
		await runSwarm(parsed);
		return;
	}
	if (parsed.command === "profile") {
		await runProfile(parsed);
		return;
	}
	if (parsed.command === "install") {
		await runInstall(parsed);
		return;
	}
	if (parsed.command === "uninstall") {
		await runUninstall(parsed);
		return;
	}
	if (parsed.command === "mcp") {
		await runMcp(parsed);
		return;
	}
	if (parsed.command === "tui") {
		await runTui(parsed);
		return;
	}
	if (parsed.command === "status") {
		await runStatus(parsed);
		return;
	}
	if (parsed.command === "doctor") {
		await runDoctor(parsed);
		return;
	}
	if (parsed.command === "stop") {
		await runStop(parsed);
		return;
	}
	throw new Error(`Unknown command: ${parsed.command}`);
}

function isMainModule(): boolean {
	const entry = process.argv[1];
	if (entry === undefined) return false;
	const current = fileURLToPath(import.meta.url);
	try {
		return realpathSync(entry) === realpathSync(current);
	} catch {
		return entry === current;
	}
}

if (isMainModule()) {
	main().catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(message);
		process.exitCode = 1;
	});
}
