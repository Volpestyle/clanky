/**
 * The face is a separate stream from the eve brain: slash commands run locally
 * and only render into the TUI feed, so the brain never hears about them. That
 * leaves Clanky unable to resolve references like "what did he do?" after a
 * face-side `/spawn`, because the spawn never entered its conversation.
 *
 * This ledger captures face-side activity so the face can attach it (plus the
 * live worker roster) to the next turn as eve `clientContext` — ephemeral,
 * not persisted, refreshed each turn. The brain gets a snapshot of what the
 * user is looking at without polluting durable session history.
 */
import { stripVTControlCharacters } from "node:util";
import type { HerdrAgentInfo } from "../tools/herdr_spawn.ts";

export type TuiLedgerTone = "success" | "error";

export interface TuiLedgerEntry {
	command: string;
	summary: string;
	tone: TuiLedgerTone;
}

const MAX_ENTRIES = 10;
const MAX_SUMMARY_CHARS = 240;

/** Rolling record of face-side slash-command activity, fed to the brain. */
export class TuiLedger {
	private readonly entries: TuiLedgerEntry[] = [];
	private spawned = false;

	record(command: string, message: string, tone: TuiLedgerTone): void {
		const summary = summarizeCommandResult(message);
		if (summary.length === 0) return;
		this.entries.push({ command, summary, tone });
		if (this.entries.length > MAX_ENTRIES) this.entries.shift();
		if (tone === "success" && command === "/spawn") this.spawned = true;
	}

	/** Whether a face-side spawn happened, so the snapshot should fetch the roster. */
	hasSpawnActivity(): boolean {
		return this.spawned;
	}

	/** One compact line per recorded action, oldest first. */
	actionLines(): string[] {
		return this.entries.map(
			(entry) => `- ${entry.command}${entry.tone === "error" ? " (error)" : ""} -> ${entry.summary}`,
		);
	}
}

/** Reduce a (possibly multi-line, ANSI-colored) command result to one plain line. */
function summarizeCommandResult(message: string): string {
	const plain = stripVTControlCharacters(message);
	const firstLine = plain.split(/\r?\n/u).find((line) => line.trim().length > 0)?.trim() ?? "";
	return firstLine.length > MAX_SUMMARY_CHARS ? `${firstLine.slice(0, MAX_SUMMARY_CHARS - 1)}…` : firstLine;
}

/** Plain-text worker roster lines for the brain (no ANSI, no box drawing). */
export function formatWorkerRosterForBrain(workers: readonly HerdrAgentInfo[]): string[] {
	return workers.map((worker) => {
		const cwd = worker.cwd.trim().length > 0 ? ` · cwd ${worker.cwd}` : "";
		return `- ${worker.agent} — ${worker.agentStatus} · pane ${worker.paneId}${cwd}`;
	});
}

/**
 * Assemble the `clientContext` message from recent actions and the live roster.
 * Returns undefined when there is nothing to report, so idle chats add no tokens.
 */
export function buildTuiContextMessage(input: {
	actions: readonly string[];
	workers: readonly string[];
}): string | undefined {
	const sections: string[] = [];
	if (input.actions.length > 0) {
		sections.push(["Recent TUI actions (oldest first):", ...input.actions].join("\n"));
	}
	if (input.workers.length > 0) {
		sections.push(
			[
				"Workers on the herdr stage (live — inspect a worker with herdr_status / herdr_read):",
				...input.workers,
			].join("\n"),
		);
	}
	if (sections.length === 0) return undefined;
	return [
		'[Clanky TUI context — live state of the terminal UI the user is looking at, injected by the face. Not part of durable history. Use it to resolve references like "he", "the worker", or "that agent".]',
		...sections,
	].join("\n\n");
}
