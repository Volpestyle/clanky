/**
 * Read-only pi-tui mirror for a Clanky presence session (SPEC.md §5.6).
 *
 * Runs as a herdr pane (clanky:discord-<id> / clanky:voice) and tails an eve
 * session's NDJSON event stream, driving the same ClankyFaceRenderer the main
 * face uses so reasoning, expandable tool calls (args + output), messages, and
 * subagents are fully watchable on the stage. Watch-only: arrow keys select a
 * block, Enter/Space (or Alt+Enter) expand/collapse, PageUp/Down and the mouse
 * wheel scroll. It never drives the session - interaction happens over Discord.
 *
 * Usage: node scripts/discord-pane-mirror.ts <eveHost> <sessionId> [label]
 */
import type { HandleMessageStreamEvent } from "eve/client";
import { Key, matchesKey, ProcessTerminal, truncateToWidth, TUI, type Component } from "@earendil-works/pi-tui";
import { detectBannerCapabilities } from "../agent/lib/clanky-banner.ts";
import { ClankyFaceRenderer } from "../agent/lib/clanky-face-renderer.ts";
import { createClankyFaceAnsiTheme, createClankyFaceMarkdownTheme, type ClankyFaceAnsiTheme } from "../agent/lib/clanky-face-theme.ts";
import { type ClankyTranscriptBlockTheme } from "../agent/lib/clanky-transcript-block.ts";
import { ClankyTranscriptViewport } from "../agent/lib/clanky-transcript-viewport.ts";
import { isClankyLeftMouseButton, parseClankySgrMouse } from "../agent/lib/clanky-sgr-mouse.ts";
import { applyMirrorStreamEvent, createMirrorRenderSink, type MirrorView } from "../agent/lib/discord/pane-mirror-view.ts";

const [, , eveHost, sessionId, label = "discord"] = process.argv;

if (eveHost === undefined || sessionId === undefined) {
	console.error("usage: discord-pane-mirror <eveHost> <sessionId> [label]");
	process.exit(2);
}

if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
	console.error("discord-pane-mirror: requires a TTY (run as a herdr pane)");
	process.exit(1);
}

const MIN_TRANSCRIPT_ROWS = 4;
const HEADER_ROWS = 2;
const MOUSE_TRACKING_ENABLE = "\x1b[?1002h\x1b[?1006h";
const MOUSE_TRACKING_DISABLE = "\x1b[?1002l\x1b[?1006l";

const caps = detectBannerCapabilities(process.stdout);
const ansi = createClankyFaceAnsiTheme(caps);
const blockTheme: ClankyTranscriptBlockTheme = {
	bold: ansi.bold,
	cyan: ansi.cyan,
	dim: ansi.dim,
	green: ansi.green,
	loadingGlyph: () => "◜",
	markdown: createClankyFaceMarkdownTheme(ansi),
	red: ansi.red,
	yellow: ansi.yellow,
};

class MirrorHeader implements Component {
	private status = "connecting";
	private readonly label: string;
	private readonly sessionId: string;
	private readonly theme: ClankyFaceAnsiTheme;

	constructor(label: string, sessionId: string, theme: ClankyFaceAnsiTheme) {
		this.label = label;
		this.sessionId = sessionId;
		this.theme = theme;
	}

	setStatus(status: string): void {
		this.status = status;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const dot = this.status === "failed" ? this.theme.red("●") : this.status === "ready" ? this.theme.green("●") : this.theme.yellow("●");
		const title = `${this.theme.dim("◆")} ${this.theme.bold("mirroring")} ${this.theme.cyan(this.label)} ${this.theme.dim(`session ${this.sessionId}`)} ${dot} ${this.theme.dim(this.status)}`;
		const hint = this.theme.dim("↑/↓ select  ·  enter/click expand  ·  pgup/pgdn scroll  ·  read-only, interact over Discord");
		return [truncateToWidth(title, width, "", true), truncateToWidth(hint, width, "", true)];
	}
}

const tui = new TUI(new ProcessTerminal());
tui.setClearOnShrink(true);

const header = new MirrorHeader(label, sessionId, ansi);
const transcript = new ClankyTranscriptViewport(
	() => Math.max(MIN_TRANSCRIPT_ROWS, tui.terminal.rows - HEADER_ROWS),
	{ dim: ansi.dim, selected: ansi.cyan },
	{ blockSpacing: 1, underfilledAlignment: "top" },
);
transcript.focused = true;

const sink = createMirrorRenderSink(transcript, blockTheme, {
	requestRender: () => tui.requestRender(),
	setLoaderMessage: () => undefined,
	setStatus: (status) => {
		header.setStatus(status);
		tui.requestRender();
	},
});
const view: MirrorView = { renderer: new ClankyFaceRenderer(sink), sink };

tui.addChild(header);
tui.addChild(transcript);
tui.setFocus(transcript);

let mouseTrackingEnabled = false;
function setMouseTracking(enabled: boolean): void {
	if (enabled === mouseTrackingEnabled) return;
	mouseTrackingEnabled = enabled;
	tui.terminal.write(enabled ? MOUSE_TRACKING_ENABLE : MOUSE_TRACKING_DISABLE);
}

function shutdown(code: number): never {
	setMouseTracking(false);
	tui.stop();
	process.exit(code);
}

function isNavigationInput(data: string): boolean {
	return (
		matchesKey(data, Key.up) ||
		matchesKey(data, Key.down) ||
		matchesKey(data, Key.pageUp) ||
		matchesKey(data, Key.pageDown) ||
		matchesKey(data, Key.home) ||
		matchesKey(data, Key.end) ||
		matchesKey(data, Key.enter) ||
		matchesKey(data, Key.space) ||
		data === "\r" ||
		data === " "
	);
}

tui.addInputListener((data) => {
	if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.ctrl("d"))) shutdown(0);
	if (transcript.handleGlobalInput(data)) {
		tui.requestRender();
		return { consume: true };
	}
	const mouse = parseClankySgrMouse(data);
	if (mouse !== undefined) {
		// Left-click a collapsible block (tool/skill) to toggle expand/collapse.
		// The transcript renders directly below the fixed-height header.
		if (mouse.kind === "press" && isClankyLeftMouseButton(mouse)) {
			const row = mouse.row - 1 - HEADER_ROWS;
			if (row >= 0) transcript.toggleCollapsedAt(row);
			tui.requestRender();
		}
		return { consume: true };
	}
	if (isNavigationInput(data)) {
		transcript.handleInput(data);
		tui.requestRender();
		return { consume: true };
	}
	return undefined;
});

tui.start();
setMouseTracking(true);
process.once("SIGINT", () => shutdown(0));
process.once("SIGTERM", () => shutdown(0));

async function main(): Promise<void> {
	const url = `${eveHost.replace(/\/$/, "")}/eve/v1/session/${sessionId}/stream`;
	// Reconnect loop: the stream is durable and replayable by event index.
	let startIndex = 0;
	for (;;) {
		try {
			header.setStatus(startIndex === 0 ? "connecting" : "reconnecting");
			tui.requestRender();
			const response = await fetch(`${url}?startIndex=${startIndex}`, { headers: { accept: "application/x-ndjson" } });
			if (!response.ok || response.body === null) throw new Error(`stream HTTP ${response.status}`);
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let newline = buffer.indexOf("\n");
				while (newline !== -1) {
					const raw = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);
					newline = buffer.indexOf("\n");
					if (raw.length === 0) continue;
					startIndex += 1;
					try {
						applyMirrorStreamEvent(view, JSON.parse(raw) as HandleMessageStreamEvent);
					} catch {
						// ignore non-JSON keepalive lines
					}
				}
			}
		} catch (error) {
			header.setStatus("failed");
			sink.insertMarkdown(`**Notice**\n\nstream dropped: ${(error as Error).message}; retrying`);
		}
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}
}

void main();
