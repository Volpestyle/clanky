// Offline smoke for the discord.js-REST-backed Discord REST layer: 429s honor
// Retry-After and retry, 5xx retries, 4xx errors keep the familiar message
// shape, both credential kinds set the right auth header, and the recent
// activity fan-out bounds concurrency and surfaces per-channel failures.
// Run: node test/discord-rest-retry-smoke.ts
import {
	discordReadMessages,
	discordRecentActivity,
	discordWhoami,
} from "../agent/lib/discord/rest.ts";

let failures = 0;
function check(label: string, ok: boolean): void {
	console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
	if (!ok) failures += 1;
}

const env: NodeJS.ProcessEnv = { DISCORD_BOT_TOKEN: "test-token" };

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
	return new Response(JSON.stringify(body), {
		status: init.status ?? 200,
		headers: { "content-type": "application/json", ...(init.headers ?? {}) },
	});
}

// --- 429 with Retry-After retries and succeeds ------------------------------------------------
{
	let calls = 0;
	const identity = await discordWhoami({
		env,
		fetchImpl: (async () => {
			calls += 1;
			if (calls === 1) {
				return jsonResponse(
					{ message: "You are being rate limited.", retry_after: 0.05, global: false },
					{
						status: 429,
						headers: {
							"Retry-After": "0.05",
							"X-RateLimit-Limit": "5",
							"X-RateLimit-Remaining": "0",
							"X-RateLimit-Reset-After": "0.05",
						},
					},
				);
			}
			return jsonResponse({ id: "bot1", username: "clanky" });
		}) as typeof fetch,
	});
	check("429 retried after Retry-After", calls === 2);
	check("429 retry returned the parsed identity", identity.id === "bot1" && identity.username === "clanky");
}

// --- 5xx retries and succeeds ------------------------------------------------------------------
{
	let calls = 0;
	const identity = await discordWhoami({
		env,
		fetchImpl: (async () => {
			calls += 1;
			if (calls === 1) return new Response("upstream broke", { status: 502 });
			return jsonResponse({ id: "bot1", username: "clanky" });
		}) as typeof fetch,
	});
	check("5xx retried", calls === 2);
	check("5xx retry returned the parsed identity", identity.id === "bot1");
}

// --- hard 4xx surfaces with the familiar error shape --------------------------------------------
{
	let error = "";
	await discordWhoami({
		env,
		fetchImpl: (async () => jsonResponse({ message: "Missing Access", code: 50001 }, { status: 403 })) as typeof fetch,
	}).catch((thrown: unknown) => {
		error = thrown instanceof Error ? thrown.message : String(thrown);
	});
	check("4xx failure keeps the Discord API error shape", error.includes("Discord API GET /users/@me failed (403)"));
	check("4xx failure includes the Discord message", error.includes("Missing Access"));
}

// --- auth headers per credential kind -----------------------------------------------------------
{
	let authHeader: string | null = null;
	await discordWhoami({
		env,
		fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
			authHeader = new Headers(init?.headers).get("authorization");
			return jsonResponse({ id: "bot1", username: "clanky" });
		}) as typeof fetch,
	});
	check("bot token sends Bot-prefixed auth header", authHeader === "Bot test-token");
}
{
	let authHeader: string | null = null;
	await discordWhoami({
		env: { ...env, CLANKY_DISCORD_CREDENTIAL_KIND: "user-token" },
		fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
			authHeader = new Headers(init?.headers).get("authorization");
			return jsonResponse({ id: "u1", username: "clanky" });
		}) as typeof fetch,
	});
	check("user token sends bare auth header", authHeader === "test-token");
}

// --- query params still reach the wire ----------------------------------------------------------
{
	let readUrl = "";
	await discordReadMessages(
		{ channelId: "c1", limit: 3, before: "999" },
		{
			env,
			fetchImpl: (async (input: string | URL | Request) => {
				readUrl = String(input);
				return jsonResponse([]);
			}) as typeof fetch,
		},
	);
	const params = new URL(readUrl).searchParams;
	check("read messages hits the channel route", readUrl.includes("/channels/c1/messages"));
	check("read messages passes limit and before params", params.get("limit") === "3" && params.get("before") === "999");
}

// --- recent activity: bounded fan-out + surfaced per-channel failures ---------------------------
{
	const channelCount = 8;
	const channels = Array.from({ length: channelCount }, (_item, index) => ({
		id: `c${index}`,
		name: `general-${index}`,
		type: 0,
		last_message_id: "1440000000000000000",
	}));
	let inflight = 0;
	let maxInflight = 0;
	const activity = await discordRecentActivity(
		{ guildId: "g1", since: "2015-01-01T00:00:00Z", channelLimit: channelCount, messageLimit: 2 },
		{
			env,
			fetchImpl: (async (input: string | URL | Request) => {
				const href = String(input);
				if (href.includes("/guilds/g1/channels")) return jsonResponse(channels);
				inflight += 1;
				maxInflight = Math.max(maxInflight, inflight);
				await new Promise((resolve) => setTimeout(resolve, 20));
				inflight -= 1;
				if (href.includes("/channels/c3/messages")) {
					return jsonResponse({ message: "Missing Access", code: 50001 }, { status: 403 });
				}
				const channelId = /\/channels\/(c\d+)\/messages/.exec(href)?.[1] ?? "c?";
				return jsonResponse([
					{
						id: "1440000000000000001",
						channel_id: channelId,
						content: `hi from ${channelId}`,
						author: { id: "u1", username: "paul" },
						timestamp: "2026-06-19T10:00:00.000Z",
						attachments: [],
						embeds: [],
					},
				]);
			}) as typeof fetch,
		},
	);
	check("recent activity fan-out is concurrency-bounded", maxInflight > 0 && maxInflight <= 5);
	check("recent activity returns the successful channels", activity.channels.length === channelCount - 1);
	check(
		"recent activity surfaces the failed channel",
		activity.failedChannels.length === 1 &&
			activity.failedChannels[0]?.channelId === "c3" &&
			activity.failedChannels[0].error.includes("Missing Access"),
	);
	check("recent activity keeps per-channel messages", activity.channels[0]?.messages[0]?.content.startsWith("hi from") === true);
}

console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
