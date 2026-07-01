/**
 * Offline smoke aggregate: `pnpm smoke`.
 *
 * Globs test/*-smoke.ts and runs every test that works without live services,
 * so new offline smoke tests are picked up automatically — no hand-kept list.
 * Tests that need live credentials, a live Herdr/eve/Discord surface, or a TTY
 * are excluded below; run those individually via their `pnpm smoke:*` scripts.
 *
 * Usage:
 *   node scripts/run-smoke.ts            run the offline set
 *   node scripts/run-smoke.ts --list     print the resolved set and exit
 *   CLANKY_SMOKE_TIMEOUT_MS=120000       per-test timeout override
 */
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DIR = join(REPO, "test");
const TIMEOUT_MS = Number.parseInt(process.env.CLANKY_SMOKE_TIMEOUT_MS ?? "", 10) || 120_000;

// Live-gated tests (credentials, live Herdr panes, live eve server, live
// Discord, TTY, or real network). Everything else in test/*-smoke.ts runs.
const LIVE_GATED = new Set([
	"browser-bridge-smoke.ts", // needs the installed browser-bridge daemon
	"codex-model-smoke.ts", // live Codex subscription call
	"connections-smoke.ts", // live eve connections inventory
	"discord-acceptance-smoke.ts", // live Discord gateway + token
	"discord-pane-mirror-smoke.ts", // spawns a TTY mirror pane
	"discord-recent-attachments-smoke.ts", // live Discord REST
	"herdr-read-transcript-smoke.ts", // live herdr session
	"herdr-rtt-smoke.ts", // live herdr API socket probe
	"herdr-spawn-smoke.ts", // spawns real herdr panes
	"herdr-spawn-transcript-smoke.ts", // spawns real herdr panes
	"ios-chat-mirror-smoke.ts", // live herdr workspace ops
	"media-generation-smoke.ts", // live image/video model APIs
	"media-inspect-sandbox-smoke.ts", // live vision model APIs
	"push-routing-smoke.ts", // live relay + APNs path
	"relay-smoke.ts", // live relay channel
	"relay-hardening-smoke.ts", // live relay channel
]);

type Failure = { name: string; detail: string };

async function collectSmokeTests(): Promise<string[]> {
	const entries = await readdir(TEST_DIR);
	return entries
		.filter((name) => name.endsWith("-smoke.ts") && !LIVE_GATED.has(name))
		.sort((left, right) => left.localeCompare(right));
}

function runTest(name: string): Promise<{ ok: boolean; detail: string }> {
	return new Promise((resolvePromise) => {
		const child = spawn(process.execPath, [join(TEST_DIR, name)], {
			cwd: REPO,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		let settled = false;
		const finish = (ok: boolean, detail: string): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolvePromise({ ok, detail });
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(false, `timed out after ${TIMEOUT_MS}ms`);
		}, TIMEOUT_MS);
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
		});
		child.on("error", (error) => finish(false, error.message));
		child.on("close", (code, signal) => {
			if (code === 0) {
				finish(true, "");
				return;
			}
			const status = signal !== null ? `signal ${signal}` : `exit ${code}`;
			const tail = output.trim().split("\n").slice(-6).join("\n");
			finish(false, `${status}\n${tail}`);
		});
	});
}

const tests = await collectSmokeTests();
if (process.argv.includes("--list")) {
	for (const name of tests) process.stdout.write(`${name}\n`);
	process.exit(0);
}

const failures: Failure[] = [];
const startedAt = Date.now();
for (const name of tests) {
	const testStartedAt = Date.now();
	const result = await runTest(name);
	const elapsed = `${((Date.now() - testStartedAt) / 1000).toFixed(1)}s`;
	if (result.ok) {
		process.stdout.write(`ok   ${name} (${elapsed})\n`);
	} else {
		failures.push({ name, detail: result.detail });
		process.stdout.write(`FAIL ${name} (${elapsed})\n${indent(result.detail)}\n`);
	}
}

const totalElapsed = `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
if (failures.length > 0) {
	process.stdout.write(`\n${failures.length}/${tests.length} smoke tests failed (${totalElapsed}): ${failures.map((f) => f.name).join(", ")}\n`);
	process.exit(1);
}
process.stdout.write(`\nall ${tests.length} offline smoke tests passed (${totalElapsed})\n`);

function indent(text: string): string {
	return text
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n");
}
