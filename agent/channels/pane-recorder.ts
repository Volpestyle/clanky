/**
 * Boot seam for the session-wide pane recorder (SPEC.md §4.3, ADR-0007).
 *
 * Starts the recorder as a guarded module side effect when the runtime — not
 * a build/info pass — sets CLANKY_PANE_RECORDER=1 (the face injects it into
 * the owned brain env when it runs inside herdr). The recorder attaches to
 * every pane in the connected herdr session and persists per-pane recordings
 * next to the worker transcripts; a session lockfile inside the store keeps
 * concurrent brains (clanky dev + always-on) from double-recording.
 *
 * Env:
 *   CLANKY_PANE_RECORDER=1            opt in (set by the always-on runtime, not build)
 *   CLANKY_PANE_RECORDER_RECORD_ALL=1 also byte-record wrapper-covered worker panes
 */
import { defineChannel, GET } from "eve/channels";
import { startPaneRecorder, type PaneRecorderHandle } from "../lib/pane-recorder.ts";

type PaneRecorderState = {
	handle: PaneRecorderHandle | null;
	starting: boolean;
	startError: string | null;
};
const PANE_RECORDER_STATE_KEY = "__clankyPaneRecorderState" as const;
type PaneRecorderGlobal = typeof globalThis & { [PANE_RECORDER_STATE_KEY]?: PaneRecorderState };
const paneRecorderState = ((globalThis as PaneRecorderGlobal)[PANE_RECORDER_STATE_KEY] ??= {
	handle: null,
	starting: false,
	startError: null,
});

function ensureStarted(): void {
	if (process.env.CLANKY_PANE_RECORDER !== "1") return;
	if (paneRecorderState.handle !== null || paneRecorderState.starting) return;
	paneRecorderState.starting = true;
	startPaneRecorder({
		recordAll: process.env.CLANKY_PANE_RECORDER_RECORD_ALL === "1",
	})
		.then((handle) => {
			paneRecorderState.handle = handle ?? null;
			paneRecorderState.startError = null;
		})
		.catch((error: unknown) => {
			paneRecorderState.startError = error instanceof Error ? error.message : String(error);
			console.error(`pane recorder failed to start: ${paneRecorderState.startError}`);
		})
		.finally(() => {
			paneRecorderState.starting = false;
		});
}

// Guarded boot: records only in the always-on runtime, never during build/info.
ensureStarted();

export default defineChannel({
	routes: [
		GET("/pane-recorder/health", async () => {
			ensureStarted();
			return Response.json({
				enabled: process.env.CLANKY_PANE_RECORDER === "1",
				starting: paneRecorderState.starting,
				startError: paneRecorderState.startError,
				status: paneRecorderState.handle?.status() ?? null,
			});
		}),
	],
});
