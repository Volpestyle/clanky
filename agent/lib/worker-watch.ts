/**
 * Classification and message formatting for `clanky watch` — the one-shot
 * completion watcher armed at the spawn seam (the "ping me when you're done"
 * bridge for lead/worker orchestration).
 *
 * The watcher blocks on herdr agent-status events for one worker, classifies
 * the outcome, delivers a single provenance-stamped wake message to the lead,
 * and exits. Sentinel files (`DONE`/`BLOCKED` under the run dir) are completion
 * truth; `agent_status` is a heuristic. This module is pure — the herdr socket
 * subscription, sentinel reads, and delivery live in `bin/clanky.ts`.
 */
import { basename, join } from "node:path";

/** What a wake message reports about the watched worker. */
export type WorkerWakeOutcome = "done" | "blocked" | "idle" | "dead" | "timeout";

/**
 * A classification snapshot: `running` means "keep waiting" and is never
 * delivered; the other states map 1:1 onto wake outcomes.
 */
export type WorkerWatchState = "done" | "blocked" | "idle" | "dead" | "running";

export interface WorkerSentinels {
	readonly done: boolean;
	readonly blocked: boolean;
}

/** Agent statuses that mean the worker's turn has ended. */
const SETTLED_AGENT_STATUSES: readonly string[] = ["done", "blocked", "idle"];

export function isSettledAgentStatus(status: string | undefined): boolean {
	return status !== undefined && SETTLED_AGENT_STATUSES.includes(status);
}

/**
 * Classify the worker from a probe. Sentinels win over status; a pane that is
 * gone without a sentinel died silently; a settled status without a sentinel is
 * the "forgot the protocol" case. Without a run dir (`sentinels` undefined)
 * classification falls back to the status heuristic alone.
 */
export function classifyWorkerState(input: {
	paneAlive: boolean;
	agentStatus?: string;
	sentinels?: WorkerSentinels;
}): WorkerWatchState {
	if (input.sentinels?.done === true) return "done";
	if (input.sentinels?.blocked === true) return "blocked";
	if (!input.paneAlive) return "dead";
	if (input.sentinels !== undefined) {
		return isSettledAgentStatus(input.agentStatus) ? "idle" : "running";
	}
	if (input.agentStatus === "done") return "done";
	if (input.agentStatus === "blocked") return "blocked";
	if (input.agentStatus === "idle") return "idle";
	return "running";
}

/** `clanky:<slug>` -> `<slug>`; a bare name passes through unchanged. */
export function workerSlugFromAgent(agent: string): string {
	return agent.startsWith("clanky:") ? agent.slice("clanky:".length) : agent;
}

/**
 * The watcher's own `[from ...]` identity. The watcher is a detached harness
 * process, not a pane, so it stamps as `watch:<slug>` instead of borrowing the
 * arming pane's identity — a wake that says `[from watch:fix-auth]` is
 * attributable without claiming to be the lead or the worker.
 */
export function watcherSelfName(agent: string): string {
	return `watch:${workerSlugFromAgent(agent)}`;
}

export interface WorkerRunPaths {
	readonly runId: string;
	readonly workerDir: string;
	readonly donePath: string;
	readonly blockedPath: string;
	readonly resultPath: string;
	readonly watchLogPath: string;
}

/** Resolve the per-worker sentinel/result layout under an operator run dir. */
export function workerRunPaths(runDir: string, agent: string): WorkerRunPaths {
	const workerDir = join(runDir, "workers", workerSlugFromAgent(agent));
	return {
		runId: basename(runDir),
		workerDir,
		donePath: join(workerDir, "DONE"),
		blockedPath: join(workerDir, "BLOCKED"),
		resultPath: join(workerDir, "result.md"),
		watchLogPath: join(workerDir, "watch.log"),
	};
}

export interface WakeMessageInput {
	readonly agent: string;
	readonly outcome: WorkerWakeOutcome;
	/** From the run dir basename; absent when watching without a run dir. */
	readonly runId?: string;
	/** Set when the worker's result.md exists on disk. */
	readonly resultPath?: string;
	/** Last observed agent status, for the heuristic-only qualifiers. */
	readonly agentStatus?: string;
	readonly hasRunDir: boolean;
	readonly timeoutMs?: number;
}

/**
 * `[worker <outcome>] clanky:<slug> run=<run-id> result=<path> (qualifiers)`.
 * Qualifiers spell out when the classification is heuristic (no sentinel, no
 * run dir) so the lead knows how much to trust the outcome before verifying.
 */
export function formatWakeMessage(input: WakeMessageInput): string {
	const parts = [`[worker ${input.outcome}] ${input.agent}`];
	if (input.runId !== undefined) parts.push(`run=${input.runId}`);
	if (input.resultPath !== undefined) parts.push(`result=${input.resultPath}`);
	const notes: string[] = [];
	if (input.outcome === "idle" && input.hasRunDir) {
		notes.push(`agent status ${input.agentStatus ?? "settled"}, no DONE/BLOCKED sentinel — inspect the pane`);
	}
	if (input.outcome === "dead") {
		notes.push(input.hasRunDir ? "pane gone, no sentinel" : "pane gone");
	}
	if (input.outcome === "timeout") {
		notes.push(`no completion after ${input.timeoutMs ?? 0}ms, watcher exited — re-arm or harvest manually`);
	}
	if (!input.hasRunDir && input.outcome !== "dead") {
		notes.push(
			input.outcome === "timeout"
				? "no run dir"
				: `agent status ${input.agentStatus ?? "unknown"}, no run dir — classified on status alone`,
		);
	}
	if (notes.length > 0) parts.push(`(${notes.join("; ")})`);
	return parts.join(" ");
}

/** Consecutive quiet probes required before a status-only settle fires a wake. */
export const SETTLE_QUIET_PROBES_REQUIRED = 3;

export interface SettleProbeSnapshot {
	readonly paneAlive: boolean;
	readonly agentStatus?: string;
	/** Digest of the pane's visible screen text; changes while output flows. */
	readonly screenSignature?: string;
	readonly sentinels?: WorkerSentinels;
}

export interface SettleProgress {
	readonly quietProbes: number;
	readonly screenSignature?: string;
}

export type SettleDecision =
	| { readonly kind: "fire"; readonly outcome: "done" | "blocked" | "idle" | "dead" }
	| { readonly kind: "watch" }
	| { readonly kind: "confirming"; readonly progress: SettleProgress };

/**
 * One step of settle confirmation. `agent_status` is heuristic — a pane has
 * been observed reading `idle` mid-turn while visibly working — so a
 * status-only settle must hold across consecutive probes with a quiet screen
 * before it fires. Sentinel files and pane death are truth and fire
 * immediately; a status back at `working` (or lost to `unknown`) abandons
 * confirmation and returns to event waiting, where the next settle emits a
 * fresh status-change event.
 */
export function evaluateSettleProbe(
	snapshot: SettleProbeSnapshot,
	previous: SettleProgress,
	quietProbesRequired: number = SETTLE_QUIET_PROBES_REQUIRED,
): SettleDecision {
	const state = classifyWorkerState({
		paneAlive: snapshot.paneAlive,
		agentStatus: snapshot.agentStatus,
		sentinels: snapshot.sentinels,
	});
	if (snapshot.sentinels?.done === true || snapshot.sentinels?.blocked === true || !snapshot.paneAlive) {
		return { kind: "fire", outcome: state === "running" || state === "idle" ? "dead" : state };
	}
	if (state === "running") return { kind: "watch" };
	// state is a status-derived done/blocked/idle. A probe is quiet when the
	// visible screen did not change since the previous probe; the first probe
	// after a settle event starts the quiet window.
	const quiet = previous.screenSignature === undefined || previous.screenSignature === snapshot.screenSignature;
	const quietProbes = quiet ? previous.quietProbes + 1 : 1;
	if (quietProbes >= quietProbesRequired) return { kind: "fire", outcome: state };
	return { kind: "confirming", progress: { quietProbes, screenSignature: snapshot.screenSignature } };
}

/** One line from the watcher's `events.subscribe` stream, decoded. */
export type WatchEvent =
	| { readonly kind: "subscribed" }
	| { readonly kind: "error"; readonly message: string }
	| { readonly kind: "agent-status"; readonly paneId: string; readonly status: string }
	| { readonly kind: "pane-gone"; readonly paneId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decode one line of the herdr `events.subscribe` stream. The ack line carries
 * `result.type = "subscription_started"`; agent-status changes arrive as
 * `{"event":"pane.agent_status_changed","data":{...}}`; generic pane events
 * (`pane.closed` / `pane.exited` — pane death) serialize their kind in
 * snake_case, so both spellings are accepted. Unrelated lines yield undefined.
 */
export function parseWatchEventLine(line: string): WatchEvent | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;
	if (isRecord(parsed.error)) {
		const message = typeof parsed.error.message === "string" ? parsed.error.message : "herdr subscription failed";
		return { kind: "error", message };
	}
	if (isRecord(parsed.result)) {
		return parsed.result.type === "subscription_started" ? { kind: "subscribed" } : undefined;
	}
	const event = typeof parsed.event === "string" ? parsed.event : undefined;
	const data = isRecord(parsed.data) ? parsed.data : undefined;
	const paneId = typeof data?.pane_id === "string" ? data.pane_id : undefined;
	if (event === undefined || paneId === undefined) return undefined;
	if (event === "pane.agent_status_changed" || event === "pane_agent_status_changed") {
		const status = typeof data?.agent_status === "string" ? data.agent_status : undefined;
		if (status === undefined) return undefined;
		return { kind: "agent-status", paneId, status };
	}
	if (event === "pane.closed" || event === "pane_closed" || event === "pane.exited" || event === "pane_exited") {
		return { kind: "pane-gone", paneId };
	}
	return undefined;
}
