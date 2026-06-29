import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatVoiceDropNotice, reportVoiceFault } from "../agent/lib/discord/host.ts";
import { readLastVoiceFault, recordVoiceFault, type VoiceFaultRecord } from "../agent/lib/voice/fault-log.ts";
import type { VoiceSessionFault } from "../agent/lib/voice/supervisor.ts";

let failures = 0;

function check(label: string, ok: boolean): void {
	console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
	if (!ok) failures += 1;
}

async function main(): Promise<void> {
	const home = await mkdtemp(join(tmpdir(), "clanky-voice-fault-"));
	const env = { CLANKY_HOME: home } as NodeJS.ProcessEnv;
	try {
		check("no fault recorded yet reads undefined", readLastVoiceFault(env) === undefined);

		const crash: VoiceFaultRecord = {
			at: "2026-06-29T02:12:23.000Z",
			guildId: "g1",
			channelId: "c1",
			kind: "clankvox_crashed",
			detail: "exited with code 101",
			stderrTail: ["thread 'main' panicked", "note: run with RUST_BACKTRACE=1"],
		};
		recordVoiceFault(crash, env);
		const dropped: VoiceFaultRecord = {
			at: "2026-06-29T02:15:00.000Z",
			guildId: "g1",
			channelId: "c1",
			kind: "socket_closed",
			detail: "code 1011: server error",
		};
		recordVoiceFault(dropped, env);

		const last = readLastVoiceFault(env);
		check("readLastVoiceFault returns the newest record", last?.detail === "code 1011: server error");
		check("newest record keeps its kind", last?.kind === "socket_closed");

		// stderr tail survives the round trip so a crash stays diagnosable.
		recordVoiceFault(crash, env);
		check("stderr tail round-trips through the log", readLastVoiceFault(env)?.stderrTail?.[0] === "thread 'main' panicked");

		const crashFault: VoiceSessionFault = { kind: "clankvox_crashed", detail: "exited with code 101" };
		const dropFault: VoiceSessionFault = { kind: "socket_closed", detail: "code 1011: server error" };
		check("crash notice names the transport crash", formatVoiceDropNotice(crashFault).includes("voice transport crashed"));
		check("realtime notice names the connection drop", formatVoiceDropNotice(dropFault).includes("realtime voice connection dropped"));
		check("drop notice invites a rejoin", formatVoiceDropNotice(dropFault).includes("hop in vc"));

		// reportVoiceFault must clear Go Live (dead transport) before posting the notice.
		let goLiveCleared = false;
		const sent: Array<{ channelId: string; text: string }> = [];
		await reportVoiceFault("c1", crashFault, {
			clearGoLive: () => {
				goLiveCleared = true;
			},
			sendMessage: async (channelId, text) => {
				sent.push({ channelId, text });
			},
		});
		check("reportVoiceFault clears Go Live", goLiveCleared);
		check("reportVoiceFault posts the notice to the join channel", sent.length === 1 && sent[0]?.channelId === "c1");
		check("reportVoiceFault posts the drop notice text", sent[0]?.text.includes("dropped out of VC") === true);

		// A send failure must be swallowed (best-effort) and still have cleared Go Live.
		let clearedOnFailure = false;
		let reportThrew = false;
		try {
			await reportVoiceFault("c1", dropFault, {
				clearGoLive: () => {
					clearedOnFailure = true;
				},
				sendMessage: async () => {
					throw new Error("discord 500");
				},
			});
		} catch {
			reportThrew = true;
		}
		check("reportVoiceFault swallows a send failure", !reportThrew);
		check("reportVoiceFault clears Go Live even when the notice fails", clearedOnFailure);
	} finally {
		await rm(home, { recursive: true, force: true });
	}

	if (failures > 0) {
		console.log(`\n${failures} FAILED`);
		process.exit(1);
	}
	console.log("\nALL OK");
}

void main();
