import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveClankyPaths } from "@clanky/core";

const modelAuthEnvKeys = [
	"AI_GATEWAY_API_KEY",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"AWS_ACCESS_KEY_ID",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_PROFILE",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"AZURE_OPENAI_API_KEY",
	"CEREBRAS_API_KEY",
	"CLOUDFLARE_API_KEY",
	"COPILOT_GITHUB_TOKEN",
	"DEEPSEEK_API_KEY",
	"FIREWORKS_API_KEY",
	"GCLOUD_PROJECT",
	"GEMINI_API_KEY",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_API_KEY",
	"GOOGLE_CLOUD_LOCATION",
	"GOOGLE_CLOUD_PROJECT",
	"GROQ_API_KEY",
	"HF_TOKEN",
	"KIMI_API_KEY",
	"MINIMAX_API_KEY",
	"MINIMAX_CN_API_KEY",
	"MISTRAL_API_KEY",
	"MOONSHOT_API_KEY",
	"OPENAI_API_KEY",
	"OPENCODE_API_KEY",
	"OPENROUTER_API_KEY",
	"TOGETHER_API_KEY",
	"XAI_API_KEY",
	"XIAOMI_API_KEY",
	"XIAOMI_TOKEN_PLAN_AMS_API_KEY",
	"XIAOMI_TOKEN_PLAN_CN_API_KEY",
	"XIAOMI_TOKEN_PLAN_SGP_API_KEY",
	"ZAI_API_KEY",
];

const homeDir = await mkdtemp(join(tmpdir(), "clanky-doctor-"));
const fakeSwarmEntrypoint = join(homeDir, "fake-swarm-mcp.js");
const defaultLaunchdPlist = join(homeDir, "Library", "LaunchAgents", "com.clanky.daemon.plist");
const workLaunchdPlist = join(homeDir, "Library", "LaunchAgents", "com.clanky.daemon.work.plist");
const personalLaunchdPlist = join(homeDir, "Library", "LaunchAgents", "com.clanky.daemon.personal.plist");
const fakeHerdrSocket = join(homeDir, "herdr.sock");
await writeFile(fakeSwarmEntrypoint, "", { mode: 0o600 });
await symlink(fakeSwarmEntrypoint, fakeHerdrSocket);

const previousEnv = captureEnv(
	...modelAuthEnvKeys,
	"CLANKY_SWARM_ENABLED",
	"CLANKY_SWARM_COMMAND",
	"CLANKY_SWARM_ARGS_JSON",
	"LINEAR_API_KEY",
	"LINEAR_ACCESS_TOKEN",
	"HERDR_PANE_ID",
	"HERDR_SOCKET",
	"HERDR_SOCKET_PATH",
	"CLANKY_MCP_SERVERS_JSON",
	"HOME",
);
process.env.HOME = homeDir;
process.env.CLANKY_SWARM_ENABLED = "1";
process.env.CLANKY_SWARM_COMMAND = process.execPath;
process.env.CLANKY_SWARM_ARGS_JSON = JSON.stringify([fakeSwarmEntrypoint]);
process.env.HERDR_PANE_ID = "pane-doctor-smoke";
process.env.HERDR_SOCKET = join(homeDir, "legacy-herdr.sock");
process.env.HERDR_SOCKET_PATH = fakeHerdrSocket;
delete process.env.CLANKY_MCP_SERVERS_JSON;
delete process.env.LINEAR_API_KEY;
delete process.env.LINEAR_ACCESS_TOKEN;
for (const key of modelAuthEnvKeys) delete process.env[key];

try {
	const doctor = await runClanky(["doctor", "--home", homeDir]);
	assertCommandSucceeded("doctor", doctor);
	assertIncludes(doctor.stdout, `home: ${homeDir}`);
	assertIncludes(doctor.stdout, "profile: default");
	assertIncludes(doctor.stdout, "launchd_label: com.clanky.daemon");
	assertIncludes(doctor.stdout, `launchd_plist: ${defaultLaunchdPlist}\tmissing`);
	assertIncludes(doctor.stdout, "pnpm: ");
	assertIncludes(doctor.stdout, "model_credentials: missing");
	assertIncludes(doctor.stdout, "model_available_models: 0");
	assertIncludes(doctor.stdout, "model_available_providers: missing");
	assertIncludes(doctor.stdout, "model_auth_providers: missing");
	assertIncludes(doctor.stdout, "calendar_tooling: missing");
	assertIncludes(doctor.stdout, "calendar_tooling_servers: missing");
	assertIncludes(
		doctor.stdout,
		"warning: no configured Pi model credentials; model-backed send and cron live gates will fail",
	);
	assertIncludes(doctor.stdout, "linear_credentials: missing");
	assertIncludes(doctor.stdout, "swarm_enabled: true");
	assertIncludes(doctor.stdout, `swarm_command: ${process.execPath}`);
	assertIncludes(doctor.stdout, "swarm_command_absolute: true");
	assertIncludes(doctor.stdout, "swarm_command_found: true");
	assertIncludes(doctor.stdout, "swarm_args_json: valid");
	assertIncludes(doctor.stdout, `swarm_args_file: ${fakeSwarmEntrypoint}\tpresent`);
	assertIncludes(doctor.stdout, "herdr: ");
	assertIncludes(doctor.stdout, "herdr_pane_id: pane-doctor-smoke");
	assertIncludes(doctor.stdout, `herdr_socket: ${fakeHerdrSocket}`);
	assertIncludes(doctor.stdout, `herdr_socket_path: ${fakeHerdrSocket}`);
	assertNotIncludes(doctor.stdout, "legacy-herdr.sock");
	assertIncludes(doctor.stdout, "herdr_socket_file: present");
	assertIncludes(doctor.stdout, "herdr_context: ready_preflight");
	assertIncludes(doctor.stdout, "claude_code_mcp_config: missing");
	assertIncludes(doctor.stdout, "claude_code_mcp_mount: missing");
	assertIncludes(doctor.stdout, "claude_code_mcp_servers: missing");
	assertIncludes(doctor.stdout, "live_gate_launchd_restart: ");
	assertIncludes(doctor.stdout, "live_gate_model_calendar: blocked_model_credentials");
	assertIncludes(doctor.stdout, "live_gate_linear_cron: blocked_credentials");
	assertIncludes(doctor.stdout, "live_gate_swarm_mcp: ready_preflight");
	assertIncludes(doctor.stdout, "live_gate_claude_code_mcp: requires_client_mount");
	assertIncludes(doctor.stdout, "live_gate_profile_daemons: ");

	const doctorJson = await runClanky(["doctor", "--home", homeDir, "--json"]);
	assertCommandSucceeded("doctor json", doctorJson);
	const parsedDoctorJson = parseJsonObject(doctorJson.stdout);
	assertJsonString(parsedDoctorJson, "home", homeDir);
	assertJsonString(parsedDoctorJson, "profile", "default");
	assertJsonString(parsedDoctorJson, "launchd_label", "com.clanky.daemon");
	assertJsonString(parsedDoctorJson, "launchd_plist_path", defaultLaunchdPlist);
	assertJsonString(parsedDoctorJson, "launchd_plist_state", "missing");
	assertJsonString(parsedDoctorJson, "profile_daemon_work_label", "com.clanky.daemon.work");
	assertJsonString(parsedDoctorJson, "profile_daemon_work_plist_path", workLaunchdPlist);
	assertJsonString(parsedDoctorJson, "profile_daemon_work_plist_state", "missing");
	assertJsonString(parsedDoctorJson, "profile_daemon_personal_label", "com.clanky.daemon.personal");
	assertJsonString(parsedDoctorJson, "profile_daemon_personal_plist_path", personalLaunchdPlist);
	assertJsonString(parsedDoctorJson, "profile_daemon_personal_plist_state", "missing");
	assertJsonString(parsedDoctorJson, "model_credentials", "missing");
	assertJsonString(parsedDoctorJson, "linear_credentials", "missing");
	assertJsonString(parsedDoctorJson, "swarm_enabled", "true");
	assertJsonString(parsedDoctorJson, "swarm_args_file_path", fakeSwarmEntrypoint);
	assertJsonString(parsedDoctorJson, "swarm_args_file_state", "present");
	assertJsonString(parsedDoctorJson, "swarm_mcp_dist_path", "/Users/jamesvolpe/web/swarm-mcp/dist/index.js");
	assertJsonString(parsedDoctorJson, "live_gate_swarm_mcp", "ready_preflight");
	assertJsonString(parsedDoctorJson, "live_gate_claude_code_mcp", "requires_client_mount");
	assertLiveGateJsonPair(parsedDoctorJson, "launchd_restart", "live_gate_launchd_restart");
	assertLiveGateJsonPair(parsedDoctorJson, "model_calendar", "live_gate_model_calendar");
	assertLiveGateJsonPair(parsedDoctorJson, "linear_cron", "live_gate_linear_cron");
	assertLiveGateJsonPair(parsedDoctorJson, "swarm_mcp", "live_gate_swarm_mcp");
	assertLiveGateJsonPair(parsedDoctorJson, "claude_code_mcp", "live_gate_claude_code_mcp");
	assertLiveGateJsonPair(parsedDoctorJson, "profile_daemons", "live_gate_profile_daemons");
	assertJsonObjectString(parsedDoctorJson, "live_gate_blockers", "model_calendar", "blocked_model_credentials");
	assertJsonObjectString(parsedDoctorJson, "live_gate_blockers", "linear_cron", "blocked_credentials");
	assertJsonObjectMissing(parsedDoctorJson, "live_gate_blockers", "swarm_mcp");
	assertJsonObjectString(parsedDoctorJson, "live_gate_blockers", "claude_code_mcp", "requires_client_mount");
	assertJsonString(
		parsedDoctorJson,
		"warning",
		"no configured Pi model credentials; model-backed send and cron live gates will fail",
	);
	assertJsonStringArray(parsedDoctorJson, "warnings", [
		"no configured Pi model credentials; model-backed send and cron live gates will fail",
	]);

	delete process.env.CLANKY_SWARM_COMMAND;
	const missingSwarmCommandDoctor = await runClanky(["doctor", "--home", homeDir]);
	assertCommandSucceeded("missing swarm command doctor", missingSwarmCommandDoctor);
	assertIncludes(missingSwarmCommandDoctor.stdout, "swarm_command: missing");
	assertIncludes(missingSwarmCommandDoctor.stdout, "swarm_command_found: false");
	assertIncludes(missingSwarmCommandDoctor.stdout, "live_gate_swarm_mcp: blocked_command_missing");

	process.env.CLANKY_SWARM_COMMAND = join(homeDir, "missing-swarm-command");
	const missingSwarmCommandPathDoctor = await runClanky(["doctor", "--home", homeDir]);
	assertCommandSucceeded("missing swarm command path doctor", missingSwarmCommandPathDoctor);
	assertIncludes(missingSwarmCommandPathDoctor.stdout, `swarm_command: ${join(homeDir, "missing-swarm-command")}`);
	assertIncludes(missingSwarmCommandPathDoctor.stdout, "swarm_command_found: false");
	assertIncludes(missingSwarmCommandPathDoctor.stdout, "live_gate_swarm_mcp: blocked_command_not_found");

	process.env.CLANKY_SWARM_COMMAND = process.execPath;

	await mkdir(dirname(defaultLaunchdPlist), { recursive: true, mode: 0o700 });
	await writeFile(defaultLaunchdPlist, '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0" />\n', {
		mode: 0o644,
	});
	const plistDoctor = await runClanky(["doctor", "--home", homeDir]);
	assertCommandSucceeded("launchd plist doctor", plistDoctor);
	assertIncludes(plistDoctor.stdout, `launchd_plist: ${defaultLaunchdPlist}\tpresent`);

	const claudeConfigFile = join(homeDir, ".claude", ".claude.json");
	await mkdir(dirname(claudeConfigFile), { recursive: true, mode: 0o700 });
	await writeFile(
		claudeConfigFile,
		JSON.stringify(
			{
				projects: {
					[process.cwd()]: {
						mcpServers: {
							clanky: {
								command: "pnpm",
								args: ["--silent", "clanky", "mcp", "--home", homeDir],
							},
						},
					},
				},
			},
			null,
			"\t",
		),
		{ mode: 0o600 },
	);
	const mountedDoctor = await runClanky(["doctor", "--home", homeDir]);
	assertCommandSucceeded("mounted Claude Code MCP doctor", mountedDoctor);
	assertIncludes(mountedDoctor.stdout, `claude_code_mcp_config: ${claudeConfigFile}`);
	assertIncludes(mountedDoctor.stdout, "claude_code_mcp_mount: mounted");
	assertIncludes(mountedDoctor.stdout, "claude_code_mcp_servers: clanky");
	assertIncludes(mountedDoctor.stdout, "live_gate_claude_code_mcp: mounted");
	assertIncludes(mountedDoctor.stdout, "profile_daemon_work: ");
	assertIncludes(mountedDoctor.stdout, "profile_daemon_work_label: com.clanky.daemon.work");
	assertIncludes(mountedDoctor.stdout, `profile_daemon_work_plist: ${workLaunchdPlist}\tmissing`);
	assertIncludes(mountedDoctor.stdout, "profile_daemon_personal: ");
	assertIncludes(mountedDoctor.stdout, "profile_daemon_personal_label: com.clanky.daemon.personal");
	assertIncludes(mountedDoctor.stdout, `profile_daemon_personal_plist: ${personalLaunchdPlist}\tmissing`);
	assertIncludes(mountedDoctor.stdout, "live_gate_profile_daemons: ");

	process.env.HERDR_SOCKET_PATH = join(homeDir, "missing-herdr.sock");
	const missingHerdrSocketDoctor = await runClanky(["doctor", "--home", homeDir]);
	assertCommandSucceeded("missing herdr socket doctor", missingHerdrSocketDoctor);
	assertIncludes(missingHerdrSocketDoctor.stdout, "herdr_socket_file: missing");
	assertIncludes(missingHerdrSocketDoctor.stdout, "herdr_context: blocked_socket_missing");
	process.env.HERDR_SOCKET_PATH = fakeHerdrSocket;

	delete process.env.HERDR_SOCKET_PATH;
	delete process.env.HERDR_SOCKET;
	const missingHerdrSocketEnvDoctor = await runClanky(["doctor", "--home", homeDir]);
	assertCommandSucceeded("missing herdr socket env doctor", missingHerdrSocketEnvDoctor);
	assertIncludes(missingHerdrSocketEnvDoctor.stdout, "herdr_socket_file: missing");
	assertIncludes(missingHerdrSocketEnvDoctor.stdout, "herdr_context: missing_socket");
	process.env.HERDR_SOCKET_PATH = fakeHerdrSocket;

	const profileDoctor = await runClanky(["doctor", "--home", homeDir, "--profile", "work"]);
	assertCommandSucceeded("profile doctor", profileDoctor);
	assertIncludes(profileDoctor.stdout, "profile: work");
	assertIncludes(profileDoctor.stdout, "launchd_label: com.clanky.daemon.work");
	assertIncludes(
		profileDoctor.stdout,
		`launchd_plist: ${join(homeDir, "Library", "LaunchAgents", "com.clanky.daemon.work.plist")}\tmissing`,
	);

	const paths = resolveClankyPaths({ homeDir });
	await mkdir(dirname(paths.modelsFile), { recursive: true, mode: 0o700 });
	await writeFile(
		paths.modelsFile,
		JSON.stringify(
			{
				providers: {
					"doctor-faux": {
						api: "openai-completions",
						apiKey: "doctor-faux-key",
						baseUrl: "http://localhost:0",
						models: [{ id: "doctor-model", name: "Doctor Model", input: ["text"], reasoning: false }],
					},
				},
			},
			null,
			"\t",
		),
		{ mode: 0o600 },
	);
	const configuredDoctor = await runClanky(["doctor", "--home", homeDir]);
	assertCommandSucceeded("configured model doctor", configuredDoctor);
	assertIncludes(configuredDoctor.stdout, "model_credentials: set");
	assertIncludes(configuredDoctor.stdout, "model_available_models: 1");
	assertIncludes(configuredDoctor.stdout, "model_available_providers: doctor-faux");
	assertIncludes(configuredDoctor.stdout, "live_gate_model_calendar: requires_calendar_tooling");
	assertNotIncludes(configuredDoctor.stdout, "doctor-faux-key");

	process.env.OPENAI_API_KEY = "openai-doctor-secret";
	process.env.ANTHROPIC_API_KEY = "anthropic-doctor-secret";
	const envModelCredentialDoctor = await runClanky(["doctor", "--home", homeDir]);
	assertCommandSucceeded("env model credential doctor", envModelCredentialDoctor);
	assertIncludes(envModelCredentialDoctor.stdout, "model_credentials: set");
	assertNotIncludes(envModelCredentialDoctor.stdout, "openai-doctor-secret");
	assertNotIncludes(envModelCredentialDoctor.stdout, "anthropic-doctor-secret");
	delete process.env.OPENAI_API_KEY;
	delete process.env.ANTHROPIC_API_KEY;

	process.env.CLANKY_MCP_SERVERS_JSON = "{";
	const invalidCalendarConfigDoctor = await runClanky(["doctor", "--home", homeDir]);
	assertCommandSucceeded("invalid calendar config doctor", invalidCalendarConfigDoctor);
	assertIncludes(invalidCalendarConfigDoctor.stdout, "calendar_tooling: missing");
	assertIncludes(
		invalidCalendarConfigDoctor.stdout,
		"calendar_tooling_error: CLANKY_MCP_SERVERS_JSON must be valid JSON",
	);
	assertIncludes(invalidCalendarConfigDoctor.stdout, "live_gate_model_calendar: blocked_calendar_config");

	process.env.CLANKY_MCP_SERVERS_JSON = JSON.stringify([
		{
			name: "google-calendar",
			command: process.execPath,
			args: [fakeSwarmEntrypoint],
		},
	]);
	const calendarReadyDoctor = await runClanky(["doctor", "--home", homeDir]);
	assertCommandSucceeded("calendar tooling doctor", calendarReadyDoctor);
	assertIncludes(calendarReadyDoctor.stdout, "calendar_tooling: configured");
	assertIncludes(calendarReadyDoctor.stdout, "calendar_tooling_servers: google-calendar");
	assertIncludes(calendarReadyDoctor.stdout, "live_gate_model_calendar: ready_preflight");
	delete process.env.CLANKY_MCP_SERVERS_JSON;

	process.env.LINEAR_API_KEY = "linear-doctor-secret";
	const linearReadyDoctor = await runClanky(["doctor", "--home", homeDir]);
	assertCommandSucceeded("Linear credential doctor", linearReadyDoctor);
	assertIncludes(linearReadyDoctor.stdout, "linear_credentials: set");
	assertIncludes(linearReadyDoctor.stdout, "live_gate_linear_cron: ready_credentials");
	assertNotIncludes(linearReadyDoctor.stdout, "linear-doctor-secret");

	process.env.CLANKY_SWARM_COMMAND = "node";
	const launchdWarningDoctor = await runClanky(["doctor", "--home", homeDir]);
	assertCommandSucceeded("launchd warning doctor", launchdWarningDoctor);
	assertIncludes(launchdWarningDoctor.stdout, "swarm_command_absolute: false");
	assertIncludes(
		launchdWarningDoctor.stdout,
		"warning: launchd services should set CLANKY_SWARM_COMMAND to an absolute executable path",
	);
	const launchdWarningDoctorJson = await runClanky(["doctor", "--home", homeDir, "--json"]);
	assertCommandSucceeded("launchd warning doctor json", launchdWarningDoctorJson);
	assertJsonStringArray(parseJsonObject(launchdWarningDoctorJson.stdout), "warnings", [
		"launchd services should set CLANKY_SWARM_COMMAND to an absolute executable path",
	]);

	process.env.CLANKY_SWARM_COMMAND = process.execPath;
	process.env.CLANKY_SWARM_ARGS_JSON = "{";
	const invalidSwarmArgsDoctor = await runClanky(["doctor", "--home", homeDir]);
	assertCommandSucceeded("invalid swarm args doctor", invalidSwarmArgsDoctor);
	assertIncludes(invalidSwarmArgsDoctor.stdout, "swarm_args_json: invalid");
	assertIncludes(invalidSwarmArgsDoctor.stdout, "swarm_args_error: CLANKY_SWARM_ARGS_JSON must be a JSON string array");
	assertIncludes(invalidSwarmArgsDoctor.stdout, "live_gate_swarm_mcp: blocked_args_config");
	console.log(JSON.stringify({ doctorBytes: doctor.stdout.length }));
} finally {
	restoreEnv(previousEnv);
	await rm(homeDir, { force: true, recursive: true });
}

interface CommandResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

async function runClanky(args: string[]): Promise<CommandResult> {
	const child = spawn(process.execPath, ["--import", "tsx", "packages/clanky-cli/src/bin.ts", ...args], {
		cwd: process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString("utf8");
	});
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		child.kill("SIGTERM");
	}, 10_000);
	const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => {
			resolve({ code, signal });
		});
	});
	clearTimeout(timeout);
	if (timedOut) {
		throw new Error(`clanky ${args.join(" ")} timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`);
	}
	return { ...result, stdout, stderr };
}

function assertIncludes(value: string, expected: string): void {
	if (!value.includes(expected)) throw new Error(`Missing expected output: ${expected}\nActual:\n${value}`);
}

function assertNotIncludes(value: string, unexpected: string): void {
	if (value.includes(unexpected)) throw new Error(`Unexpected output: ${unexpected}\nActual:\n${value}`);
}

function assertCommandSucceeded(label: string, result: CommandResult): void {
	if (result.code === 0) return;
	throw new Error(`${label} failed with ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function parseJsonObject(value: string): Record<string, unknown> {
	const parsed = JSON.parse(value) as unknown;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Expected JSON object, got: ${value}`);
	}
	return parsed as Record<string, unknown>;
}

function assertJsonString(value: Record<string, unknown>, key: string, expected: string): void {
	const actual = value[key];
	if (actual !== expected) {
		throw new Error(`Expected JSON ${key}=${expected}, got ${JSON.stringify(actual)} in ${JSON.stringify(value)}`);
	}
}

function assertJsonStringArray(value: Record<string, unknown>, key: string, expected: string[]): void {
	const actual = value[key];
	if (!Array.isArray(actual) || actual.some((item) => typeof item !== "string")) {
		throw new Error(`Expected JSON ${key} string array, got ${JSON.stringify(actual)} in ${JSON.stringify(value)}`);
	}
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(`Expected JSON ${key}=${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
}

function assertLiveGateJsonPair(value: Record<string, unknown>, field: string, flatKey: string): void {
	const liveGates = value.live_gates;
	if (typeof liveGates !== "object" || liveGates === null || Array.isArray(liveGates)) {
		throw new Error(`Expected JSON live_gates object, got ${JSON.stringify(liveGates)} in ${JSON.stringify(value)}`);
	}
	const grouped = (liveGates as Record<string, unknown>)[field];
	const flat = value[flatKey];
	if (typeof grouped !== "string" || grouped !== flat) {
		throw new Error(
			`Expected live_gates.${field} to match ${flatKey}, got ${JSON.stringify(grouped)} vs ${JSON.stringify(flat)}`,
		);
	}
}

function assertJsonObjectString(value: Record<string, unknown>, key: string, field: string, expected: string): void {
	const object = value[key];
	if (typeof object !== "object" || object === null || Array.isArray(object)) {
		throw new Error(`Expected JSON ${key} object, got ${JSON.stringify(object)} in ${JSON.stringify(value)}`);
	}
	const actual = (object as Record<string, unknown>)[field];
	if (actual !== expected) {
		throw new Error(`Expected JSON ${key}.${field}=${expected}, got ${JSON.stringify(actual)}`);
	}
}

function assertJsonObjectMissing(value: Record<string, unknown>, key: string, field: string): void {
	const object = value[key];
	if (typeof object !== "object" || object === null || Array.isArray(object)) {
		throw new Error(`Expected JSON ${key} object, got ${JSON.stringify(object)} in ${JSON.stringify(value)}`);
	}
	if (field in object) {
		throw new Error(
			`Expected JSON ${key}.${field} to be absent, got ${JSON.stringify((object as Record<string, unknown>)[field])}`,
		);
	}
}

function captureEnv(...keys: string[]): Map<string, string | undefined> {
	const values = new Map<string, string | undefined>();
	for (const key of keys) values.set(key, process.env[key]);
	return values;
}

function restoreEnv(values: Map<string, string | undefined>): void {
	for (const [key, value] of values) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}
