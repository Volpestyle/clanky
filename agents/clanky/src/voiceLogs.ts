import { open, writeFile } from "node:fs/promises";
import { type ClankyCommandCompletionSpec, completeClankyCommandArgument } from "@clanky/core";
import type { ExtensionCommandContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";

type Theme = ExtensionCommandContext["ui"]["theme"];

interface ClankyVoiceLogsExtensionDeps {
	voiceLogPath: string;
}

const VOICE_LOG_TAIL_BYTES = 256 * 1024;
const VOICE_LOG_VIEW_ROWS = 28;
const ANSI_STYLE_SEQUENCE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const VOICE_LOG_COMMAND_COMPLETIONS = [
	{ value: "open", description: "Open the live Discord voice log viewer.", aliases: ["view"] },
	{ value: "tail", description: "Show the recent Discord voice log tail." },
	{ value: "path", description: "Show the Discord voice log path." },
	{ value: "clear", description: "Clear the Discord voice log file." },
	{ value: "view", description: "Open the live Discord voice log viewer.", aliases: ["open"] },
] satisfies readonly ClankyCommandCompletionSpec[];

export function createClankyVoiceLogsExtensionFactory(deps: ClankyVoiceLogsExtensionDeps): ExtensionFactory {
	return (pi) => {
		const openLogs = async (args: string, ctx: ExtensionCommandContext) => {
			await runVoiceLogsCommand(deps, String(args ?? ""), ctx);
		};
		pi.registerCommand("voice-logs", {
			description: "Open the Discord voice log viewer",
			getArgumentCompletions: (prefix) => completeClankyCommandArgument(prefix, VOICE_LOG_COMMAND_COMPLETIONS),
			handler: openLogs,
		});
		pi.registerCommand("voice_logs", {
			description: "Open the Discord voice log viewer",
			getArgumentCompletions: (prefix) => completeClankyCommandArgument(prefix, VOICE_LOG_COMMAND_COMPLETIONS),
			handler: openLogs,
		});
	};
}

async function runVoiceLogsCommand(
	deps: ClankyVoiceLogsExtensionDeps,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const command = args.trim().toLowerCase();
	if (command === "path") {
		ctx.ui.notify(`Discord voice log\n${deps.voiceLogPath}`);
		return;
	}
	if (command === "clear") {
		await writeFile(deps.voiceLogPath, "");
		ctx.ui.notify("Discord voice log cleared.");
		return;
	}
	if (command === "tail" || !ctx.hasUI) {
		const lines = await readVoiceLogTail(deps.voiceLogPath);
		ctx.ui.notify(["Discord voice log", deps.voiceLogPath, "", ...lastItems(lines, 80)].join("\n"));
		return;
	}
	if (command.length > 0 && command !== "open" && command !== "view") {
		ctx.ui.notify("Voice logs\nUsage: /voice-logs [open|tail|path|clear]", "warning");
		return;
	}

	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) =>
			new VoiceLogViewComponent({
				path: deps.voiceLogPath,
				theme,
				done,
				requestRender: () => tui.requestRender(),
			}),
		{
			overlay: true,
			overlayOptions: {
				width: "92%",
				minWidth: 72,
				maxHeight: "86%",
				anchor: "center",
				margin: 1,
			},
		},
	);
}

interface VoiceLogViewOptions {
	path: string;
	theme: Theme;
	done: () => void;
	requestRender: () => void;
}

class VoiceLogViewComponent {
	private readonly path: string;
	private readonly theme: Theme;
	private readonly done: () => void;
	private readonly requestRender: () => void;
	private readonly timer: ReturnType<typeof setInterval>;
	private lines: string[] = [];
	private error: string | undefined;
	private scroll = Number.MAX_SAFE_INTEGER;
	private loading = false;

	constructor(options: VoiceLogViewOptions) {
		this.path = options.path;
		this.theme = options.theme;
		this.done = options.done;
		this.requestRender = options.requestRender;
		this.timer = setInterval(() => {
			void this.refresh();
		}, 1_000);
		this.timer.unref?.();
		void this.refresh();
	}

	dispose(): void {
		clearInterval(this.timer);
	}

	invalidate(): void {
		return;
	}

	handleInput(data: string): void {
		if (isEscapeKey(data) || data === "q") {
			this.done();
			return;
		}
		if (data === "r") {
			void this.refresh({ forceBottom: false });
			return;
		}
		if (isUpKey(data) || data === "k") {
			this.scroll = Math.max(0, this.scroll - 1);
			this.requestRender();
			return;
		}
		if (isDownKey(data) || data === "j") {
			this.scroll += 1;
			this.requestRender();
			return;
		}
		if (isPageUpKey(data)) {
			this.scroll = Math.max(0, this.scroll - 8);
			this.requestRender();
			return;
		}
		if (isPageDownKey(data)) {
			this.scroll += 8;
			this.requestRender();
			return;
		}
		if (data === "g") {
			this.scroll = 0;
			this.requestRender();
			return;
		}
		if (data === "G") {
			this.scroll = Number.MAX_SAFE_INTEGER;
			this.requestRender();
		}
	}

	render(width: number): string[] {
		const contentWidth = Math.max(20, width - 4);
		const renderedLogs =
			this.error === undefined
				? wrapLogLines(this.lines.length === 0 ? ["No Discord voice logs yet."] : this.lines, contentWidth)
				: wrapLogLines([`Failed to read log: ${this.error}`], contentWidth);
		const maxScroll = Math.max(0, renderedLogs.length - VOICE_LOG_VIEW_ROWS);
		this.scroll = Math.min(Math.max(0, this.scroll), maxScroll);
		const end = Math.min(renderedLogs.length, this.scroll + VOICE_LOG_VIEW_ROWS);
		const footer =
			renderedLogs.length > VOICE_LOG_VIEW_ROWS
				? `${this.scroll + 1}-${end} of ${renderedLogs.length}`
				: `${renderedLogs.length} line${renderedLogs.length === 1 ? "" : "s"}`;
		const title = this.theme.bold("Discord Voice Logs");
		const state = this.loading ? this.theme.fg("dim", "refreshing") : this.theme.fg("dim", "live tail");
		return renderPlainBox(
			[
				`${title}  ${state}`,
				truncatePlain(this.path, contentWidth),
				"Up/Down scroll  PgUp/PgDn page  r refresh  G bottom  Esc/q close",
				"",
				...renderedLogs.slice(this.scroll, end),
				"",
				this.theme.fg("dim", footer),
			],
			width,
		);
	}

	private async refresh(options: { forceBottom?: boolean } = {}): Promise<void> {
		if (this.loading) return;
		this.loading = true;
		const wasAtBottom = this.scroll === Number.MAX_SAFE_INTEGER || this.scroll >= Math.max(0, this.lines.length - 1);
		try {
			this.lines = await readVoiceLogTail(this.path);
			this.error = undefined;
			if (options.forceBottom !== false && wasAtBottom) this.scroll = Number.MAX_SAFE_INTEGER;
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.loading = false;
			this.requestRender();
		}
	}
}

export async function readVoiceLogTail(path: string, maxBytes = VOICE_LOG_TAIL_BYTES): Promise<string[]> {
	let file: Awaited<ReturnType<typeof open>> | undefined;
	try {
		file = await open(path, "r");
		const stat = await file.stat();
		const length = Math.min(stat.size, maxBytes);
		if (length <= 0) return [];
		const start = stat.size - length;
		const buffer = Buffer.alloc(length);
		await file.read(buffer, 0, length, start);
		let text = buffer.toString("utf8");
		if (start > 0) text = text.slice(Math.max(0, text.indexOf("\n") + 1));
		return text
			.split(/\r?\n/)
			.map((line) => stripAnsi(line).trimEnd())
			.filter((line) => line.length > 0);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return [];
		throw error;
	} finally {
		await file?.close();
	}
}

function wrapLogLines(lines: string[], width: number): string[] {
	const out: string[] = [];
	for (const line of lines) {
		const clean = stripAnsi(line);
		if (clean.length <= width) {
			out.push(clean);
			continue;
		}
		for (let index = 0; index < clean.length; index += width) {
			out.push(clean.slice(index, index + width));
		}
	}
	return out;
}

function renderPlainBox(lines: string[], width: number): string[] {
	const innerWidth = Math.max(20, width - 2);
	const border = `+${"-".repeat(innerWidth)}+`;
	return [
		border,
		...lines.map((line) => {
			const text = truncatePlain(line, innerWidth);
			return `|${text}${" ".repeat(Math.max(0, innerWidth - visibleLength(text)))}|`;
		}),
		border,
	];
}

function truncatePlain(value: string, width: number): string {
	const clean = stripAnsi(value);
	if (visibleLength(clean) <= width) return clean;
	if (width <= 3) return clean.slice(0, width);
	return `${clean.slice(0, Math.max(0, width - 3))}...`;
}

function visibleLength(value: string): number {
	return stripAnsi(value).length;
}

function stripAnsi(value: string): string {
	return value.replace(ANSI_STYLE_SEQUENCE_PATTERN, "");
}

function lastItems<T>(items: T[], count: number): T[] {
	return items.slice(Math.max(0, items.length - count));
}

function isEscapeKey(data: string): boolean {
	return data === "\x1b";
}

function isUpKey(data: string): boolean {
	return data === "\x1b[A";
}

function isDownKey(data: string): boolean {
	return data === "\x1b[B";
}

function isPageUpKey(data: string): boolean {
	return data === "\x1b[5~";
}

function isPageDownKey(data: string): boolean {
	return data === "\x1b[6~";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
