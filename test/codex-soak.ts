// Sustained-use soak for Clanky's Codex subscription model (SPEC.md §4.6 route a).
// VUH-245: confirm route (a) holds under sustained real use — no 400s, no auth
// drops, refresh lifecycle owned by this long-lived process (not a TUI session).
//
// Requires a valid openai-codex credential in the auth store (same requirement
// as test/codex-model-smoke.ts). Appends one JSON line per turn to the log so
// the run doubles as milestone evidence. Runs until the turn budget is spent,
// SIGINT/SIGTERM arrives, or too many consecutive failures suggest the route is
// down rather than flaky.
//
//   CLANKY_SOAK_INTERVAL_MS  delay between turn starts (default 180000)
//   CLANKY_SOAK_TURNS        total turns, 0 = until signal (default 0)
//   CLANKY_SOAK_LOG          JSONL path (default ~/.clanky/verify/codex-soak.jsonl)
//
// Evidence lands under ~/.clanky/verify (the agent data home), NOT .output —
// .output is eve's Nitro build dir and is wiped on every `eve dev` rebuild.
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { streamText } from "ai";
import { codexCredentialStatus } from "../agent/lib/codex-auth.ts";
import { createCodexModel } from "../agent/lib/codex-model.ts";

const envIntervalMs = Number(process.env.CLANKY_SOAK_INTERVAL_MS ?? "");
const envTurns = Number(process.env.CLANKY_SOAK_TURNS ?? "");
const intervalMs = Number.isFinite(envIntervalMs) && envIntervalMs > 0 ? envIntervalMs : 180_000;
const maxTurns = Number.isFinite(envTurns) && envTurns >= 0 ? envTurns : 0;
const logPath = process.env.CLANKY_SOAK_LOG ?? join(homedir(), ".clanky", "verify", "codex-soak.jsonl");
const MAX_CONSECUTIVE_FAILURES = 10;

interface TurnRecord {
	turn: number;
	at: string;
	ok: boolean;
	latencyMs: number;
	credExpiresMs?: number;
	credRefreshed: boolean;
	output?: string;
	error?: string;
}

const model = createCodexModel({
	modelId: process.env.CLANKY_CODEX_MODEL ?? "gpt-5.5",
	instructions: "You are a terse test harness. Follow the user exactly.",
});

let stop = false;
let wakeSleep: (() => void) | undefined;
function requestStop(signal: string): void {
	stop = true;
	wakeSleep?.();
	console.error(`[soak] ${signal} received, finishing up`);
}
process.on("SIGINT", () => requestStop("SIGINT"));
process.on("SIGTERM", () => requestStop("SIGTERM"));

await mkdir(dirname(logPath), { recursive: true });

let turn = 0;
let okCount = 0;
let failCount = 0;
let consecutiveFailures = 0;
let refreshCount = 0;
const latencies: number[] = [];
let lastExpiresMs = (await codexCredentialStatus()).expiresMs;

console.log(
	`[soak] codex route (a) soak: interval=${intervalMs}ms turns=${maxTurns === 0 ? "until signal" : maxTurns} log=${logPath}`,
);

while (!stop && (maxTurns === 0 || turn < maxTurns)) {
	turn += 1;
	const started = Date.now();

	let streamErr: unknown;
	let out = "";
	try {
		const result = streamText({
			model,
			system: "You are Clanky.",
			prompt: `Reply with exactly: SOAK_OK ${turn}`,
			onError: (e) => {
				streamErr = (e as { error?: unknown })?.error ?? e;
			},
		});
		for await (const delta of result.textStream) out += delta;
	} catch (e) {
		streamErr = e;
	}
	const latencyMs = Date.now() - started;

	const status = await codexCredentialStatus();
	const credRefreshed = status.expiresMs !== undefined && status.expiresMs !== lastExpiresMs;
	if (credRefreshed) refreshCount += 1;
	lastExpiresMs = status.expiresMs;

	const ok = streamErr === undefined && out.includes(`SOAK_OK ${turn}`);
	const record: TurnRecord = {
		turn,
		at: new Date(started).toISOString(),
		ok,
		latencyMs,
		credExpiresMs: status.expiresMs,
		credRefreshed,
	};
	if (ok) {
		okCount += 1;
		consecutiveFailures = 0;
		latencies.push(latencyMs);
	} else {
		failCount += 1;
		consecutiveFailures += 1;
		record.output = out.slice(0, 200);
		record.error = String((streamErr as Error)?.message ?? streamErr ?? "unexpected output").slice(0, 500);
	}
	await appendFile(logPath, `${JSON.stringify(record)}\n`);

	const expiresIn = status.expiresMs !== undefined ? `cred expires in ${Math.round((status.expiresMs - Date.now()) / 60_000)}m` : "cred expiry unknown";
	const refreshNote = credRefreshed ? ", refreshed" : "";
	if (ok) {
		console.log(`[soak] turn ${turn} OK ${latencyMs}ms (${expiresIn}${refreshNote})`);
	} else {
		console.error(`[soak] turn ${turn} FAIL ${latencyMs}ms (${expiresIn}${refreshNote}) -> ${record.error}`);
	}

	if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
		console.error(`[soak] aborting: ${MAX_CONSECUTIVE_FAILURES} consecutive failures`);
		break;
	}
	if (!stop && (maxTurns === 0 || turn < maxTurns)) {
		const wait = Math.max(0, intervalMs - (Date.now() - started));
		await new Promise<void>((resolve) => {
			wakeSleep = resolve;
			setTimeout(resolve, wait);
		});
		wakeSleep = undefined;
	}
}

const sorted = [...latencies].sort((a, b) => a - b);
const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : undefined;
console.log(
	`[soak] done: ${turn} turns, ${okCount} ok, ${failCount} fail, ${refreshCount} credential refreshes, latency min/median/max = ${sorted[0] ?? "-"}/${median ?? "-"}/${sorted[sorted.length - 1] ?? "-"}ms`,
);
process.exit(failCount === 0 ? 0 : 1);
