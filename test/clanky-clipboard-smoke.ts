import { clankyNativeClipboardArgv, clankyOsc52Sequence, writeClankyClipboard } from "../agent/lib/clanky-clipboard.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const plain = clankyOsc52Sequence("hi", {});
assert(plain === `\x1b]52;c;${Buffer.from("hi").toString("base64")}\x07`, "plain OSC 52 should base64-encode the payload");

const tmux = clankyOsc52Sequence("hi", { TMUX: "/tmp/tmux-501/default,1,0" });
assert(tmux.startsWith("\x1bPtmux;\x1b\x1b]52;c;") && tmux.endsWith("\x1b\\"), "tmux sessions should wrap OSC 52 in passthrough");

const screen = clankyOsc52Sequence("hi", { STY: "1234.pts-0.host" });
assert(screen.startsWith("\x1bP\x1b]52;c;") && screen.endsWith("\x1b\\"), "screen sessions should wrap OSC 52 in DCS passthrough");

assert(clankyNativeClipboardArgv("darwin", {})?.[0] === "pbcopy", "darwin should copy through pbcopy");
assert(clankyNativeClipboardArgv("win32", {})?.[0] === "clip", "win32 should copy through clip");
assert(clankyNativeClipboardArgv("linux", { WAYLAND_DISPLAY: "wayland-0" })?.[0] === "wl-copy", "wayland should copy through wl-copy");
assert(clankyNativeClipboardArgv("linux", {})?.join(" ") === "xclip -selection clipboard", "x11 should copy through xclip");
assert(clankyNativeClipboardArgv("freebsd", {}) === undefined, "unknown platforms should fall back to OSC 52 only");

let written = "";
await writeClankyClipboard("payload", (chunk) => { written += chunk; }, {}, "freebsd");
assert(written.includes("\x1b]52;c;"), "writeClankyClipboard should always emit OSC 52 to the terminal");

console.log("clanky-clipboard-smoke: ok");
