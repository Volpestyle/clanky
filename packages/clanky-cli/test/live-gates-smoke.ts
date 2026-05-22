import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const docs = await readFile("docs/live-gates.md", "utf8");
assertNoForbiddenPackageManagerCommands("docs/live-gates.md", docs);
assertIncludes(docs, "do not bootstrap launchd until the user explicitly approves it", "runbook must gate launchd");
assertIncludes(docs, "pnpm clanky doctor --home ~/.clanky", "runbook must start with doctor");
assertIncludes(
	docs,
	"pnpm --silent clanky doctor --home ~/.clanky --json",
	"runbook must document silent doctor JSON mode",
);
assertNotIncludes(
	docs,
	"pnpm clanky doctor --home ~/.clanky --json",
	"runbook must not document parse-breaking pnpm JSON mode without --silent",
);
assertIncludes(docs, "stable key/value gate states", "runbook must explain doctor JSON automation output");
assertIncludes(docs, "stdout is parseable JSON", "runbook must explain why pnpm JSON mode uses --silent");
assertIncludes(docs, "stable `warnings` array", "runbook must document stable JSON warnings");
assertIncludes(docs, "`live_gates` object", "runbook must document grouped JSON live gates");
assertIncludes(docs, "`live_gate_blockers` object", "runbook must document grouped JSON live gate blockers");
assertIncludes(docs, "launchd_plist_path", "runbook must document split JSON path probe keys");
assertIncludes(docs, "swarm_mcp_dist_state", "runbook must document split JSON path probe states");
assertIncludes(docs, "launchd_plist: ", "runbook must document launchd plist state");
assertIncludes(docs, "model_available_models: 0", "runbook must document missing usable models");
assertIncludes(docs, "calendar_tooling: missing", "runbook must document missing calendar tooling");
assertIncludes(docs, "calendar_tooling_error", "runbook must document invalid calendar tooling config");
assertIncludes(docs, "swarm_command: missing", "runbook must document missing default swarm command");
assertIncludes(docs, "swarm_args_json: missing", "runbook must document missing swarm args config");
assertIncludes(docs, "swarm_args_json: invalid", "runbook must document invalid swarm args config");
assertIncludes(docs, "live_gate_launchd_restart: approval_required", "runbook must document the blocked launchd gate");
assertIncludes(docs, "live_gate_launchd_restart: installed", "runbook must document installed launchd gate");
assertIncludes(docs, "live_gate_launchd_restart: not_applicable", "runbook must document non-launchd gate");
assertIncludes(
	docs,
	"live_gate_model_calendar: blocked_model_credentials",
	"runbook must document the blocked model/calendar gate",
);
assertIncludes(
	docs,
	"live_gate_model_calendar: blocked_calendar_config",
	"runbook must document invalid calendar config",
);
assertIncludes(
	docs,
	"live_gate_model_calendar: requires_calendar_tooling",
	"runbook must document the post-credential calendar tooling gate",
);
assertIncludes(
	docs,
	"live_gate_model_calendar: ready_preflight",
	"runbook must document the configured model/calendar preflight state",
);
assertIncludes(
	docs,
	'pnpm clanky send --home ~/.clanky "what\'s on the calendar"',
	"runbook must include the live calendar send command",
);
assertIncludes(
	docs,
	'pnpm clanky session search --home ~/.clanky "calendar"',
	"runbook must include calendar session search verification",
);
assertIncludes(
	docs,
	"pnpm clanky session export --home ~/.clanky --output /tmp/clanky-calendar-session.jsonl <session-id>",
	"runbook must include calendar JSONL export evidence",
);
assertIncludes(
	docs,
	"pnpm clanky session export --home ~/.clanky --html /tmp/clanky-calendar-session.html <session-id>",
	"runbook must include calendar HTML export evidence",
);
assertIncludes(
	docs,
	"session search finds the calendar-backed answer",
	"runbook must require calendar search evidence",
);
assertIncludes(
	docs,
	"JSONL and HTML exports contain the calendar-backed answer",
	"runbook must require calendar export evidence",
);
assertIncludes(
	docs,
	"live_gate_linear_cron: blocked_credentials",
	"runbook must document the blocked Linear cron gate",
);
assertIncludes(docs, "live_gate_linear_cron: ready_credentials", "runbook must document ready Linear credentials");
assertIncludes(docs, "live_gate_swarm_mcp: disabled", "runbook must document the disabled swarm gate");
assertIncludes(docs, "live_gate_swarm_mcp: blocked_command_missing", "runbook must document missing swarm command");
assertIncludes(docs, "live_gate_swarm_mcp: blocked_command_not_found", "runbook must document unfound swarm command");
assertIncludes(docs, "live_gate_swarm_mcp: blocked_args_config", "runbook must document the invalid swarm args gate");
assertIncludes(docs, "live_gate_swarm_mcp: ready_preflight", "runbook must document ready swarm preflight");
assertIncludes(
	docs,
	"Current audit note: the direct `swarm_mcp` live gate and mounted Claude Code MCP dispatch path have been captured",
	"runbook must distinguish completed direct swarm evidence from default disabled doctor state",
);
assertIncludes(
	docs,
	"mounted Claude Code MCP dispatch path have been captured",
	"runbook must distinguish completed mounted-client evidence from revalidation runbook state",
);
assertIncludes(
	docs,
	"live_gate_claude_code_mcp: requires_client_mount",
	"runbook must document the Claude Code client mount gate",
);
assertIncludes(docs, "live_gate_claude_code_mcp: mounted", "runbook must document mounted client state");
assertIncludes(docs, "claude_code_mcp_mount: missing", "runbook must document missing Claude Code MCP mount");
assertIncludes(docs, "claude_code_mcp_mount: mounted", "runbook must document mounted Claude Code MCP state");
assertIncludes(docs, "herdr_socket_file: present", "runbook must document present herdr socket file");
assertIncludes(docs, "herdr_socket_file: missing", "runbook must document missing herdr socket file");
assertIncludes(docs, "herdr_context: missing_pane", "runbook must document missing herdr pane");
assertIncludes(docs, "herdr_context: missing_socket", "runbook must document missing herdr socket env");
assertIncludes(docs, "herdr_context: ready_preflight", "runbook must document ready herdr context");
assertIncludes(docs, "herdr_context: blocked_socket_missing", "runbook must document missing herdr socket");
assertIncludes(docs, "Clanky uses `HERDR_SOCKET_PATH`", "runbook must document canonical herdr socket precedence");
assertIncludes(docs, "profile_daemon_work: missing", "runbook must document missing work profile service");
assertIncludes(docs, "profile_daemon_personal: missing", "runbook must document missing personal profile service");
assertIncludes(
	docs,
	"live_gate_profile_daemons: approval_required",
	"runbook must document the blocked profile daemon gate",
);
assertIncludes(docs, "live_gate_profile_daemons: installed", "runbook must document installed profile daemons");
assertIncludes(docs, "live_gate_profile_daemons: not_applicable", "runbook must document non-launchd profile daemons");
assertIncludes(docs, "profile_daemon_work_plist_path", "runbook must document split work profile plist probe");
assertIncludes(docs, "profile_daemon_personal_plist_path", "runbook must document split personal profile plist probe");
assertIncludes(docs, "Approve bootstrapping com.clanky.daemon?", "runbook must keep the launchd approval ask concise");
assertIncludes(docs, "## Waiving A Gate", "runbook must define explicit live-gate waivers");
assertIncludes(
	docs,
	"A live gate is waived only when the user explicitly names the gate and accepts the remaining risk",
	"runbook must require explicit user risk acceptance for waivers",
);
assertIncludes(docs, "Waive live gate: <gate-name>", "runbook must include waiver template");
assertIncludes(docs, "Residual risk: <what remains unverified>", "runbook must include residual-risk field");
assertIncludes(
	docs,
	"Valid gate names are `launchd_restart`, `model_calendar`, `linear_cron`, `swarm_mcp`, `claude_code_mcp`, and `profile_daemons`.",
	"runbook must list valid waiver gate names",
);
assertIncludes(docs, "## Current Gate Manifest", "runbook must include a concise current gate manifest");
for (const gate of [
	"`launchd_restart`",
	"`model_calendar`",
	"`linear_cron`",
	"`swarm_mcp`",
	"`claude_code_mcp`",
	"`profile_daemons`",
]) {
	assertIncludes(docs, gate, `runbook manifest must include ${gate}`);
}
assertIncludes(
	docs,
	"Do not mark a gate passed from a `ready_*` doctor state alone",
	"runbook manifest must forbid treating preflight readiness as live evidence",
);
assertIncludes(docs, "Required live evidence", "runbook manifest must name required live evidence");
assertIncludes(docs, "Cleanup", "runbook manifest must name cleanup actions");
assertIncludes(docs, "## 4. Swarm MCP Gate", "runbook must split the direct swarm MCP live gate");
assertIncludes(docs, "## 5. Claude Code MCP Mount Gate", "runbook must split the Claude Code mount gate");
assertIncludes(docs, "## 6. Concurrent Launchd Profile Gate", "runbook must keep the profile gate numbered separately");
assertIncludes(
	docs,
	"Use one Clanky home so the gate exercises",
	"runbook must keep profile-daemon live evidence aligned with the single-home profile model",
);
assertIncludes(
	docs,
	"This gate can be run without a Claude Code client mount",
	"runbook must make direct swarm validation independent from the Claude Code mount",
);
assertIncludes(
	docs,
	"Current audit evidence has been captured on this machine",
	"runbook must mark the Claude Code MCP live evidence captured",
);
assertIncludes(
	docs,
	"Run this after or alongside a booted Swarm MCP gate",
	"runbook must tie mounted-client dispatch to an already booted swarm leader",
);
assertIncludes(
	docs,
	"remove `/tmp/clanky-calendar-session.jsonl` and `/tmp/clanky-calendar-session.html` if created",
	"runbook manifest must include calendar export cleanup",
);
assertIncludes(docs, "pnpm clanky install --launchd --home ~/.clanky \\", "runbook must include launchd install");
assertIncludes(docs, "--print", "runbook must include a non-mutating launchd dry-run");
assertIncludes(docs, "After approval, enable it:", "runbook must separate approval from enable");
const runbookApprovalMarker = "After approval, enable it:";
const runbookApprovalMarkerIndex = docs.indexOf(runbookApprovalMarker);
if (runbookApprovalMarkerIndex === -1) {
	throw new Error("runbook must separate approval from enable");
}
const runbookLaunchdDryRunSection = docs.slice(0, runbookApprovalMarkerIndex);
assertIncludes(
	runbookLaunchdDryRunSection,
	"Dry-run the service file first without secret environment values",
	"runbook launchd dry-run must state that secret env values are excluded",
);
assertNotIncludes(
	runbookLaunchdDryRunSection,
	"--env-from-current LINEAR_API_KEY",
	"runbook launchd dry-run must not print Linear credentials",
);
assertIncludes(docs, "--enable", "runbook must document the approved enable command");
assertIncludes(docs, "For logout survival, log out and back in", "runbook must cover logout survival evidence");
assertIncludes(
	docs,
	"after logout/login, launchd still reports `com.clanky.daemon` loaded",
	"runbook must require launchd loaded evidence after logout",
);
assertIncludes(
	docs,
	"after logout/login, `pnpm clanky status --home ~/.clanky` reports `running: true`",
	"runbook must require daemon status evidence after logout",
);
assertIncludes(docs, 'export LINEAR_API_KEY="..."', "runbook token placeholder must be shell-safe");
assertNotIncludes(docs, "export LINEAR_API_KEY=<token>", "runbook must not use shell-redirection placeholders");
assertIncludes(docs, "pnpm clanky doctor --home ~/.clanky", "runbook Linear gate must start with doctor preflight");
assertIncludes(
	docs,
	"pnpm clanky cron run-now --home ~/.clanky <job-id>",
	"runbook Linear gate must include deterministic cron run-now",
);
assertIncludes(
	docs,
	"leave the job enabled through its next natural hourly fire",
	"runbook Linear gate must require natural scheduled execution",
);
assertIncludes(
	docs,
	"Linear receives the unattended scheduled comment",
	"runbook Linear gate must require unattended Linear evidence",
);
assertIncludes(docs, "pnpm clanky cron rm --home ~/.clanky <job-id>", "runbook Linear gate must include cron cleanup");
assertIncludes(docs, "com.clanky.daemon.work", "runbook must cover work profile launchd label");
assertIncludes(docs, "com.clanky.daemon.personal", "runbook must cover personal profile launchd label");
assertIncludes(
	docs,
	"pnpm clanky install --launchd --profile work --home ~/.clanky --enable",
	"runbook must include the approved work profile enable command",
);
assertIncludes(
	docs,
	"pnpm clanky install --launchd --profile personal --home ~/.clanky --enable",
	"runbook must include the approved personal profile enable command",
);
assertIncludes(
	docs,
	"pnpm clanky status --home ~/.clanky --profile work",
	"runbook must include work profile status verification",
);
assertIncludes(
	docs,
	"pnpm clanky status --home ~/.clanky --profile personal",
	"runbook must include personal profile status verification",
);
assertIncludes(
	docs,
	'pnpm clanky task add --home ~/.clanky --profile work "work profile daemon smoke"',
	"runbook must include work profile task isolation setup",
);
assertIncludes(
	docs,
	'pnpm clanky task add --home ~/.clanky --profile personal "personal profile daemon smoke"',
	"runbook must include personal profile task isolation setup",
);
assertIncludes(
	docs,
	"pnpm clanky uninstall --launchd --profile work --home ~/.clanky",
	"runbook must include work profile cleanup",
);
assertIncludes(
	docs,
	"pnpm clanky uninstall --launchd --profile personal --home ~/.clanky",
	"runbook must include personal profile cleanup",
);
assertIncludes(
	docs,
	"work task output appears only under the work profile",
	"runbook must require work task isolation",
);
assertIncludes(
	docs,
	"personal task output appears only under the personal profile",
	"runbook must require personal task isolation",
);
assertIncludes(docs, "public MCP tool as `swarm.dispatch`", "runbook must name the actual MCP tool");
assertIncludes(
	docs,
	"pnpm clanky status --home ~/.clanky",
	"runbook must include swarm-enabled daemon status verification",
);
assertIncludes(docs, "pnpm clanky swarm status --home ~/.clanky", "runbook must include swarm status verification");
assertIncludes(docs, "pnpm clanky swarm snapshot --home ~/.clanky", "runbook must include swarm snapshot verification");
assertIncludes(
	docs,
	'pnpm clanky swarm dispatch --home ~/.clanky --type implement --file README.md "real swarm live gate smoke"',
	"runbook must include direct CLI swarm dispatch verification",
);
assertIncludes(docs, "pnpm clanky swarm tasks --home ~/.clanky", "runbook must include direct swarm task verification");
assertIncludes(
	docs,
	"doctor reports `live_gate_swarm_mcp: ready_preflight` before the foreground daemon starts",
	"runbook must require swarm preflight before direct dispatch",
);
assertIncludes(
	docs,
	"`CLANKY_SWARM_COMMAND` must point at the Node binary compatible with the installed `swarm-mcp` native dependencies",
	"runbook must warn about Node/native-module compatibility for real swarm boot",
);
assertIncludes(
	docs,
	'CLANKY_SWARM_COMMAND="$' + '{CLANKY_NODE:-/Users/jamesvolpe/.n/bin/node}"',
	"runbook must default real swarm boot to the captured Node binary while allowing override",
);
assertNotIncludes(
	docs,
	"command -v node",
	"runbook must not depend on PATH node for real swarm/native-module live gates",
);
assertIncludes(
	docs,
	"MCP error -32000: Connection closed",
	"runbook must document the swarm child failure symptom for Node/native mismatches",
);
assertIncludes(docs, "`clanky status` reports `swarm_state: booted`", "runbook must require booted swarm status");
assertIncludes(
	docs,
	"`clanky swarm status` reports the herdr workspace handle",
	"runbook must require herdr workspace evidence",
);
assertIncludes(
	docs,
	"`clanky swarm snapshot` reports planner ownership for the gateway",
	"runbook must require planner ownership evidence",
);
assertIncludes(
	docs,
	"cleanup stops the foreground Clanky daemon with Ctrl-C or `pnpm clanky stop --home ~/.clanky`",
	"runbook must include swarm gate cleanup",
);
assertIncludes(
	docs,
	"shown as `clanky.swarm.dispatch` under a `clanky` mount",
	"runbook must explain Claude Code's mounted display form",
);
assertIncludes(
	docs,
	"pnpm clanky mcp config --home ~/.clanky",
	"runbook must include the non-mutating MCP config helper",
);
assertIncludes(docs, "`clanky mcp config` prints", "runbook must explain the MCP config helper");
assertIncludes(docs, '"mcpServers"', "runbook must include a Claude Code MCP config fragment");
assertIncludes(docs, '"clanky"', "runbook must include a clanky MCP server name");
assertIncludes(
	docs,
	'"args": ["--silent", "clanky", "mcp", "--home", "/Users/jamesvolpe/.clanky"]',
	"runbook must use parse-safe pnpm silent MCP args",
);
assertIncludes(docs, '"cwd": "/Users/jamesvolpe/clanky"', "runbook must pin the clanky repo cwd for pnpm");

const demo = await readFile("docs/demo.md", "utf8");
assertNoForbiddenPackageManagerCommands("docs/demo.md", demo);
assertIncludes(demo, "pnpm check", "demo script must include check");
assertIncludes(demo, "pnpm smoke", "demo script must include smoke");
assertIncludes(
	demo,
	'export CLANKY_DEMO_HOME="$(mktemp -d /tmp/clanky-demo.XXXXXX)"',
	"demo must use a throwaway home",
);
assertIncludes(demo, 'pnpm clanky start --home "$CLANKY_DEMO_HOME" --detach', "demo must start a temp daemon");
assertIncludes(
	demo,
	'pnpm --silent clanky doctor --home "$CLANKY_DEMO_HOME" --json',
	"demo must show silent JSON preflight",
);
assertIncludes(
	demo,
	'pnpm clanky mcp config --home "$CLANKY_DEMO_HOME"',
	"demo must include the non-mutating MCP config helper",
);
assertIncludes(
	demo,
	"MCP config prints a Claude Code-ready `mcpServers` fragment without editing client files",
	"demo must explain MCP config is non-mutating",
);
assertNotIncludes(
	demo,
	'pnpm clanky doctor --home "$CLANKY_DEMO_HOME" --json',
	"demo must not show parse-breaking pnpm JSON mode without --silent",
);
assertIncludes(demo, "stable JSON live-gate preflight keys", "demo must explain JSON preflight output");
assertIncludes(demo, 'pnpm clanky stop --home "$CLANKY_DEMO_HOME"', "demo must stop the temp daemon");
assertIncludes(demo, 'rm -rf "$CLANKY_DEMO_HOME"', "demo must clean the throwaway home");
assertIncludes(demo, "avoids launchd bootstrap", "demo must avoid live-gate service mutation");
assertIncludes(demo, "real swarm/herdr dispatch", "demo must keep real swarm dispatch out of the local demo");
assertIncludes(demo, "grouped `live_gates` JSON state", "demo must mention grouped doctor JSON live gates");
assertIncludes(
	demo,
	"grouped `live_gate_blockers` JSON state",
	"demo must mention grouped doctor JSON live gate blockers",
);
assertIncludes(demo, "docs/live-gates.md", "demo must point live gates to the approval-safe runbook");
assertIncludes(demo, "Record these only after the user approves", "demo must separate local demo from live gates");
assertIncludes(
	demo,
	"real swarm/herdr: start Clanky with real swarm enabled",
	"demo must split direct swarm recording from Claude Code mount recording",
);
assertIncludes(
	demo,
	"run direct `clanky swarm dispatch`",
	"demo must include direct swarm dispatch recording evidence",
);
assertIncludes(
	demo,
	"`clanky swarm tasks` shows the completed task",
	"demo must include direct swarm task terminal-state evidence",
);
assertIncludes(
	demo,
	"Claude Code MCP: after the swarm daemon is booted",
	"demo must sequence the MCP mount after swarm boot",
);
assertIncludes(
	demo,
	"run `pnpm clanky mcp config --home ~/.clanky`",
	"demo live-gate beats must include the MCP config helper",
);
assertIncludes(
	demo,
	"Linear mirroring or `tracker_update_skipped`",
	"demo must allow tracker skip evidence when Linear mirroring is not configured",
);
assertIncludes(demo, "dry-run without secret env values", "demo launchd dry-run must exclude secret env values");
assertNotIncludes(demo, "--env-from-current LINEAR_API_KEY", "demo launchd dry-run must not print Linear credentials");
assertIncludes(demo, "after explicit bootstrap approval", "demo must gate launchd enablement");
assertIncludes(demo, "log out and back in", "demo live-gate beats must include logout survival evidence");
assertIncludes(demo, "search/export the resulting session", "demo must include calendar session evidence export");
assertIncludes(demo, "public `swarm.dispatch`", "demo must name the actual public MCP dispatch tool");
assertIncludes(demo, "clanky swarm snapshot", "demo must include swarm snapshot evidence");
assertIncludes(demo, "then stop the daemon", "demo must include swarm gate cleanup");
assertIncludes(demo, "next natural hourly fire", "demo must include unattended Linear cron evidence");
assertIncludes(demo, "remove the cron job", "demo must include Linear cron cleanup");
assertIncludes(demo, "profile daemons", "demo must include profile daemon live-gate beats");
assertIncludes(demo, "clanky task list", "demo must include profile task isolation verification");
assertIncludes(
	demo,
	"shown as `clanky.swarm.dispatch` under a `clanky` mount",
	"demo must explain the mounted MCP display form",
);

const readme = await readFile("README.md", "utf8");
assertNoForbiddenPackageManagerCommands("README.md", readme);
assertIncludes(readme, "pnpm smoke", "README must include smoke entrypoint");
assertIncludes(readme, "pnpm clanky doctor --home ~/.clanky", "README must start live gates with doctor");
assertIncludes(
	readme,
	"pnpm --silent clanky doctor --home ~/.clanky --json",
	"README must document silent doctor JSON mode",
);
assertNotIncludes(
	readme,
	"pnpm clanky doctor --home ~/.clanky --json",
	"README must not document parse-breaking pnpm JSON mode without --silent",
);
assertIncludes(readme, "Use `--json` for automation", "README must describe doctor JSON output");
assertIncludes(readme, "use `pnpm --silent`", "README must explain why pnpm JSON mode uses --silent");
assertIncludes(readme, "stable `warnings` array", "README must document stable JSON warnings");
assertIncludes(readme, "`live_gates` object", "README must document grouped JSON live gates");
assertIncludes(readme, "`live_gate_blockers` object", "README must document grouped JSON live gate blockers");
assertIncludes(readme, "launchd_plist_path", "README must document split JSON path probe keys");
assertIncludes(
	readme,
	"profile_daemon_work_plist_path",
	"README must document split work profile daemon JSON path probe keys",
);
assertIncludes(
	readme,
	"profile_daemon_personal_plist_path",
	"README must document split personal profile daemon JSON path probe keys",
);
assertIncludes(readme, "--print", "README must show launchd dry-run before enablement");
assertIncludes(
	readme,
	"after explicit approval to bootstrap com.clanky.daemon",
	"README must gate default launchd bootstrap",
);
const readmeApprovalMarker = "# after explicit approval to bootstrap com.clanky.daemon";
const readmeApprovalMarkerIndex = readme.indexOf(readmeApprovalMarker);
if (readmeApprovalMarkerIndex === -1) {
	throw new Error("README must gate default launchd bootstrap");
}
const readmeLaunchdDryRunSection = readme.slice(0, readmeApprovalMarkerIndex);
assertIncludes(
	readmeLaunchdDryRunSection,
	"dry-run without secret env values",
	"README launchd dry-run must state that secret env values are excluded",
);
assertNotIncludes(
	readmeLaunchdDryRunSection,
	"--env-from-current LINEAR_API_KEY",
	"README launchd dry-run must not print Linear credentials",
);
assertIncludes(readme, "--enable", "README must document the approved launchd enable command");
assertIncludes(readme, "log out and back in", "README must include logout survival verification");
assertIncludes(readme, "See `docs/live-gates.md`", "README must link the approval-safe runbook");
assertIncludes(readme, "waiver format", "README must mention the live-gate waiver format");
assertIncludes(readme, "Add `--enable` only after explicitly approving", "README must gate managed service start");
assertIncludes(readme, "Avoid `--print` with secret environment values", "README must warn about secret dry-runs");
assertIncludes(
	readme,
	'pnpm clanky session search --home ~/.clanky "calendar"',
	"README must include model/calendar session search evidence",
);
assertIncludes(
	readme,
	"pnpm clanky session export --home ~/.clanky --html /tmp/clanky-calendar-session.html <session-id>",
	"README must include model/calendar HTML export evidence",
);
assertIncludes(
	readme,
	"leave the job enabled through its next natural hourly fire",
	"README must include unattended Linear cron evidence",
);
assertIncludes(readme, "pnpm clanky cron rm --home ~/.clanky <job-id>", "README must include Linear cron cleanup");
assertIncludes(readme, "mcpServers.clanky", "README must document the Claude Code MCP mount key");
assertIncludes(
	readme,
	"pnpm clanky mcp config --home ~/.clanky",
	"README must include the non-mutating MCP config helper",
);
assertIncludes(readme, "`clanky mcp config --home <path>` prints", "README must explain the MCP config helper");
assertIncludes(
	readme,
	'["--silent", "clanky", "mcp", "--home", "/Users/jamesvolpe/.clanky"]',
	"README must document parse-safe pnpm silent MCP args",
);
assertIncludes(
	readme,
	"machine-service approval, real credentials/tooling, or persisted/default swarm service env",
	"README must accurately describe the split live-gate blockers",
);
assertIncludes(
	readme,
	"Live evidence has also verified the direct real `swarm_mcp` gate against `~/.clanky`",
	"README must record the completed direct swarm live gate",
);
assertIncludes(readme, "pnpm clanky swarm status --home ~/.clanky", "README must include swarm status evidence");
assertIncludes(readme, "pnpm clanky swarm snapshot --home ~/.clanky", "README must include swarm snapshot evidence");
assertIncludes(
	readme,
	"direct real swarm/herdr gate; already captured, rerun only when revalidating",
	"README must separate direct swarm live gate from Claude Code mount",
);
assertIncludes(
	readme,
	'export CLANKY_NODE="$' + '{CLANKY_NODE:-/Users/jamesvolpe/.n/bin/node}"',
	"README must default live swarm examples to the captured Node binary while allowing override",
);
assertIncludes(
	readme,
	"captured real-swarm evidence used `CLANKY_SWARM_COMMAND=/Users/jamesvolpe/.n/bin/node`",
	"README must explain the Node/native-module compatibility requirement",
);
assertNotIncludes(
	readme,
	"command -v node",
	"README live-gate examples must not depend on PATH node for real swarm/native-module gates",
);
assertIncludes(
	readme,
	'pnpm clanky swarm dispatch --home ~/.clanky --type implement --file README.md "real swarm live gate smoke"',
	"README must include direct swarm dispatch evidence",
);
assertIncludes(readme, "pnpm clanky swarm tasks --home ~/.clanky", "README must include direct swarm task evidence");
assertIncludes(
	readme,
	"Claude Code MCP mounted-client gate; already captured, rerun only when revalidating",
	"README must mark the mounted-client gate as captured revalidation evidence",
);
assertIncludes(readme, "pnpm clanky stop --home ~/.clanky", "README must include swarm gate cleanup");
assertIncludes(
	readme,
	"profile-daemon isolation after explicit bootstrap approval, using one home with separate profiles",
	"README must describe the profile-daemon gate as same-home profile isolation",
);
assertIncludes(
	readme,
	"pnpm clanky install --launchd --profile work --home ~/.clanky --enable",
	"README must include work profile daemon enable command",
);
assertIncludes(
	readme,
	'pnpm clanky task add --home ~/.clanky --profile personal "personal profile daemon smoke"',
	"README must include personal profile task isolation setup",
);
assertIncludes(
	readme,
	"pnpm clanky uninstall --launchd --profile personal --home ~/.clanky",
	"README must include personal profile daemon cleanup",
);
assertIncludes(readme, "tracker_update_skipped", "README must document model-facing tracker skip alias");
assertIncludes(readme, "source_session_id", "README must document public MCP session fork alias");
assertIncludes(readme, "cron `job_id`", "README must document public MCP cron job id alias");
assertIncludes(readme, "swarm file-lock `path`", "README must document public MCP swarm file-lock alias");
assertIncludes(
	readme,
	"public Clanky MCP and HTTP swarm status/peers/tasks/snapshot/message/dispatch/complete/file-lock",
	"README must document the public swarm coverage surface",
);
assertIncludes(readme, "`HERDR_SOCKET_PATH` wins", "README must document canonical herdr socket precedence");

const audit = await readFile("docs/v1-audit.md", "utf8");
assertIncludes(audit, "## Success Criteria Audit", "audit must keep the plan success criteria section");
assertIncludes(audit, "## Phased Roadmap Audit", "audit must keep the phased roadmap crosswalk");
for (const phase of [
	"Phase 0 scaffolding",
	"Phase 1 daemon + RPC TUI",
	"Phase 2 gateway HTTP + MCP",
	"Phase 3 cron",
	"Phase 4 skills",
	"Phase 5 swarm leader",
	"Phase 6 dashboard TUI",
	"Phase 7 install scripts + docs",
]) {
	assertIncludes(audit, phase, `audit must map ${phase} to concrete evidence`);
}
assertIncludes(
	audit,
	"Claude Code client mounting and mounted-client dispatch evidence are captured",
	"audit must mark Phase 2 mounted-client evidence captured",
);
assertIncludes(audit, "real Linear mirroring remains a live gate", "audit must keep Phase 5 Linear gate unclaimed");
assertIncludes(
	audit,
	"actual launchd bootstrap remains approval-gated",
	"audit must keep Phase 7 launchd gate unclaimed",
);
assertIncludes(
	audit,
	"## Decision And Risk Mitigation Audit",
	"audit must keep the plan decisions and risks crosswalk",
);
assertIncludes(
	audit,
	"Open decision: published Pi packages instead of a fork/submodule",
	"audit must map the Pi packaging decision to evidence",
);
assertIncludes(
	audit,
	"Risk mitigation: Pi RPC protocol drift",
	"audit must map the Pi RPC drift mitigation to evidence",
);
assertIncludes(
	audit,
	"Risk mitigation: `swarm-mcp` tool surface drift",
	"audit must map the swarm-mcp drift mitigation to evidence",
);
assertIncludes(audit, "direct real-swarm live-gate evidence", "audit must record direct real-swarm live evidence");
assertIncludes(
	audit,
	"Current completion status: local implementation and smoke coverage are broad, direct `swarm_mcp` live evidence and mounted Claude Code MCP dispatch evidence are recorded",
	"audit current status must distinguish completed direct swarm evidence",
);
assertIncludes(audit, "Chronological verification log", "audit must label older evidence as chronological history");
assertIncludes(
	audit,
	"Risk mitigation: single-process bottleneck",
	"audit must map the single-process bottleneck mitigation to evidence",
);
assertIncludes(audit, "Risk mitigation: token security", "audit must map token security to evidence");
assertIncludes(audit, "What we reuse from Pi", "audit must map the Pi reuse section to evidence");
assertIncludes(
	audit,
	"What we reuse from `swarm-mcp` and Claude Code skills",
	"audit must map the swarm and skills reuse section to evidence",
);
assertIncludes(audit, "Plan success criterion", "audit must map plan criteria to evidence");
assertIncludes(audit, "`clanky start` runs as a launchd agent", "audit must cover the launchd success criterion");
assertIncludes(audit, '`clanky send "what\'s on the calendar"`', "audit must cover the model/calendar criterion");
assertIncludes(audit, "Cron job posts unattended Linear summary", "audit must cover the Linear cron criterion");
assertIncludes(audit, "Claude Code MCP `clanky.swarm.dispatch`", "audit must cover the Claude Code MCP criterion");
assertIncludes(
	audit,
	"mounted-client display form for Clanky's public MCP tool `swarm.dispatch`",
	"audit must map the plan wording to the actual MCP tool name",
);
assertIncludes(
	audit,
	"Public Clanky MCP swarm status, peers, tasks, snapshot, direct peer message",
	"audit must keep public MCP swarm evidence aligned with smoke:mcp-swarm coverage",
);
assertIncludes(audit, "exact 33-tool surface", "audit must keep public MCP tool-count evidence aligned with smoke:mcp");
assertIncludes(
	audit,
	"persisted stdout-delivery output files",
	"audit must keep MCP cron.run_now output persistence evidence",
);
assertIncludes(audit, "skill add/list/remove/usage", "audit must keep MCP skill usage evidence");
assertIncludes(audit, "Linear create/link/list/outbox/flush tools", "audit must keep MCP Linear outbox evidence");
assertIncludes(
	audit,
	"HTTP swarm status, peers, tasks, snapshot, direct peer message",
	"audit must keep HTTP swarm evidence aligned with smoke:http-swarm coverage",
);
assertIncludes(
	audit,
	"in-process interval execution after startup",
	"audit must keep cron interval-timer evidence aligned with smoke:cron coverage",
);
assertIncludes(
	audit,
	"scheduler-level `stdout`, `file`, and `swarm:<peer>` delivery",
	"audit must keep cron delivery evidence aligned with smoke:cron coverage",
);
assertIncludes(
	audit,
	"cron add/list/disable/enable/run-now/remove",
	"audit must keep user-facing CLI cron run-now evidence aligned with smoke:cli-gateway coverage",
);
assertIncludes(audit, "active `.profile` status resolution", "audit must keep active profile CLI evidence");
assertIncludes(
	audit,
	"missing-socket `EINVAL` offline status handling",
	"audit must keep missing profile socket offline status evidence",
);
assertIncludes(
	audit,
	"persisted stdout-delivery output metadata",
	"audit must keep CLI cron run-now output persistence evidence",
);
assertIncludes(audit, "Two profiles cannot see each other's tasks or sessions", "audit must cover profile isolation");
assertIncludes(audit, "Killing daemon mid-task does not corrupt JSONL/SQLite", "audit must cover crash recovery");
assertIncludes(audit, "`smoke:swarm-restart`", "audit must pin checked-in swarm restart coverage");
assertIncludes(
	audit,
	'duplicate dispatch returns the same task with `dispatchStatus: "done"`',
	"audit must describe swarm restart idempotency evidence",
);
assertIncludes(audit, "Remaining live gate", "audit must keep explicit remaining-gate column");
assertIncludes(audit, "Actual `clanky install --launchd --enable`", "audit must keep launchd gate unclaimed");
assertIncludes(
	audit,
	"Real Pi model credentials plus calendar tooling",
	"audit must keep model/calendar gate unclaimed",
);
assertIncludes(audit, "Real `LINEAR_API_KEY` or `LINEAR_ACCESS_TOKEN`", "audit must keep Linear gate unclaimed");
assertIncludes(
	audit,
	"Real Linear credentials for live completion mirroring",
	"audit must keep real Linear mirroring unclaimed after mounted-client dispatch evidence",
);
assertIncludes(
	audit,
	"remaining unrun gates are run or explicitly waived: launchd restart/logout survival, model/calendar credentials and answer, unattended real Linear cron delivery, and launchd-managed profile daemons.",
	"audit must separate default disabled swarm env from remaining unrun gates",
);
assertIncludes(
	audit,
	"Latest continuation command evidence: full `pnpm smoke`, `pnpm smoke:live-gates`, `pnpm smoke:cron-session`, `pnpm check`, `pnpm audit --prod`, non-mutating `pnpm --silent clanky doctor --home ~/.clanky --json`, and `pnpm clanky status --home ~/.clanky` passed",
	"audit must record the latest non-mutating continuation evidence",
);
assertIncludes(
	audit,
	"Fresh doctor JSON now reports `claude_code_mcp_mount: mounted`",
	"audit must record the current Claude Code mount state",
);
const latestPreflightStart = audit.indexOf("Latest local preflight:");
const latestPreflightEnd = audit.indexOf("- Earlier temporary real `swarm-mcp` boot preflight", latestPreflightStart);
if (latestPreflightStart === -1 || latestPreflightEnd === -1 || latestPreflightEnd <= latestPreflightStart) {
	throw new Error("audit must keep a bounded latest local preflight block before historical swarm preflights");
}
const latestPreflight = audit.slice(latestPreflightStart, latestPreflightEnd);
assertIncludes(
	latestPreflight,
	"claude_code_mcp_mount: mounted",
	"latest audit preflight must match current Claude Code MCP mount state",
);
assertIncludes(
	latestPreflight,
	"claude_code_mcp_servers: clanky",
	"latest audit preflight must name the mounted Clanky MCP server",
);
assertNotIncludes(
	latestPreflight,
	"claude_code_mcp_mount: missing",
	"latest audit preflight must not report the stale missing Claude Code MCP state",
);
assertIncludes(
	audit,
	"current runbook and README use the captured working Node path `/Users/jamesvolpe/.n/bin/node`",
	"audit must document the current Node/native-module-compatible swarm command",
);
assertIncludes(audit, "full `pnpm smoke` passed end-to-end", "audit must record latest full smoke evidence");
assertIncludes(audit, "Do not mark v1 complete", "audit must warn against premature completion");

const homeDir = await mkdtemp(join(tmpdir(), "clanky-live-gates-"));
const claudeHomeDir = await mkdtemp(join(tmpdir(), "clanky-live-gates-claude-"));
const doctor = await runClanky(["doctor", "--home", homeDir], {
	HOME: claudeHomeDir,
	CLANKY_MCP_SERVERS_JSON: "",
	HERDR_PANE_ID: "",
	HERDR_SOCKET: "",
	HERDR_SOCKET_PATH: "",
});
assertCommandSucceeded("doctor", doctor);
assertIncludes(doctor.stdout, "launchd_label: com.clanky.daemon", "doctor should print default launchd label");
assertIncludes(doctor.stdout, "launchd_plist: ", "doctor should print default launchd plist path");
assertIncludes(doctor.stdout, "model_credentials: missing", "doctor should expose missing model gate");
assertIncludes(doctor.stdout, "calendar_tooling: missing", "doctor should expose missing calendar tooling gate");
assertIncludes(doctor.stdout, "linear_credentials: missing", "doctor should expose missing Linear gate");
assertIncludes(doctor.stdout, "swarm_args_json: missing", "doctor should expose missing swarm args config");
assertIncludes(doctor.stdout, "live_gate_launchd_restart: ", "doctor should summarize launchd gate");
assertIncludes(
	doctor.stdout,
	"live_gate_model_calendar: blocked_model_credentials",
	"doctor should summarize model/calendar gate",
);
assertIncludes(doctor.stdout, "live_gate_linear_cron: blocked_credentials", "doctor should summarize Linear gate");
assertIncludes(doctor.stdout, "live_gate_swarm_mcp: disabled", "doctor should summarize swarm gate");
assertIncludes(
	doctor.stdout,
	"live_gate_claude_code_mcp: requires_client_mount",
	"doctor should summarize client-mount gate",
);
assertIncludes(doctor.stdout, "claude_code_mcp_mount: missing", "doctor should expose missing client mount");
assertIncludes(doctor.stdout, "herdr_socket_file: missing", "doctor should expose missing herdr socket path state");
assertIncludes(doctor.stdout, "herdr_context: missing_pane", "doctor should expose missing herdr pane context");
assertIncludes(doctor.stdout, "profile_daemon_work: ", "doctor should expose work profile service state");
assertIncludes(doctor.stdout, "profile_daemon_work_label: com.clanky.daemon.work", "doctor should expose work label");
assertIncludes(doctor.stdout, "profile_daemon_work_plist: ", "doctor should expose work profile plist state");
assertIncludes(doctor.stdout, "profile_daemon_personal: ", "doctor should expose personal profile service state");
assertIncludes(
	doctor.stdout,
	"profile_daemon_personal_label: com.clanky.daemon.personal",
	"doctor should expose personal label",
);
assertIncludes(doctor.stdout, "profile_daemon_personal_plist: ", "doctor should expose personal profile plist state");

const doctorJson = await runClanky(["doctor", "--home", homeDir, "--json"], {
	HOME: claudeHomeDir,
	CLANKY_MCP_SERVERS_JSON: "",
	HERDR_PANE_ID: "",
	HERDR_SOCKET: "",
	HERDR_SOCKET_PATH: "",
});
assertCommandSucceeded("doctor json", doctorJson);
const parsedDoctorJson = parseJsonObject(doctorJson.stdout);
assertJsonString(parsedDoctorJson, "launchd_plist_state", "missing");
assertJsonString(parsedDoctorJson, "profile_daemon_work_label", "com.clanky.daemon.work");
assertJsonString(parsedDoctorJson, "profile_daemon_work_plist_state", "missing");
assertJsonString(parsedDoctorJson, "profile_daemon_personal_label", "com.clanky.daemon.personal");
assertJsonString(parsedDoctorJson, "profile_daemon_personal_plist_state", "missing");
assertJsonString(parsedDoctorJson, "swarm_mcp_dist_path", "/Users/jamesvolpe/web/swarm-mcp/dist/index.js");
assertJsonStringArray(parsedDoctorJson, "warnings", [
	"no configured Pi model credentials; model-backed send and cron live gates will fail",
]);
assertJsonString(parsedDoctorJson, "live_gate_model_calendar", "blocked_model_credentials");
assertJsonString(parsedDoctorJson, "live_gate_linear_cron", "blocked_credentials");
assertJsonString(parsedDoctorJson, "live_gate_swarm_mcp", "disabled");
assertJsonString(parsedDoctorJson, "live_gate_claude_code_mcp", "requires_client_mount");
assertLiveGateJsonPair(parsedDoctorJson, "launchd_restart", "live_gate_launchd_restart");
assertLiveGateJsonPair(parsedDoctorJson, "model_calendar", "live_gate_model_calendar");
assertLiveGateJsonPair(parsedDoctorJson, "linear_cron", "live_gate_linear_cron");
assertLiveGateJsonPair(parsedDoctorJson, "swarm_mcp", "live_gate_swarm_mcp");
assertLiveGateJsonPair(parsedDoctorJson, "claude_code_mcp", "live_gate_claude_code_mcp");
assertLiveGateJsonPair(parsedDoctorJson, "profile_daemons", "live_gate_profile_daemons");
assertJsonObjectString(parsedDoctorJson, "live_gate_blockers", "model_calendar", "blocked_model_credentials");
assertJsonObjectString(parsedDoctorJson, "live_gate_blockers", "linear_cron", "blocked_credentials");
assertJsonObjectString(parsedDoctorJson, "live_gate_blockers", "swarm_mcp", "disabled");
assertJsonObjectString(parsedDoctorJson, "live_gate_blockers", "claude_code_mcp", "requires_client_mount");
assertJsonString(parsedDoctorJson, "herdr_context", "missing_pane");

const mcpConfig = await runClanky(["mcp", "config", "--home", homeDir], { HOME: claudeHomeDir });
assertCommandSucceeded("mcp config", mcpConfig);
const parsedMcpConfig = parseJsonObject(mcpConfig.stdout);
const mcpServers = parsedMcpConfig.mcpServers;
if (typeof mcpServers !== "object" || mcpServers === null || Array.isArray(mcpServers)) {
	throw new Error(`MCP config must include mcpServers object: ${mcpConfig.stdout}`);
}
const clankyMcpServer = (mcpServers as Record<string, unknown>).clanky;
if (typeof clankyMcpServer !== "object" || clankyMcpServer === null || Array.isArray(clankyMcpServer)) {
	throw new Error(`MCP config must include mcpServers.clanky object: ${mcpConfig.stdout}`);
}
const clankyMcpServerRecord = clankyMcpServer as Record<string, unknown>;
if (clankyMcpServerRecord.command !== "pnpm") {
	throw new Error(`MCP config must use pnpm command: ${mcpConfig.stdout}`);
}
if (clankyMcpServerRecord.cwd !== "/Users/jamesvolpe/clanky") {
	throw new Error(`MCP config must use the Clanky repo cwd: ${mcpConfig.stdout}`);
}
const clankyMcpArgs = clankyMcpServerRecord.args;
if (
	!Array.isArray(clankyMcpArgs) ||
	JSON.stringify(clankyMcpArgs) !== JSON.stringify(["--silent", "clanky", "mcp", "--home", homeDir])
) {
	throw new Error(`MCP config must use parse-safe pnpm silent args: ${mcpConfig.stdout}`);
}

const claudeConfigDir = join(claudeHomeDir, ".claude");
await mkdir(claudeConfigDir, { recursive: true });
await writeFile(join(claudeConfigDir, ".claude.json"), JSON.stringify(parsedMcpConfig, null, "\t"));
const mountedDoctorJson = await runClanky(["doctor", "--home", homeDir, "--json"], {
	HOME: claudeHomeDir,
	CLANKY_MCP_SERVERS_JSON: "",
	HERDR_PANE_ID: "",
	HERDR_SOCKET: "",
	HERDR_SOCKET_PATH: "",
});
assertCommandSucceeded("doctor json with documented Claude Code MCP mount", mountedDoctorJson);
const parsedMountedDoctorJson = parseJsonObject(mountedDoctorJson.stdout);
assertJsonString(parsedMountedDoctorJson, "claude_code_mcp_mount", "mounted");
assertJsonString(parsedMountedDoctorJson, "claude_code_mcp_servers", "clanky");
assertJsonString(parsedMountedDoctorJson, "live_gate_claude_code_mcp", "mounted");
assertLiveGateJsonPair(parsedMountedDoctorJson, "claude_code_mcp", "live_gate_claude_code_mcp");
assertJsonObjectMissing(parsedMountedDoctorJson, "live_gate_blockers", "claude_code_mcp");

const silentDoctorJson = await runPnpmSilentClanky(["doctor", "--home", homeDir, "--json"], {
	HOME: claudeHomeDir,
	CLANKY_MCP_SERVERS_JSON: "",
	HERDR_PANE_ID: "",
	HERDR_SOCKET: "",
	HERDR_SOCKET_PATH: "",
});
assertCommandSucceeded("pnpm --silent doctor json", silentDoctorJson);
const parsedSilentDoctorJson = parseJsonObject(silentDoctorJson.stdout);
assertJsonString(parsedSilentDoctorJson, "live_gate_swarm_mcp", "disabled");
assertLiveGateJsonPair(parsedSilentDoctorJson, "swarm_mcp", "live_gate_swarm_mcp");
assertJsonObjectString(parsedSilentDoctorJson, "live_gate_blockers", "swarm_mcp", "disabled");
assertJsonStringArray(parsedSilentDoctorJson, "warnings", [
	"no configured Pi model credentials; model-backed send and cron live gates will fail",
]);
assertNotIncludes(silentDoctorJson.stdout, "> clanky@", "pnpm --silent doctor JSON must not include script banners");

const launchd = await runClanky([
	"install",
	"--launchd",
	"--home",
	homeDir,
	"--env",
	"CLANKY_SWARM_ENABLED=1",
	"--env",
	`CLANKY_SWARM_COMMAND=${process.execPath}`,
	"--env",
	'CLANKY_SWARM_ARGS_JSON=["/Users/jamesvolpe/web/swarm-mcp/dist/index.js"]',
	"--print",
]);
assertCommandSucceeded("launchd dry-run", launchd);
assertIncludes(launchd.stdout, "<string>com.clanky.daemon</string>", "default launchd label should render");
assertIncludes(launchd.stdout, `<string>${homeDir}</string>`, "default launchd dry-run should include home");
assertIncludes(launchd.stdout, "<key>CLANKY_SWARM_ENABLED</key>", "default launchd dry-run should include swarm env");
assertIncludes(launchd.stdout, `<string>${process.execPath}</string>`, "launchd dry-run should use absolute node path");
assertIncludes(launchd.stdout, "<key>RunAtLoad</key>", "launchd dry-run should run at load");
assertIncludes(launchd.stdout, "<key>KeepAlive</key>", "launchd dry-run should include restart settings");
assertNotIncludes(launchd.stdout, "launchctl bootstrap", "dry-run plist should not bootstrap launchd");
assertNoLiveGateCredentialEnv(launchd.stdout, "approval-safe launchd dry-run");

const workHome = await mkdtemp(join(tmpdir(), "clanky-live-gates-work-"));
const workLaunchd = await runClanky(["install", "--launchd", "--profile", "work", "--home", workHome, "--print"]);
assertCommandSucceeded("work launchd dry-run", workLaunchd);
assertIncludes(workLaunchd.stdout, "<string>com.clanky.daemon.work</string>", "work launchd label should render");
assertIncludes(workLaunchd.stdout, "<key>CLANKY_PROFILE</key>", "work launchd dry-run should include profile env");
assertIncludes(workLaunchd.stdout, "<string>work</string>", "work launchd dry-run should include profile value");
assertIncludes(workLaunchd.stdout, `<string>${workHome}</string>`, "work launchd dry-run should include isolated home");
assertNoLiveGateCredentialEnv(workLaunchd.stdout, "work launchd dry-run");

const personalHome = await mkdtemp(join(tmpdir(), "clanky-live-gates-personal-"));
const personalLaunchd = await runClanky([
	"install",
	"--launchd",
	"--profile",
	"personal",
	"--home",
	personalHome,
	"--print",
]);
assertCommandSucceeded("personal launchd dry-run", personalLaunchd);
assertIncludes(
	personalLaunchd.stdout,
	"<string>com.clanky.daemon.personal</string>",
	"personal launchd label should render",
);
assertIncludes(
	personalLaunchd.stdout,
	"<key>CLANKY_PROFILE</key>",
	"personal launchd dry-run should include profile env",
);
assertIncludes(
	personalLaunchd.stdout,
	"<string>personal</string>",
	"personal launchd dry-run should include profile value",
);
assertIncludes(
	personalLaunchd.stdout,
	`<string>${personalHome}</string>`,
	"personal launchd dry-run should include isolated home",
);
assertNoLiveGateCredentialEnv(personalLaunchd.stdout, "personal launchd dry-run");

console.log(
	JSON.stringify({
		auditBytes: audit.length,
		demoBytes: demo.length,
		readmeBytes: readme.length,
		doctorBytes: doctor.stdout.length,
		doctorJsonBytes: doctorJson.stdout.length,
		mcpConfigBytes: mcpConfig.stdout.length,
		silentDoctorJsonBytes: silentDoctorJson.stdout.length,
		launchdBytes: launchd.stdout.length,
		workBytes: workLaunchd.stdout.length,
		personalBytes: personalLaunchd.stdout.length,
	}),
);
await Promise.all(
	[homeDir, claudeHomeDir, workHome, personalHome].map((dir) => rm(dir, { force: true, recursive: true })),
);

interface CommandResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

async function runClanky(args: string[], env: Record<string, string> = {}): Promise<CommandResult> {
	const child = spawn(process.execPath, ["--import", "tsx", "packages/clanky-cli/src/bin.ts", ...args], {
		cwd: process.cwd(),
		env: { ...process.env, ...env },
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
	const code = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	return { code, stdout, stderr };
}

async function runPnpmSilentClanky(args: string[], env: Record<string, string> = {}): Promise<CommandResult> {
	const child = spawn("pnpm", ["--silent", "clanky", ...args], {
		cwd: process.cwd(),
		env: { ...process.env, ...env },
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
	const code = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	return { code, stdout, stderr };
}

function assertIncludes(value: string, expected: string, message: string): void {
	if (!value.includes(expected)) throw new Error(`${message}: missing ${expected}\nActual:\n${value}`);
}

function assertNotIncludes(value: string, unexpected: string, message: string): void {
	if (value.includes(unexpected)) throw new Error(`${message}: found ${unexpected}\nActual:\n${value}`);
}

function assertNoLiveGateCredentialEnv(value: string, label: string): void {
	for (const key of ["LINEAR_API_KEY", "LINEAR_ACCESS_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
		assertNotIncludes(value, key, `${label} should not print live-gate credential env names`);
	}
}

function assertNoForbiddenPackageManagerCommands(path: string, content: string): void {
	const forbiddenCommandPattern =
		/(?:^|\s)(?:npm|npx|bun)\s+(?:install|i|run|exec|x|test|build|start|clanky|tsx|node)\b/;
	const match = content.match(forbiddenCommandPattern);
	if (match !== null) throw new Error(`${path} must document pnpm commands only; found ${match[0].trim()}`);
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
	const record = object as Record<string, unknown>;
	if (field in record) {
		throw new Error(`Expected JSON ${key}.${field} to be absent, got ${JSON.stringify(record[field])}`);
	}
}
