// Live end-to-end verification of Clanky's free-will Discord text presence
// (SPEC.md §5.2, VUH-242). Drives the real gateway with a second Discord
// identity (CLANKY_VERIFY_USER_TOKEN) and asserts observable behavior over
// REST: chatter is ignored, wake-name / mention / reply / DM are accepted and
// answered, and a short follow-up lands inside the engagement window.
//
// Acceptance *reasons* are asserted behaviorally here; cross-check the exact
// `[discord] accepted reason=...` lines in the face pane (see the
// clanky-gateway-debug skill) when a case fails unexpectedly.
//
// Requires in .env.local (or process env):
//   DISCORD_BOT_TOKEN / CLANKY_DISCORD_TOKEN   bot credential (read + identity)
//   CLANKY_VERIFY_USER_TOKEN                   stimulus user credential
//   CLANKY_DISCORD_ALLOWED_GUILD_IDS           target guild (first id)
//   CLANKY_DISCORD_ALLOWED_CHANNEL_IDS         target channel (first id)
//
//   CLANKY_VERIFY_REPLY_TIMEOUT_MS    positive-case reply wait (default 120000)
//   CLANKY_VERIFY_NEGATIVE_WINDOW_MS  ignore-case quiet window (default 75000)
//   CLANKY_VERIFY_LOG                 JSONL path (default ~/.clanky/verify/discord-presence-live-verify.jsonl)
//
// Evidence lands under ~/.clanky/verify (the agent data home), NOT .output —
// .output is eve's Nitro build dir and is wiped on every `eve dev` rebuild.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const API = "https://discord.com/api/v10";

interface DiscordMessage {
	id: string;
	content: string;
	author: { id: string; bot?: boolean; username?: string };
	channel_id: string;
}

interface CaseResult {
	name: string;
	ok: boolean;
	detail: string;
	at: string;
	elapsedMs: number;
}

async function loadEnvLocal(path: string): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	const raw = await readFile(path, "utf8").catch(() => "");
	for (const line of raw.split("\n")) {
		const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
		if (match) out[match[1]] = match[2].replace(/^["']|["']$/g, "");
	}
	return out;
}

const fileEnv = await loadEnvLocal(new URL("../.env.local", import.meta.url).pathname);
function config(name: string): string | undefined {
	const value = process.env[name] ?? fileEnv[name];
	return value !== undefined && value.length > 0 ? value : undefined;
}

const botToken = config("CLANKY_DISCORD_TOKEN") ?? config("DISCORD_BOT_TOKEN");
// Clanky's credential may be a bot token (default) or a user token (Go Live,
// CLANKY_DISCORD_CREDENTIAL_KIND=user-token); user tokens take no Bot prefix.
const clankyAuthHeader = config("CLANKY_DISCORD_CREDENTIAL_KIND") === "user-token" ? `${botToken}` : `Bot ${botToken}`;
const userToken = config("CLANKY_VERIFY_USER_TOKEN");
const guildId = config("CLANKY_DISCORD_ALLOWED_GUILD_IDS")?.split(",")[0]?.trim();
const channelId = config("CLANKY_DISCORD_ALLOWED_CHANNEL_IDS")?.split(",")[0]?.trim();
if (!botToken || !userToken || !guildId || !channelId) {
	console.error("FAIL: missing DISCORD_BOT_TOKEN / CLANKY_VERIFY_USER_TOKEN / allowed guild+channel ids");
	process.exit(1);
}

const envReplyTimeout = Number(config("CLANKY_VERIFY_REPLY_TIMEOUT_MS") ?? "");
const envNegativeWindow = Number(config("CLANKY_VERIFY_NEGATIVE_WINDOW_MS") ?? "");
const replyTimeoutMs = Number.isFinite(envReplyTimeout) && envReplyTimeout > 0 ? envReplyTimeout : 120_000;
const negativeWindowMs = Number.isFinite(envNegativeWindow) && envNegativeWindow > 0 ? envNegativeWindow : 75_000;
const logPath = config("CLANKY_VERIFY_LOG") ?? join(homedir(), ".clanky", "verify", "discord-presence-live-verify.jsonl");

async function discordRequest<T>(
	auth: { kind: "bot" | "user" },
	method: string,
	path: string,
	body?: unknown,
): Promise<T> {
	const headers: Record<string, string> = {
		Authorization: auth.kind === "bot" ? clankyAuthHeader : `${userToken}`,
	};
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const res = await fetch(`${API}${path}`, {
		method,
		headers,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
	}
	return (await res.json()) as T;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll for a bot-authored message after `afterId` whose content contains `token`. */
async function waitForReply(inChannelId: string, afterId: string, token: string, timeoutMs: number): Promise<DiscordMessage | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await sleep(5_000);
		const messages = await discordRequest<DiscordMessage[]>(
			{ kind: "bot" },
			"GET",
			`/channels/${inChannelId}/messages?after=${afterId}&limit=50`,
		);
		const hit = messages.find((m) => m.author.id === botUser.id && m.content.includes(token));
		if (hit) return hit;
	}
	return null;
}

const botUser = await discordRequest<{ id: string; username: string }>({ kind: "bot" }, "GET", "/users/@me");
const verifyUser = await discordRequest<{ id: string; username: string }>({ kind: "user" }, "GET", "/users/@me");
console.log(`[verify] bot=${botUser.username} (${botUser.id}) stimulus=${verifyUser.username} (${verifyUser.id})`);
console.log(`[verify] guild=${guildId} channel=${channelId} replyTimeout=${replyTimeoutMs}ms negativeWindow=${negativeWindowMs}ms`);

await mkdir(dirname(logPath), { recursive: true });
const results: CaseResult[] = [];
async function record(name: string, ok: boolean, detail: string, startedMs: number): Promise<void> {
	const result: CaseResult = { name, ok, detail, at: new Date(startedMs).toISOString(), elapsedMs: Date.now() - startedMs };
	results.push(result);
	await appendFile(logPath, `${JSON.stringify(result)}\n`);
	console.log(`[verify] ${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
}

const run = Date.now().toString(36);

// Case 1: plain chatter with no wake/mention and no prior engagement is
// ignored. Runs first so no engagement window is open for the verify user.
{
	const started = Date.now();
	const stimulus = await discordRequest<DiscordMessage>({ kind: "user" }, "POST", `/channels/${channelId}/messages`, {
		content: "anyone know a good spot for lunch around here",
	});
	await sleep(negativeWindowMs);
	const messages = await discordRequest<DiscordMessage[]>(
		{ kind: "bot" },
		"GET",
		`/channels/${channelId}/messages?after=${stimulus.id}&limit=50`,
	);
	const botReplies = messages.filter((m) => m.author.id === botUser.id);
	await record(
		"chatter_ignored",
		botReplies.length === 0,
		botReplies.length === 0 ? `quiet for ${negativeWindowMs}ms` : `unexpected reply: ${botReplies[0].content.slice(0, 80)}`,
		started,
	);
}

// Case 2: wake-name address ("clanky, ...") is accepted and answered.
let wakeReply: DiscordMessage | null = null;
{
	const started = Date.now();
	const token = `WAKE_OK_${run}`;
	const stimulus = await discordRequest<DiscordMessage>({ kind: "user" }, "POST", `/channels/${channelId}/messages`, {
		content: `hey clanky, quick check: reply with exactly ${token}`,
	});
	wakeReply = await waitForReply(channelId, stimulus.id, token, replyTimeoutMs);
	await record("wake_name", wakeReply !== null, wakeReply ? `reply in ${Date.now() - started}ms` : "no reply before timeout", started);
}

// Case 3: short follow-up without wake/mention inside the engagement window.
{
	const started = Date.now();
	const token = `WINDOW_OK_${run}`;
	const stimulus = await discordRequest<DiscordMessage>({ kind: "user" }, "POST", `/channels/${channelId}/messages`, {
		content: `thanks! one more: reply with exactly ${token}`,
	});
	const reply = await waitForReply(channelId, stimulus.id, token, replyTimeoutMs);
	await record("engagement_window", reply !== null, reply ? `reply in ${Date.now() - started}ms` : "no reply before timeout", started);
}

// Case 4: platform @mention is accepted and answered.
{
	const started = Date.now();
	const token = `MENTION_OK_${run}`;
	const stimulus = await discordRequest<DiscordMessage>({ kind: "user" }, "POST", `/channels/${channelId}/messages`, {
		content: `<@${botUser.id}> reply with exactly ${token}`,
	});
	const reply = await waitForReply(channelId, stimulus.id, token, replyTimeoutMs);
	await record("platform_mention", reply !== null, reply ? `reply in ${Date.now() - started}ms` : "no reply before timeout", started);
}

// Case 5: replying to one of Clanky's own messages is accepted and answered.
{
	const started = Date.now();
	const token = `REPLY_OK_${run}`;
	if (wakeReply === null) {
		await record("reply_to_self", false, "skipped: no earlier Clanky message to reply to", started);
	} else {
		const stimulus = await discordRequest<DiscordMessage>({ kind: "user" }, "POST", `/channels/${channelId}/messages`, {
			content: `following up on this: reply with exactly ${token}`,
			message_reference: { message_id: wakeReply.id, channel_id: channelId, guild_id: guildId },
		});
		const reply = await waitForReply(channelId, stimulus.id, token, replyTimeoutMs);
		await record("reply_to_self", reply !== null, reply ? `reply in ${Date.now() - started}ms` : "no reply before timeout", started);
	}
}

// Case 6: a DM is accepted and answered.
{
	const started = Date.now();
	const token = `DM_OK_${run}`;
	const dm = await discordRequest<{ id: string }>({ kind: "user" }, "POST", "/users/@me/channels", {
		recipient_id: botUser.id,
	});
	const stimulus = await discordRequest<DiscordMessage>({ kind: "user" }, "POST", `/channels/${dm.id}/messages`, {
		content: `clanky dm check: reply with exactly ${token}`,
	});
	const reply = await waitForReply(dm.id, stimulus.id, token, replyTimeoutMs);
	await record("dm", reply !== null, reply ? `reply in ${Date.now() - started}ms` : "no reply before timeout", started);
}

const failed = results.filter((r) => !r.ok);
console.log(`[verify] done: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
