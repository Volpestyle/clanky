// Live probe for herdr API socket round-trip time, measured the exact way
// agent/lib/herdr-socket.ts herdrRequest does it: a FRESH unix-socket
// connection per request, one JSON `ping` line written on connect, resolved on
// the first reply line. Reproduces the F1 typing-latency finding: herdr builds
// whose api server polls read_initial_request_line on a 100ms sleep show a
// ~100ms tail on a fraction of samples (the p50 stays sub-millisecond).
//
// Usage:
//   pnpm smoke:herdr:rtt                    # env-bound session, 30 samples
//   node test/herdr-rtt-smoke.ts [session-or-socket-path] [samples]
import { createConnection } from "node:net";
import { herdrSocketPath } from "../agent/lib/herdr-socket.ts";

const SLOW_SAMPLE_MS = 50;
const session = process.argv[2];
const sampleCount = Number(process.argv[3] ?? 30);
const socketPath = herdrSocketPath(session);

function pingOnce(): Promise<number> {
	return new Promise((resolve, reject) => {
		const t0 = process.hrtime.bigint();
		const socket = createConnection(socketPath);
		let buffer = "";
		socket.setTimeout(5000, () => {
			socket.destroy();
			reject(new Error("timeout"));
		});
		socket.on("error", reject);
		socket.on("connect", () => {
			socket.write(`${JSON.stringify({ id: `rtt_${Date.now()}`, method: "ping", params: {} })}\n`);
		});
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			if (buffer.includes("\n")) {
				const t1 = process.hrtime.bigint();
				socket.end();
				resolve(Number(t1 - t0) / 1e6);
			}
		});
	});
}

const samples: number[] = [];
for (let i = 0; i < sampleCount; i++) {
	try {
		samples.push(await pingOnce());
	} catch (error) {
		console.error(`sample ${i}: ${(error as Error).message}`);
	}
	await new Promise((resolve) => setTimeout(resolve, 50));
}

if (samples.length === 0) {
	console.error(`herdr rtt smoke FAIL: no samples (socket=${socketPath})`);
	process.exit(1);
}

samples.sort((a, b) => a - b);
const quantile = (q: number): number => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))];
const slow = samples.filter((sample) => sample > SLOW_SAMPLE_MS).length;
console.log(`socket=${socketPath} n=${samples.length}`);
console.log(
	`min=${samples[0].toFixed(2)}ms p50=${quantile(0.5).toFixed(2)}ms p90=${quantile(0.9).toFixed(2)}ms p99=${quantile(0.99).toFixed(2)}ms max=${samples[samples.length - 1].toFixed(2)}ms`,
);
console.log(`slow (> ${SLOW_SAMPLE_MS}ms): ${slow}/${samples.length}${slow > 0 ? "  <- F1 race hits (100ms initial-read poll)" : ""}`);
console.log(samples.map((sample) => sample.toFixed(1)).join(" "));
console.log("herdr rtt smoke OK");
