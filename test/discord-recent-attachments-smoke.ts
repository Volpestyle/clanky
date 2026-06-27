// Pure smoke for discord_recent_attachments read-window plumbing (no live Discord, no vision).
// Covers the around/since mutual-exclusion fix, non-negative snowflake bounds, and messageId
// filtering. Uses a fake fetchImpl and describe:false so no bytes are downloaded and no vision
// model is called. Run: pnpm smoke:discord:attachments
import { discordRecentAttachments } from "../agent/lib/discord/media.ts";

let failures = 0;
function check(label: string, ok: boolean): void {
	console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
	if (!ok) failures += 1;
}

const env: NodeJS.ProcessEnv = { ...process.env, DISCORD_BOT_TOKEN: "test-token" };

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

// --- B: a pre-Discord-epoch until clamps to a non-negative snowflake (no 400) ---------------
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

// --- C: without a time window, messageId still filters to the anchor message ----------------
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

// --- D: with a time window, messageId no longer narrows the result set ----------------------
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

console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
