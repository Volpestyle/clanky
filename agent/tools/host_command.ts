import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { gated } from "../lib/approvals.ts";
import { classifyCommand } from "../lib/host-command/classify.ts";
import { isOwnerDrivenTurn, resolveApprovalMode } from "../lib/host-command/mode.ts";
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, runSandboxedCommand } from "../lib/host-command/run.ts";
import type { SandboxLevel, SandboxSpec } from "../lib/host-command/seatbelt.ts";
import { SANDBOX_EXEC_PATH, buildSandboxedInvocation } from "../lib/host-command/seatbelt.ts";

export const HOST_COMMAND_ROOT_ENV = "CLANKY_HOST_COMMAND_ROOT";

const inputSchema = z.object({
	command: z.string().min(1).describe("Shell script to run (bash -c). Compose freely: pipes, && chains, rg/jq/gh."),
	cwd: z
		.string()
		.optional()
		.describe("Absolute host directory to run in. Defaults to the repos root (~/dev)."),
	timeoutMs: z.number().int().min(1_000).max(MAX_TIMEOUT_MS).optional(),
	escalation: z
		.object({
			write: z.boolean().optional().describe("Request filesystem writes scoped to cwd and /tmp."),
			network: z.boolean().optional().describe("Request network egress beyond the per-CLI grants."),
			justification: z.string().min(1).describe("User-facing reason for the escalated run."),
		})
		.optional()
		.describe("On-request escalation; surfaces to the owner for approval. Omit for normal reads."),
});

type HostCommandInput = z.infer<typeof inputSchema>;

function resolveCwd(requested: string | undefined): string {
	const fallback = process.env[HOST_COMMAND_ROOT_ENV]?.trim() || resolve(homedir(), "dev");
	const cwd = requested === undefined || requested.trim().length === 0 ? fallback : requested.trim();
	const expanded = cwd === "~" || cwd.startsWith("~/") ? resolve(homedir(), cwd.slice(2)) : cwd;
	if (!isAbsolute(expanded)) throw new Error(`host_command cwd must be absolute, got: ${cwd}`);
	if (!existsSync(expanded) || !statSync(expanded).isDirectory()) {
		throw new Error(`host_command cwd is not a directory on the host: ${expanded}`);
	}
	return expanded;
}

export default defineTool({
	// Approval ladder (ADR-0003): read-only mode prompts only for escalations
	// and registry "ask" commands (e.g. mutating gh calls); auto and yolo modes
	// never prompt — their safety comes from the sandbox level chosen in
	// execute, and yolo is additionally clamped to owner-driven turns there.
	needsApproval: gated((ctx) => {
		if (resolveApprovalMode() !== "read-only") return false;
		const input = ctx.toolInput as HostCommandInput | undefined;
		if (input?.escalation !== undefined) return true;
		return classifyCommand(input?.command ?? "").verdict === "ask";
	}),
	description:
		"Run a shell command on the host Mac inside an OS-enforced Seatbelt sandbox: full-disk read (credential files excluded), no writes, network only for trusted CLIs like gh reads. This is your quick context lane for host code and version-control state (rg, cat, ls, find, jq, gh pr view/diff) — load the host-command skill for discipline and incantations. Scripts too complex to classify still run, sandboxed and offline. Need writes or extra network? Re-invoke with escalation{write|network, justification} to ask the owner. Substantial or watchable work (builds, tests, landing branches) belongs in a herdr_spawn pane instead.",
	inputSchema,
	async execute(input, ctx) {
		if (process.platform !== "darwin" || !existsSync(SANDBOX_EXEC_PATH)) {
			throw new Error("host_command requires macOS Seatbelt (/usr/bin/sandbox-exec); it is unavailable here.");
		}
		const mode = resolveApprovalMode();
		const ownerTurn = isOwnerDrivenTurn(ctx.session.auth);
		const clamped = mode === "yolo" && !ownerTurn;
		const effectiveMode = clamped ? "read-only" : mode;
		const classification = classifyCommand(input.command);
		if (classification.verdict === "deny") {
			throw new Error(`host_command refused: ${classification.reason}`);
		}
		if (clamped && (input.escalation !== undefined || classification.verdict === "ask")) {
			throw new Error(
				"yolo approval mode applies only to owner-driven turns; this turn is clamped to the gated read-only policy. Run the command without escalation, or let the owner run it.",
			);
		}
		let level: SandboxLevel = "read-only";
		let network = classification.network;
		if (effectiveMode === "yolo") {
			level = "danger-full-access";
			network = true;
		} else if (effectiveMode === "auto") {
			level = "workspace-write";
			network = network || input.escalation?.network === true;
		} else {
			if (input.escalation?.write === true) level = "workspace-write";
			network = network || input.escalation?.network === true;
		}
		const cwd = resolveCwd(input.cwd);
		const spec: SandboxSpec = { level, network, cwd };
		const invocation = buildSandboxedInvocation(spec, input.command);
		const result = await runSandboxedCommand(invocation, {
			cwd,
			timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		});
		return {
			...result,
			sandbox: { level, network, cwd, approvalMode: mode, ownerTurn, clamped },
		};
	},
	toModelOutput(output) {
		const lines: string[] = [];
		const status = output.timedOut ? "timed out" : `exit ${output.exitCode ?? "unknown"}`;
		const net = output.sandbox.network ? "network on" : "network off";
		lines.push(`[${status} · ${output.sandbox.level} · ${net} · cwd ${output.sandbox.cwd}]`);
		if (output.sandbox.clamped) lines.push("[yolo clamped to read-only: non-owner turn]");
		if (output.stdout.length > 0) {
			lines.push(output.stdoutTruncated ? `${output.stdout}\n[stdout truncated]` : output.stdout);
		}
		if (output.stderr.length > 0) {
			lines.push(output.stderrTruncated ? `stderr: ${output.stderr}\n[stderr truncated]` : `stderr: ${output.stderr}`);
		}
		if (output.exitCode !== 0 && !output.sandbox.network) {
			lines.push(
				"[network was disabled for this run; if the command needs egress, use a trusted CLI form (e.g. plain gh reads) or escalation.network]",
			);
		}
		return { type: "text", value: lines.join("\n") };
	},
});
