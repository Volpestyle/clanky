// Pure smoke for discord_recent_attachments read-window plumbing (no live Discord, no vision).
// Covers the around/since mutual-exclusion fix, non-negative snowflake bounds, and messageId
// filtering. Uses fake fetchImpls and describe:false so no live Discord or vision model is called.
// Run: pnpm smoke:discord:attachments
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discordRecentAttachments } from "../agent/lib/discord/media.ts";
import { discordReadMessages } from "../agent/lib/discord/rest.ts";

let failures = 0;
function check(label: string, ok: boolean): void {
	console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
	if (!ok) failures += 1;
}

const home = await mkdtemp(join(tmpdir(), "clanky-discord-attachments-"));
const env: NodeJS.ProcessEnv = { ...process.env, CLANKY_HOME: home, DISCORD_BOT_TOKEN: "test-token" };

interface Capture {
	urls: string[];
}

function fakeFetch(messages: unknown[], capture: Capture): typeof fetch {
	return (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		capture.urls.push(url);
		if (url.includes("/messages")) return new Response(JSON.stringify(messages), { status: 200 });
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
}

function message(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
	return { id, channel_id: "chan1", content: "", attachments: [], embeds: [], ...over };
}

function paramOf(url: string, key: string): string | null {
	return new URL(url).searchParams.get(key);
}

function pngBytes(): Buffer {
	const png = Buffer.alloc(24);
	Buffer.from("89504e470d0a1a0a", "hex").copy(png, 0);
	png.writeUInt32BE(3, 16);
	png.writeUInt32BE(5, 20);
	return png;
}

// --- A: messageId + since no longer collides into an illegal around+since read -------------
{
	const capture: Capture = { urls: [] };
	let threw = false;
	try {
		await discordRecentAttachments(
			{ channelId: "chan1", messageId: "111", since: "24h", describe: false },
			{ env, fetchImpl: fakeFetch([], capture) },
		);
	} catch {
		threw = true;
	}
	check("messageId + since does not throw", !threw);
	const readUrl = capture.urls.find((u) => u.includes("/messages")) ?? "";
	check("around dropped when a time window is present", paramOf(readUrl, "around") === null);
}

// --- B: direct reads tolerate around when a time window is present --------------------------
{
	const capture: Capture = { urls: [] };
	let threw = false;
	try {
		await discordReadMessages(
			{ channelId: "chan1", around: "111", since: "2015-01-01T00:00:00Z", until: "now", limit: 2 },
			{ env, fetchImpl: fakeFetch([message("111"), message("222")], capture) },
		);
	} catch {
		threw = true;
	}
	const readUrl = capture.urls.find((u) => u.includes("/messages")) ?? "";
	check("direct read around + window does not throw", !threw);
	check("direct read drops around when windowed", paramOf(readUrl, "around") === null);
}

// --- C: a pre-Discord-epoch until clamps to a non-negative snowflake (no 400) ---------------
{
	const capture: Capture = { urls: [] };
	await discordRecentAttachments(
		{ channelId: "chan1", until: "2000-01-01T00:00:00Z", describe: false },
		{ env, fetchImpl: fakeFetch([], capture) },
	);
	const readUrl = capture.urls.find((u) => u.includes("/messages")) ?? "";
	const before = paramOf(readUrl, "before");
	check("pre-epoch until produces a before param", before !== null);
	check("before snowflake is non-negative", before !== null && BigInt(before) >= 0n);
}

// --- D: without a time window, messageId still filters to the anchor message ----------------
{
	const capture: Capture = { urls: [] };
	const result = await discordRecentAttachments(
		{ channelId: "chan1", messageId: "111", describe: false },
		{ env, fetchImpl: fakeFetch([message("111"), message("222")], capture) },
	);
	check("messageId filters to the single anchor message", result.scannedMessageCount === 1);
	check("targetMessageId reported when filtering", result.targetMessageId === "111");
	const readUrl = capture.urls.find((u) => u.includes("/messages")) ?? "";
	check("around=messageId used on the non-window path", paramOf(readUrl, "around") === "111");
}

// --- E: with a time window, messageId no longer narrows the result set ----------------------
{
	const capture: Capture = { urls: [] };
	// since at the Discord epoch keeps the snowflake lower bound at 0 so the fixture ids qualify;
	// the assertion is about the window overriding messageId filtering, not snowflake math.
	const result = await discordRecentAttachments(
		{ channelId: "chan1", messageId: "111", since: "2015-01-01T00:00:00Z", describe: false },
		{ env, fetchImpl: fakeFetch([message("111"), message("222")], capture) },
	);
	check("time window keeps all scanned messages", result.scannedMessageCount === 2);
	check("targetMessageId omitted when a window overrides it", result.targetMessageId === undefined);
}

// --- F: now, date-only ISO, and month/day dates are valid explicit day bounds ---------------
{
	const capture: Capture = { urls: [] };
	await discordRecentAttachments(
		{ channelId: "chan1", until: "now", describe: false },
		{ env, fetchImpl: fakeFetch([], capture) },
	);
	const readUrl = capture.urls.find((u) => u.includes("/messages")) ?? "";
	check("until=now produces a before param", paramOf(readUrl, "before") !== null);
}
{
	const capture: Capture = { urls: [] };
	await discordRecentAttachments(
		{ channelId: "chan1", until: "June 24", describe: false },
		{ env, fetchImpl: fakeFetch([], capture) },
	);
	const readUrl = capture.urls.find((u) => u.includes("/messages")) ?? "";
	check("month/day until is accepted", paramOf(readUrl, "before") !== null);
}
{
	const capture: Capture = { urls: [] };
	await discordRecentAttachments(
		{ channelId: "chan1", until: "2026-06-24", describe: false },
		{ env, fetchImpl: fakeFetch([], capture) },
	);
	const readUrl = capture.urls.find((u) => u.includes("/messages")) ?? "";
	check("date-only ISO until is accepted", paramOf(readUrl, "before") !== null);
}

// --- G: repeated media reads reuse the same downloaded artifact -----------------------------
{
	const mediaBytes = pngBytes();
	const mediaUrl = "https://example.test/cat.png";
	const mediaMessages = [
		message("333", {
			attachments: [
				{
					id: "a333",
					url: mediaUrl,
					filename: "cat.png",
					content_type: "image/png",
					size: mediaBytes.length,
					width: 3,
					height: 5,
				},
			],
		}),
	];
	const capture: Capture = { urls: [] };
	const fetchImpl = (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		capture.urls.push(url);
		if (url.includes("/messages")) return new Response(JSON.stringify(mediaMessages), { status: 200 });
		if (url === mediaUrl) {
			return new Response(new Uint8Array(mediaBytes), {
				headers: { "content-type": "image/png", "content-length": String(mediaBytes.length) },
			});
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
	const first = await discordRecentAttachments(
		{ channelId: "chan1", limit: 1, mediaLimit: 1, download: true, describe: false },
		{ env, fetchImpl },
	);
	const second = await discordRecentAttachments(
		{ channelId: "chan1", limit: 1, mediaLimit: 1, download: true, describe: false },
		{ env, fetchImpl },
	);
	const firstPath = first.media[0]?.downloaded?.path;
	const secondPath = second.media[0]?.downloaded?.path;
	const mediaFetchCount = capture.urls.filter((url) => url === mediaUrl).length;
	check("repeated media read fetched bytes only once", mediaFetchCount === 1);
	check("repeated media read reused cached artifact path", firstPath !== undefined && firstPath === secondPath);
	check("cached artifact exists", secondPath !== undefined && (await stat(secondPath)).size === mediaBytes.length);
}

console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
await rm(home, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
