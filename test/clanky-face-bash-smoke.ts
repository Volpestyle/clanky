/**
 * Smoke test for the inline `!` shell escape helpers: the host command runner
 * (stdout/stderr capture, exit codes, output cap, timeout, spawn-error, cancel)
 * and the result renderer (header, output, exit/duration footer, notes).
 */
import type { ChildProcess } from "node:child_process";
import {
	ClankyBashResultComponent,
	formatFaceBashResultLines,
	runFaceBashCommand,
	type FaceBashResult,
} from "../agent/lib/clanky-face-bash.ts";
import { createClankyFaceAnsiTheme } from "../agent/lib/clanky-face-theme.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const ansi = createClankyFaceAnsiTheme({ color: false, trueColor: false });
const cwd = process.cwd();
const env = process.env;

// stdout capture, exit 0, and the onSpawn hook firing with a live child.
let spawned: ChildProcess | undefined;
const ok = await runFaceBashCommand("printf 'hello world'", {
	cwd,
	env,
	onSpawn: (child) => {
		spawned = child;
	},
});
assert(ok.code === 0, `expected exit 0, got ${ok.code}`);
assert(ok.stdout === "hello world", `expected stdout 'hello world', got ${JSON.stringify(ok.stdout)}`);
assert(ok.stderr === "", "no stderr for a clean command");
assert(!ok.timedOut && !ok.truncated, "clean command is neither timed out nor truncated");
assert(spawned !== undefined && typeof spawned.kill === "function", "onSpawn receives the child process");

// stderr capture and non-zero exit code propagation.
const fail = await runFaceBashCommand("printf 'boom' 1>&2; exit 3", { cwd, env });
assert(fail.code === 3, `expected exit 3, got ${fail.code}`);
assert(fail.stderr === "boom", `expected stderr 'boom', got ${JSON.stringify(fail.stderr)}`);
assert(fail.stdout === "", "no stdout for the failing command");

// Output cap marks truncation and stops growing past the limit.
const big = await runFaceBashCommand("for i in $(seq 1 1000); do printf 'xxxxxxxxxx'; done", {
	cwd,
	env,
	maxOutput: 100,
});
assert(big.truncated, "oversized output is flagged truncated");
assert(big.stdout.length <= 100, `captured output stays within the cap, got ${big.stdout.length}`);

// Timeout kills the command and flags timedOut without hanging the test.
const slow = await runFaceBashCommand("sleep 5", { cwd, env, timeoutMs: 200 });
assert(slow.timedOut, "a command past the timeout is flagged timedOut");
assert(slow.durationMs < 4000, `timed-out command resolves promptly, took ${slow.durationMs}ms`);

// A bad shell still resolves (never rejects) as a non-zero result.
const badShell = await runFaceBashCommand("echo hi", { cwd, env, shell: "/nonexistent/shell-xyz" });
assert(badShell.code !== 0, "spawn error resolves as non-zero");
assert(badShell.stderr.length > 0, "spawn error surfaces a message on stderr");

// Cancellation via the onSpawn child mirrors the face Ctrl-C path.
const cancelled = await runFaceBashCommand("sleep 5", {
	cwd,
	env,
	onSpawn: (child) => child.kill("SIGINT"),
});
assert(cancelled.code !== 0, "a SIGINT'd command resolves non-zero");
assert(cancelled.durationMs < 4000, "cancelled command resolves promptly");

// Renderer: header, output body, and a green exit-0 footer.
const okLines = formatFaceBashResultLines("ls -a", { stdout: "a\nb", stderr: "", code: 0, timedOut: false, truncated: false, durationMs: 12 }, ansi, 80);
assert((okLines[0] ?? "").includes("$ ls -a"), "header echoes the command with a $ prefix");
assert(okLines.some((line) => line.includes("a")) && okLines.some((line) => line.includes("b")), "stdout lines are rendered");
assert(okLines.some((line) => line.includes("exit 0")), "exit-0 footer is present");
assert(okLines.some((line) => line.includes("12ms")), "sub-second duration renders in ms");

// Renderer: empty output, non-zero exit, and the timed-out/truncated notes.
const noteResult: FaceBashResult = { stdout: "", stderr: "", code: 124, timedOut: true, truncated: true, durationMs: 2500 };
const noteLines = formatFaceBashResultLines("sleep 5", noteResult, ansi, 80);
assert(noteLines.some((line) => line.includes("(no output)")), "empty output shows a placeholder");
assert(noteLines.some((line) => line.includes("exit 124")), "non-zero exit is shown");
assert(noteLines.some((line) => line.includes("timed out")), "timed-out note is shown");
assert(noteLines.some((line) => line.includes("output truncated")), "truncated note is shown");
assert(noteLines.some((line) => line.includes("2.5s")), "multi-second duration renders in seconds");

// The component delegates to the same renderer.
const component = new ClankyBashResultComponent("pwd", { stdout: cwd, stderr: "", code: 0, timedOut: false, truncated: false, durationMs: 5 }, ansi);
const componentLines = component.render(80);
assert((componentLines[0] ?? "").includes("$ pwd"), "component renders the command header");
assert(componentLines.some((line) => line.includes(cwd)), "component renders stdout");

console.log("clanky-face-bash smoke passed");
