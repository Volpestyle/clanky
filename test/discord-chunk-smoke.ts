// Offline smoke for chunkDiscordMessage: over-long lines split into successive
// chunks with no content loss, normal multi-line grouping unchanged, exact
// 2000-char boundaries, and surrogate pairs never split across chunks.
// Run: node test/discord-chunk-smoke.ts
import { chunkDiscordMessage } from "../agent/lib/discord/gateway.ts";

const DISCORD_LIMIT = 2000;

let failures = 0;
function check(label: string, ok: boolean): void {
	console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
	if (!ok) failures += 1;
}

function allWithinLimit(chunks: string[], limit: number): boolean {
	return chunks.every((chunk) => chunk.length > 0 && chunk.length <= limit);
}

function hasDanglingSurrogate(chunk: string): boolean {
	const first = chunk.charCodeAt(0);
	const last = chunk.charCodeAt(chunk.length - 1);
	const startsWithLowSurrogate = first >= 0xdc00 && first <= 0xdfff;
	const endsWithHighSurrogate = last >= 0xd800 && last <= 0xdbff;
	return startsWithLowSurrogate || endsWithHighSurrogate;
}

// --- basics --------------------------------------------------------------------------------
check("empty input produces no chunks", chunkDiscordMessage("   \n  ").length === 0);
check("short input passes through", chunkDiscordMessage("hello\nworld").join("|") === "hello\nworld");

// --- multi-line grouping unchanged ----------------------------------------------------------
{
	const lineA = "a".repeat(999);
	const lineB = "b".repeat(999);
	const lineC = "c".repeat(999);
	const chunks = chunkDiscordMessage(`${lineA}\n${lineB}\n${lineC}`);
	check("999-char lines group two per chunk", chunks.length === 2 && chunks[0] === `${lineA}\n${lineB}` && chunks[1] === lineC);
	check("grouped chunks reassemble with newlines", chunks.join("\n") === `${lineA}\n${lineB}\n${lineC}`);
	check("grouped chunks stay within limit", allWithinLimit(chunks, DISCORD_LIMIT));
}
{
	const input = "first\n\nthird";
	check("blank lines preserved inside a group", chunkDiscordMessage(input).join("\n") === input);
}

// --- exact-boundary lines --------------------------------------------------------------------
{
	const exact = "x".repeat(DISCORD_LIMIT);
	const chunks = chunkDiscordMessage(exact);
	check("exactly-limit line is one chunk", chunks.length === 1 && chunks[0] === exact);
	const followed = chunkDiscordMessage(`${exact}\ny`);
	check("exactly-limit line flushes before next line", followed.length === 2 && followed[0] === exact && followed[1] === "y");
}

// --- long single line split with no loss -----------------------------------------------------
{
	const long = "z".repeat(4500);
	const chunks = chunkDiscordMessage(long);
	check("long line splits into full chunks", chunks.length === 3 && chunks[0]?.length === DISCORD_LIMIT && chunks[1]?.length === DISCORD_LIMIT);
	check("long line loses no content", chunks.join("") === long);
	check("long line chunks stay within limit", allWithinLimit(chunks, DISCORD_LIMIT));
}
{
	// The tail of a split line stays open so following short lines group with it.
	const long = "z".repeat(2500);
	const chunks = chunkDiscordMessage(`${long}\ntail`);
	check("split-line tail groups with next line", chunks.length === 2 && chunks[1] === `${"z".repeat(500)}\ntail`);
	check("split line plus tail loses no content", chunks.join("") === `${long}\ntail`);
}

// --- mixed document: nothing dropped ---------------------------------------------------------
{
	const doc = ["intro", "m".repeat(5000), "middle", "n".repeat(2001), "outro"].join("\n");
	const chunks = chunkDiscordMessage(doc);
	const totalPayload = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const newlineBudget = doc.split("\n").length - 1;
	check("mixed document chunks stay within limit", allWithinLimit(chunks, DISCORD_LIMIT));
	// Every non-newline character survives; only line separators at chunk borders drop.
	check("mixed document loses no non-newline content", totalPayload >= doc.length - newlineBudget);
	check("mixed document keeps all letters", chunks.join("\n").replace(/\n/g, "") === doc.replace(/\n/g, ""));
}

// --- unicode: never split mid-surrogate-pair -------------------------------------------------
{
	// "x" prefix makes the 2000-unit boundary fall inside an emoji surrogate pair.
	const long = `x${"\u{1F600}".repeat(1500)}`;
	const chunks = chunkDiscordMessage(long);
	check("surrogate input loses no content", chunks.join("") === long);
	check("surrogate input chunks stay within limit", allWithinLimit(chunks, DISCORD_LIMIT));
	check("no chunk starts or ends mid-surrogate-pair", chunks.every((chunk) => !hasDanglingSurrogate(chunk)));
	check("surrogate-safe chunk backs off one unit", chunks[0]?.length === DISCORD_LIMIT - 1);
}

// --- custom limit sanity ---------------------------------------------------------------------
{
	const chunks = chunkDiscordMessage("abcdefghij\nkl", 5);
	check("custom limit splits long line", chunks.join("|") === "abcde|fghij|kl");
	check("custom limit chunks stay within limit", allWithinLimit(chunks, 5));
}

console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
