import { spawn } from "node:child_process";
import type { SandboxedInvocation } from "./seatbelt.ts";

export const DEFAULT_TIMEOUT_MS = 20_000;
export const MAX_TIMEOUT_MS = 120_000;
const MAX_STDOUT_CHARS = 100_000;
const MAX_STDERR_CHARS = 20_000;
const KILL_GRACE_MS = 2_000;

export interface HostCommandRunResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	timedOut: boolean;
	durationMs: number;
}

interface CappedBuffer {
	text: string;
	truncated: boolean;
}

function appendCapped(buffer: CappedBuffer, chunk: string, cap: number): void {
	if (buffer.truncated) return;
	const remaining = cap - buffer.text.length;
	if (chunk.length <= remaining) {
		buffer.text += chunk;
		return;
	}
	buffer.text += chunk.slice(0, remaining);
	buffer.truncated = true;
}

export function runSandboxedCommand(
	invocation: SandboxedInvocation,
	options: { cwd: string; timeoutMs: number },
): Promise<HostCommandRunResult> {
	const [program, ...args] = invocation.argv;
	if (program === undefined) throw new Error("host command invocation has no program");
	const startedAt = Date.now();
	return new Promise((resolve, reject) => {
		const child = spawn(program, args, {
			cwd: options.cwd,
			env: invocation.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout: CappedBuffer = { text: "", truncated: false };
		const stderr: CappedBuffer = { text: "", truncated: false };
		let timedOut = false;
		let settled = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
		}, options.timeoutMs);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => appendCapped(stdout, chunk, MAX_STDOUT_CHARS));
		child.stderr.on("data", (chunk: string) => appendCapped(stderr, chunk, MAX_STDERR_CHARS));
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve({
				exitCode: code,
				stdout: stdout.text,
				stderr: stderr.text,
				stdoutTruncated: stdout.truncated,
				stderrTruncated: stderr.truncated,
				timedOut,
				durationMs: Date.now() - startedAt,
			});
		});
	});
}
