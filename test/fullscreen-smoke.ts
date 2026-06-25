import {
	ClankyFullscreenController,
	EveFrameSplitter,
	type FullscreenOutput,
	clipVisible,
	enterSequence,
	exitSequence,
	fullscreenEnabled,
	fullscreenViable,
	parseFrame,
	renderFrame,
	terminalDimensions,
} from "../agent/lib/clanky-fullscreen.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const ESC = "\x1b";
const CSI = `${ESC}[`;
const frame = (prefix: string, content: string): string => `${CSI}?2026h${prefix}${CSI}0J${content}${CSI}?2026l`;

// clipVisible counts visible characters, not ANSI bytes, and reseals on cut.
assert(clipVisible("abcdef", 3) === "abc", "plain clip cuts at visible width");
assert(clipVisible("語語語", 3) === "語", "wide glyph clipping respects terminal cell width");
assert(clipVisible("a🙂b", 3) === "a🙂", "emoji clipping respects terminal cell width");
const cclip = clipVisible(`${CSI}1mABCDEF${CSI}0m`, 3);
assert(cclip.includes("ABC") && !cclip.includes("DEF") && cclip.endsWith(`${CSI}0m`), "colored clip keeps prefix + reseal");

// parseFrame recovers the previous-live height and content lines.
const f1 = parseFrame(frame("\r", "header line\n"), true);
assert(f1 !== null && f1.prefixLive === 0 && f1.endsWithNewline, "\\r after a newline => prev live 0");
assert(f1 !== null && f1.lines.length === 1 && f1.lines[0] === "header line", "committed-only frame has one line");
const f2 = parseFrame(frame("\r", " > \nstatus"), false);
assert(f2 !== null && f2.prefixLive === 1, "\\r after no newline => prev live 1");
const f3 = parseFrame(frame(`${CSI}2F`, "x\ny\nz"), false);
assert(f3 !== null && f3.prefixLive === 3, "CSI 2F => prev live 3");
assert(parseFrame("just some text\n", true) === null, "non-frame chunk is not parsed");

// The splitter, driven by the EXACT byte frames captured from eve's LiveRegion,
// must separate committed transcript lines from the live prompt/status.
const splitter = new EveFrameSplitter();
const step = (raw: string) => splitter.feed(raw);
// flush(["committed header line"], [])
let r = step(frame("\r", "committed header line\n"));
assert(r !== null && r.committed.length === 0, "first frame releases nothing yet");
// update([" > ", "status line"])  -> header proven committed by this \r (prev ended in newline)
r = step(frame("\r", " > \nstatus line"));
assert(r !== null && r.committed.length === 1 && r.committed[0] === "committed header line", "header is released to transcript");
// update([" > hello", "status line"])  -> prefix CSI 1F proves prev live was 2 (prompt+status), nothing committed
r = step(frame(`${CSI}1F`, " > hello\nstatus line"));
assert(r !== null && r.committed.length === 0, "pure prompt update commits nothing");
// flush(["assistant: hi"], ["status streaming"])
r = step(frame(`${CSI}1F`, "assistant: hi\nstatus streaming"));
assert(r !== null && r.committed.length === 0, "the flush's own commit waits one frame");
// flush(["assistant: more"], ["status streaming"]) -> releases "assistant: hi"
r = step(frame("\r", "assistant: more\nstatus streaming"));
assert(r !== null && r.committed.length === 1 && r.committed[0] === "assistant: hi", "streamed line released to transcript");
// flush(["line A", "line B"], [" > "]) -> releases "assistant: more"
r = step(frame("\r", "line A\nline B\n > "));
assert(r !== null && r.committed.length === 1 && r.committed[0] === "assistant: more", "previous streamed line released");
// update([" > "]) -> releases both committed lines A and B, prompt stays live
r = step(frame("\r", " > "));
assert(r !== null && r.committed.length === 2 && r.committed[1] === "line B", "both committed lines released, prompt stays");
assert(r !== null && r.live.length === 1 && r.live[0] === " > ", "prompt remains the live region");

// renderFrame: transcript fills from the top, live pins to the bottom zone.
const rows = 24;
const cols = 80;
const painted = renderFrame(["assistant: hi"], ["", " ❯ typing", ""], rows, cols);
const regionBottom = rows - 4;
assert(painted.includes(`${CSI}1;1H${CSI}2Kassistant: hi`), "transcript starts at the top of the body");
assert(painted.includes("assistant: hi") && painted.includes(" ❯ typing"), "both committed and live content rendered");
assert(painted.includes(`${CSI}${regionBottom + 1};1H`), "zone divider painted at the zone top row");
assert(!painted.trimEnd().endsWith("\n"), "zone is painted by absolute address, not trailing newline");
const typeaheadPainted = renderFrame(
	[],
	["", "/new  Start a fresh session", "/help  Show available commands", "/fullscreen  Pin the TUI input", " > /", "", "model ctx"],
	rows,
	cols,
);
assert(typeaheadPainted.includes(`${CSI}18;1H`), "typeahead expands the bottom zone upward");
assert(typeaheadPainted.includes("/fullscreen"), "typeahead rows should remain visible in fullscreen");
const collapsedPainted = renderFrame(["assistant: ok"], ["", " > ", "", "model ctx"], rows, cols, 0, 18);
assert(collapsedPainted.includes(`${CSI}18;1H${CSI}2K`), "collapsing typeahead clears the old first suggestion row");
assert(collapsedPainted.includes(`${CSI}20;1H${CSI}2K`), "collapsing typeahead clears the reclaimed rows");
assert(collapsedPainted.includes(`${CSI}1;1H${CSI}2Kassistant: ok`), "collapsed repaint keeps transcript at the body top");
const historyLines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
const scrolledPainted = renderFrame(historyLines, [" > "], 10, cols, 2);
assert(scrolledPainted.includes(`${CSI}1;1H${CSI}2Kline 23`), "positive scroll offset shows older transcript lines");
assert(scrolledPainted.includes("history +2"), "scrolled transcript renders a history marker");

// enter/exit sequences own fullscreen controls without entering the alt buffer.
const entered = enterSequence(["head", "meta"], 24, 80);
assert(entered.includes(`${CSI}r`), "enter resets any previous scroll region");
assert(entered.includes(`${CSI}?1000h`) && entered.includes(`${CSI}?1006h`), "enter enables SGR mouse tracking for wheel scroll");
assert(!entered.includes(`${CSI}?1049h`), "enter does not switch to the alternate buffer");
assert(entered.includes(`${CSI}?25l`), "enter hides the real cursor (eve draws its own block cursor)");
assert(exitSequence(24).includes(`${CSI}?1000l`) && exitSequence(24).includes(`${CSI}?25h`), "exit disables mouse tracking and shows cursor");

// Viability + controller lifecycle.
const tty = (r2: number): FullscreenOutput => ({ isTTY: true, rows: r2, columns: 100, write: () => {} });
assert(!fullscreenViable({ isTTY: false, rows: 50, columns: 100, write: () => {} }), "non-TTY is not viable");
assert(!fullscreenViable(tty(6)), "too-short terminal is not viable");
assert(fullscreenViable(tty(40)), "a roomy TTY is viable");
const liveSized: FullscreenOutput = {
	isTTY: true,
	columns: 999,
	rows: 999,
	getWindowSize: () => [42, 13],
	write: () => {},
};
assert(terminalDimensions(liveSized).columns === 42, "getWindowSize columns override stale output columns");
assert(terminalDimensions(liveSized).rows === 13, "getWindowSize rows override stale output rows");
assert(fullscreenViable(liveSized), "fullscreen viability uses live window size");

const writes: string[] = [];
let mutableSize: readonly [number, number] = [100, 40];
const out: FullscreenOutput = { isTTY: true, getWindowSize: () => mutableSize, write: (d) => writes.push(d) };
const controller = new ClankyFullscreenController(out);
assert(controller.enable(["header-a", "header-b"]) && controller.active, "enable works on a viable terminal");
assert((writes[0] ?? "").includes(`${CSI}?1000h`), "enable emits fullscreen setup");
assert((writes[1] ?? "").includes(`${CSI}1;1H${CSI}2Kheader-a`), "enable seeds the header into the scrollable transcript");
const live1 = controller.remap(frame("\r", "hello\n"));
assert(live1.includes(`${CSI}38;1H`) && live1.includes("hello"), "active controller pins the live region into the bottom zone");
const tallLive = controller.remap(
	frame(
		"\r",
		["/new", "/help", "/fullscreen", "/model", "/harness", "/login", "/effort", " > /", "status"].join("\n"),
	),
);
assert(tallLive.includes(`${CSI}31;1H`), "tall live region moves the zone upward");
const resetOut = controller.remap(`${CSI}3J${CSI}2J${CSI}H`);
assert(resetOut.includes(`${CSI}3J${CSI}r${CSI}?25l`), "clear-all remaps to a fullscreen reset");
assert(resetOut.includes("header-a") && resetOut.includes("header-b"), "fullscreen reset restores the transcript header seed");
assert(resetOut.includes(`${CSI}?1000h`) && resetOut.includes(`${CSI}?1006h`), "fullscreen reset restores mouse tracking");
const afterReset = controller.remap(frame("\r", " > \nstatus"));
assert(!afterReset.includes("/fullscreen"), "fullscreen reset drops stale typeahead zone state");
controller.emitLines(Array.from({ length: 60 }, (_, i) => `history ${i + 1}`));
assert(controller.scrollPage(1), "page-up scroll is handled while active");
assert((writes.at(-1) ?? "").includes("history +"), "scrolling repaints an older transcript viewport");
assert(controller.scrollPage(-1), "page-down scroll is handled while active");
assert(controller.remap("\x1b[?25l") === "\x1b[?25l", "non-frame chunks pass through untouched");
assert(controller.headerRows === 2, "controller reports header rows");
mutableSize = [32, 12];
controller.resize(["narrow"]);
assert((writes.at(-1) ?? "").includes(`${CSI}9;1H`), "resize redraws against the new live rows");
assert((writes.at(-1) ?? "").includes(`${CSI}2m${"─".repeat(32)}${CSI}0m`), "resize redraws against the new live columns");
assert(!controller.toggle() && !controller.active, "toggle disables when active");
assert(controller.remap(frame("\r", "x")) === frame("\r", "x"), "inactive controller passes frames through");

// Opt-in flag.
assert(fullscreenEnabled({ CLANKY_FULLSCREEN: "1" }) && fullscreenEnabled({ CLANKY_FULLSCREEN: "true" }), "1/true enable");
assert(!fullscreenEnabled({}) && !fullscreenEnabled({ CLANKY_FULLSCREEN: "0" }), "unset/0 disable");

console.log("fullscreen-smoke: ok");
