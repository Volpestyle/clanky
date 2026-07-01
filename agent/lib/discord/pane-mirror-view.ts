/**
 * Shared view logic for the read-only presence-session pane mirror (SPEC.md
 * §5.6). The mirror is a watch-only face for one eve session: it drives the
 * same ClankyFaceRenderer the main face uses, so reasoning, expandable tool
 * calls (args + output), messages, and subagents render identically. This
 * module owns the pi-tui-agnostic seam (sink + per-event dispatch) so it can be
 * smoke-tested without a TTY; scripts/discord-pane-mirror.ts wires it to a live
 * TUI and stream.
 */
import type { HandleMessageStreamEvent } from "eve/client";
import type { ClankyFaceRenderer, FaceBlockHandle, FaceBlockOptions, FaceRenderSink } from "../clanky-face-renderer.ts";
import { ClankyTranscriptMarkdownBlock, type ClankyTranscriptBlockTheme } from "../clanky-transcript-block.ts";
import type { ClankyTranscriptViewport } from "../clanky-transcript-viewport.ts";
import { summarizePresencePromptForMirror } from "./prompt.ts";

export type MirrorSinkHooks = {
	readonly requestRender: () => void;
	readonly setLoaderMessage: (message: string) => void;
	readonly setStatus: (message: string) => void;
};

/** Build a FaceRenderSink that appends collapsible markdown blocks to a viewport. */
export function createMirrorRenderSink(
	viewport: ClankyTranscriptViewport,
	blockTheme: ClankyTranscriptBlockTheme,
	hooks: MirrorSinkHooks,
): FaceRenderSink {
	return {
		insertMarkdown(markdown: string, options?: FaceBlockOptions): FaceBlockHandle {
			const component = new ClankyTranscriptMarkdownBlock(markdown, blockTheme);
			const block = viewport.addChild(component, options);
			hooks.requestRender();
			return {
				remove(): void {
					block.remove();
					hooks.requestRender();
				},
				setMarkdown(next: string): void {
					component.setMarkdown(next);
					hooks.requestRender();
				},
			};
		},
		setLoaderMessage: hooks.setLoaderMessage,
		setStatus: hooks.setStatus,
	};
}

export type MirrorView = {
	readonly renderer: ClankyFaceRenderer;
	readonly sink: FaceRenderSink;
};

/**
 * Apply one session-stream event to the mirror. Resets per-turn/per-session
 * renderer state on boundaries (the renderer does not self-reset) and surfaces
 * the inbound Discord prompt that the shared face renderer otherwise ignores,
 * then hands the event to the renderer for full transcript rendering.
 */
export function applyMirrorStreamEvent(view: MirrorView, event: HandleMessageStreamEvent): void {
	if (event.type === "session.started") {
		view.renderer.resetSession();
	} else if (event.type === "turn.started") {
		view.renderer.resetTurn();
	} else if (event.type === "message.received") {
		const summary = summarizePresencePromptForMirror(event.data.message);
		const text = summary ?? event.data.message.trim();
		if (text.length > 0) view.sink.insertMarkdown(`**You**\n\n${text}`);
	}
	view.renderer.renderEvent(event);
}
