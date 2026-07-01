/**
 * Identity resolution for `clanky msg` — provenance-stamped peer messaging.
 *
 * Herdr worker panes coordinate by sending each other submitted prompts. The
 * failure this guards against: an agent trusts a pane id a *message* claims for
 * itself, replies to that pane, and a status update lands in an uninvolved
 * sibling's session. The fix is structural — resolve every target against the
 * live roster (never message content), and stamp the sender's verified identity
 * (from `HERDR_PANE_ID`) so the recipient never has to trust a self-declared id.
 */

export interface HerdrPaneRow {
	readonly paneId: string;
	readonly agent?: string;
	readonly label?: string;
	readonly status?: string;
}

export interface ResolvedPane {
	readonly paneId: string;
	readonly name: string;
	readonly agent?: string;
	readonly label?: string;
	readonly status?: string;
}

export type TargetResolution =
	| { readonly ok: true; readonly pane: ResolvedPane }
	| { readonly ok: false; readonly reason: string; readonly candidates: readonly ResolvedPane[] };

/**
 * The identifying name for a pane: its label, else a durable `clanky:<slug>`
 * agent name, else the pane id. A bare harness name (`claude`/`codex`) is shared
 * by many panes, so it is never used as an identity — the unique pane id is.
 */
export function paneDisplayName(row: HerdrPaneRow): string {
	if (row.label !== undefined) return row.label;
	if (row.agent !== undefined && row.agent.startsWith("clanky:")) return row.agent;
	return row.paneId;
}

function toResolved(row: HerdrPaneRow): ResolvedPane {
	return { paneId: row.paneId, name: paneDisplayName(row), agent: row.agent, label: row.label, status: row.status };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse the `{ result: { panes: [...] } }` envelope from `herdr pane list`. */
export function parsePaneRoster(stdout: string): HerdrPaneRow[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new Error("could not parse `herdr pane list` output as JSON");
	}
	const result = isRecord(parsed) ? parsed.result : undefined;
	const panes = isRecord(result) && Array.isArray(result.panes) ? result.panes : [];
	const rows: HerdrPaneRow[] = [];
	for (const pane of panes) {
		if (!isRecord(pane)) continue;
		const paneId = typeof pane.pane_id === "string" ? pane.pane_id : undefined;
		if (paneId === undefined || paneId.length === 0) continue;
		rows.push({
			paneId,
			agent: typeof pane.agent === "string" && pane.agent.length > 0 ? pane.agent : undefined,
			label: typeof pane.label === "string" && pane.label.length > 0 ? pane.label : undefined,
			status: typeof pane.agent_status === "string" && pane.agent_status.length > 0 ? pane.agent_status : undefined,
		});
	}
	return rows;
}

/**
 * The sender's own identity, resolved from `HERDR_PANE_ID` against the roster.
 * A pane id absent from the roster (a compaction race) still yields verifiable
 * provenance: the id itself came from the environment, not a message.
 */
export function resolveSelf(roster: readonly HerdrPaneRow[], selfPaneId: string): ResolvedPane {
	const row = roster.find((r) => r.paneId === selfPaneId);
	return row !== undefined ? toResolved(row) : { paneId: selfPaneId, name: selfPaneId };
}

/**
 * Resolve a target query against the live roster. Matching is tiered so the
 * human name wins over the harness name: exact pane id, then exact label, then
 * exact agent, then case-insensitive label/agent. The first tier with any hit
 * decides; more than one hit in that tier is ambiguous (caller must
 * disambiguate). The sender's own pane is never a valid target.
 */
export function resolveTarget(
	roster: readonly HerdrPaneRow[],
	query: string,
	selfPaneId: string,
): TargetResolution {
	const q = query.trim();
	if (q.length === 0) return { ok: false, reason: "empty target", candidates: [] };
	const others = roster.filter((r) => r.paneId !== selfPaneId);
	const lower = q.toLowerCase();
	const tiers: Array<(r: HerdrPaneRow) => boolean> = [
		(r) => r.paneId === q,
		(r) => r.label === q,
		(r) => r.agent === q,
		(r) => r.label?.toLowerCase() === lower,
		(r) => r.agent?.toLowerCase() === lower,
	];
	for (const match of tiers) {
		const hits = others.filter(match);
		if (hits.length === 1) return { ok: true, pane: toResolved(hits[0]) };
		if (hits.length > 1) {
			return {
				ok: false,
				reason: `'${q}' matches ${hits.length} panes; address by label or pane id`,
				candidates: hits.map(toResolved),
			};
		}
	}
	const self = roster.find((r) => r.paneId === selfPaneId);
	if (self !== undefined && (self.paneId === q || self.label === q || self.agent === q || self.label?.toLowerCase() === lower)) {
		return { ok: false, reason: `'${q}' is this pane; you cannot message yourself`, candidates: [] };
	}
	return { ok: false, reason: `no live pane matches '${q}'`, candidates: others.map(toResolved) };
}

/**
 * Prefix a message with the sender's verified `[from <name>]`. Idempotent for
 * this sender; a different `[from ...]` already present is left in place so a
 * spoofed stamp is exposed in front of, not replaced by, the real one.
 */
export function stampMessage(selfName: string, text: string): string {
	const body = text.trim();
	const prefix = `[from ${selfName}]`;
	return body.startsWith(prefix) ? body : `${prefix} ${body}`;
}
