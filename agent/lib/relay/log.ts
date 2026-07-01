/**
 * Relay failure-path logging. Errors are always logged; verbose flow
 * breadcrumbs sit behind the same CLANKY_RELAY_TRACE=1 gate (and `relay …`
 * prefix style) as the ordered-input latency trace.
 */

// Input trace logging (op-level latency breadcrumbs) — enable with
// CLANKY_RELAY_TRACE=1. `t0` is the client's own clock, so cross-clock deltas
// are only meaningful for spotting large regressions, not absolute latency.
export const RELAY_TRACE = process.env.CLANKY_RELAY_TRACE === "1";

export function relayLogError(context: string, error?: unknown): void {
	const detail = error === undefined ? "" : `: ${error instanceof Error ? error.message : String(error)}`;
	console.error(`relay error: ${context}${detail}`);
}

export function relayTrace(context: string): void {
	if (RELAY_TRACE) console.error(`relay trace: ${context}`);
}
