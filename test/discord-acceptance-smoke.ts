// Pure smoke for Clanky's Discord free-will gate (no credentials, no network).
// Covers wake-name matching, the acceptance decision, [SKIP], and the
// engagement window. Run: pnpm smoke:discord
import {
	type DiscordAcceptanceDecision,
	type DiscordInboundMessage,
	decideDiscordInbound,
	EngagementTracker,
	isSkipReplyText,
	parseDiscordIdAllowlist,
	resolveDiscordAllowDms,
} from "../agent/lib/discord/acceptance.ts";
import {
	formatVoiceIntentFailure,
	formatVoiceIntentSuccess,
	isDiscordSelfMessage,
	parseBridgeCommand,
	RecentDiscordMessageIds,
	shouldCatchUpVoiceIntentMessage,
} from "../agent/lib/discord/host.ts";
import { extractDiscordMemoryCandidates } from "../agent/lib/discord/memory.ts";
import { buildPresenceSessionMessage } from "../agent/lib/discord/presence-payload.ts";
import {
	formatCompactPresencePrompt,
	formatPresencePrompt,
	summarizePresencePromptForMirror,
} from "../agent/lib/discord/prompt.ts";
import { applyEnvUpserts } from "../agent/lib/discord/env-file.ts";
import { resolveDiscordCredentialKind } from "../agent/lib/discord/gateway.ts";
import { detectVoiceIntent } from "../agent/lib/discord/voice-intent.ts";
import {
	buildDiscordStreamKey,
	deriveDiscordStreamWatchDaveChannelId,
} from "../agent/lib/voice/discordStreamDiscovery.ts";
import { DEFAULT_DISCORD_WAKE_NAMES, resolveWakeNameMatch } from "../agent/lib/discord/wake-names.ts";

let failures = 0;
function check(label: string, ok: boolean): void {
	console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
	if (!ok) failures += 1;
}

function msg(over: Partial<DiscordInboundMessage>): DiscordInboundMessage {
	return {
		externalMessageId: "m1",
		channelId: "c1",
		authorId: "u1",
		text: "",
		kind: "channel",
		mentionsSelf: false,
		...over,
	};
}

function snowflakeAt(timestampMs: number): string {
	return String((BigInt(timestampMs) - 1_420_070_400_000n) << 22n);
}

const NEVER = {
	isEngaged: () => false,
	isKnownSelfMessage: () => false,
};

function reason(d: DiscordAcceptanceDecision): string {
	return d.reason;
}

// --- wake-name matching --------------------------------------------------
const addressed = (t: string) => resolveWakeNameMatch(t, DEFAULT_DISCORD_WAKE_NAMES);
check("'hey clanky' is addressed", addressed("hey clanky").addressed);
check("'yo clank whats good' is addressed", addressed("yo clank whats good").addressed);
check("'hi clankey' typo is addressed", addressed("hi clankey").addressed);
check("'clanker can you check this' is addressed (leading)", addressed("clanker can you check this").addressed);
check("'ok so anyway, clanky what now' is addressed (vocative)", addressed("ok so anyway, clanky what now").addressed);
check(
	"'did you see what clanky did' is mention-only",
	!addressed("did you see what clanky did").addressed && addressed("did you see what clanky did").mentioned,
);
check("'what time is it' is neither", !addressed("what time is it").mentioned);

// --- acceptance decision -------------------------------------------------
check("dm accepts", reason(decideDiscordInbound(msg({ kind: "dm", text: "hi" }), NEVER)) === "dm");
check(
	"@mention accepts",
	reason(decideDiscordInbound(msg({ mentionsSelf: true, text: "do the thing" }), NEVER)) === "platform_mention",
);
check(
	"wake address accepts",
	reason(decideDiscordInbound(msg({ text: "hey clanky ship it" }), NEVER)) === "name_address",
);
check(
	"wake mention accepts",
	reason(decideDiscordInbound(msg({ text: "did clanky ship it yet" }), NEVER)) === "name_mention",
);
check(
	"reply-to-self accepts",
	reason(
		decideDiscordInbound(msg({ text: "thanks", replyToExternalMessageId: "self-7" }), {
			...NEVER,
			isKnownSelfMessage: (id) => id === "self-7",
		}),
	) === "reply_to_self",
);
check(
	"engaged follow-up accepts without re-mention",
	reason(decideDiscordInbound(msg({ text: "and also this" }), { ...NEVER, isEngaged: () => true })) ===
		"recent_engagement",
);
{
	const d = decideDiscordInbound(msg({ text: "random unrelated chatter" }), NEVER);
	check("unaddressed + unengaged is ignored", !d.accepted && d.reason === "not_engaged_no_mention");
}
{
	const d = decideDiscordInbound(msg({ authorId: "self", text: "hey clanky" }), { ...NEVER, selfUserId: "self" });
	check("own message never accepts", !d.accepted && d.reason === "self_message");
	check("own message is detected before history recording", isDiscordSelfMessage(msg({ authorId: "self" }), "self"));
	check("other message is not self", !isDiscordSelfMessage(msg({ authorId: "u2" }), "self"));
}
{
	const d = decideDiscordInbound(msg({ authorIsBot: true, text: "hey clanky" }), NEVER);
	check("other bot ignored by default", !d.accepted && d.reason === "ignored_bot");
}
{
	const bound = { ...NEVER, boundConversationId: "c1" };
	check(
		"bound conversation accepts in-channel",
		reason(decideDiscordInbound(msg({ text: "anything" }), bound)) === "bound_conversation",
	);
	const d = decideDiscordInbound(msg({ channelId: "other", text: "anything" }), bound);
	check("bound conversation ignores out-of-channel", !d.accepted);
}
{
	const allowed = decideDiscordInbound(msg({ guildId: "g1", text: "hey clanky" }), {
		...NEVER,
		allowedGuildIds: ["g1"],
	});
	check("allowed guild accepts normally", reason(allowed) === "name_address");
	const d = decideDiscordInbound(msg({ guildId: "g2", text: "hey clanky" }), {
		...NEVER,
		allowedGuildIds: ["g1"],
	});
	check("blocked guild rejects before wake", !d.accepted && d.reason === "blocked_guild");
}
{
	const allowed = decideDiscordInbound(msg({ guildId: "g1", channelId: "c1", text: "hey clanky" }), {
		...NEVER,
		allowedChannelIds: ["c1"],
	});
	check("allowed channel accepts normally", reason(allowed) === "name_address");
	const blocked = decideDiscordInbound(msg({ guildId: "g1", channelId: "c2", text: "hey clanky" }), {
		...NEVER,
		allowedChannelIds: ["c1"],
	});
	check("blocked channel rejects before wake", !blocked.accepted && blocked.reason === "blocked_channel");
	const thread = decideDiscordInbound(
		msg({ guildId: "g1", channelId: "thread1", threadId: "thread1", parentId: "c1", text: "hey clanky" }),
		{ ...NEVER, allowedChannelIds: ["c1"] },
	);
	check("thread inherits parent channel allowlist", reason(thread) === "name_address");
}
{
	const d = decideDiscordInbound(msg({ kind: "dm", text: "hi" }), { ...NEVER, allowDms: false });
	check("dm can be disabled by scope", !d.accepted && d.reason === "blocked_dm");
}
{
	const seen = new RecentDiscordMessageIds(2);
	check("inbound dedupe accepts a new Discord message id", seen.remember("m1"));
	check("inbound dedupe rejects the same Discord message id", !seen.remember("m1"));
	seen.remember("m2");
	seen.remember("m3");
	check("inbound dedupe evicts old message ids", seen.remember("m1"));
}

// engagement decisions only re-arm the window when accepted-by-engagement is false
{
	const addr = decideDiscordInbound(msg({ text: "hey clanky" }), NEVER);
	check("address arms engagement", addr.accepted && addr.recordInboundEngagement === true);
	const follow = decideDiscordInbound(msg({ text: "more" }), { ...NEVER, isEngaged: () => true });
	check("engaged follow-up does not re-arm by itself", follow.accepted && follow.recordInboundEngagement === false);
}

// --- [SKIP] --------------------------------------------------------------
check("[SKIP] detected", isSkipReplyText("[SKIP]"));
check("[skip] case-insensitive + trimmed", isSkipReplyText("  [skip]  "));
check("normal reply is not skip", !isSkipReplyText("sure, on it"));

// --- Discord media prompt/payload ---------------------------------------
{
	const mediaMessage = msg({
		text: "clanky what is this?",
		attachments: [
			{
				id: "a1",
				url: "https://cdn.discordapp.com/attachments/c1/m1/photo.png",
				filename: "photo.png",
				contentType: "image/png",
				size: 24,
				width: 3,
				height: 5,
			},
		],
		embeds: [
			{
				provider: "YouTube",
				title: "Preview title",
				url: "https://youtube.com/watch?v=1",
				thumbnailUrl: "https://i.ytimg.com/vi/1/hqdefault.jpg",
			},
		],
	});
	const prompt = formatPresencePrompt(mediaMessage, "platform_mention", "Paul");
	check("presence prompt includes attachment metadata", prompt.includes("photo.png") && prompt.includes("3x5"));
	check("presence prompt includes embed metadata", prompt.includes("YouTube") && prompt.includes("Preview title"));
	check("presence prompt includes author id for scoped memory", prompt.includes("- authorId: u1"));
	const historyPrompt = formatPresencePrompt(mediaMessage, "platform_mention", "Paul", [
		{ author: "vuhlp", text: "hi clankey" },
		{ author: "Clanky", text: "hey vuhlp, what's up?" },
	]);
	check("presence prompt includes gateway history", historyPrompt.includes("- vuhlp: hi clankey"));
	check("presence prompt discourages redundant Discord reads", historyPrompt.includes("do not call discord_read_messages"));
	const compactPrompt = formatCompactPresencePrompt(mediaMessage, "recent_engagement", "Paul", [
		{ author: "vuhlp", text: "hi clankey" },
		{ author: "Clanky", text: "hey vuhlp, what's up?" },
	]);
	check("compact presence prompt keeps Discord ids", compactPrompt.includes("- newestMessageId: m1"));
	check("compact presence prompt keeps skip policy", compactPrompt.includes("exactly [SKIP]"));
	check("compact presence prompt omits long bootstrap contract", !compactPrompt.includes("You are participating in an ongoing Discord chat"));
	check("compact channel prompt keeps small gateway context", compactPrompt.includes("Recent gateway context:"));
	const dmCompactPrompt = formatCompactPresencePrompt({ ...mediaMessage, kind: "dm" }, "dm", "Paul", [
		{ author: "vuhlp", text: "hi clankey" },
	]);
	check("compact DM prompt relies on session history", !dmCompactPrompt.includes("Recent gateway context:"));
	const mirrorSummary = summarizePresencePromptForMirror(compactPrompt);
	check("mirror summary collapses Discord prompt", mirrorSummary === "Discord channel Paul: clanky what is this?");

	const png = Buffer.alloc(24);
	Buffer.from("89504e470d0a1a0a", "hex").copy(png, 0);
	const payload = await buildPresenceSessionMessage(mediaMessage, "platform_mention", "Paul", {
		env: { DISCORD_BOT_TOKEN: "test-token" },
		fetchImpl: async (_url, init) => {
			check(
				"presence payload uses Discord auth for CDN attachment",
				new Headers(init?.headers).get("authorization") === "Bot test-token",
			);
			return new Response(png, {
				headers: { "content-type": "image/png", "content-length": String(png.length) },
			});
		},
	});
	check("presence payload uses structured user content for images", Array.isArray(payload));
	const parts = Array.isArray(payload) ? payload : [];
	check("presence payload keeps text prompt first", parts[0]?.type === "text");
	check("presence payload includes file part", parts.some((part) => part.type === "file"));
	check(
		"presence payload records inline transfer note",
		parts[0]?.type === "text" && parts[0].text.includes("inlined photo.png"),
	);
	const compactPayload = await buildPresenceSessionMessage(msg({ text: "follow-up" }), "recent_engagement", "Paul", {
		mode: "compact",
	});
	check("presence payload supports compact mode", typeof compactPayload === "string" && compactPayload.startsWith("Discord follow-up:"));
}

{
	const largeImageBytes = 26 * 1024 * 1024;
	const largePng = Buffer.alloc(largeImageBytes);
	Buffer.from("89504e470d0a1a0a", "hex").copy(largePng, 0);
	let fetched = false;
	const payload = await buildPresenceSessionMessage(
		msg({
			text: "clanky inspect this screenshot",
			attachments: [
				{
					id: "a-large",
					url: "https://cdn.discordapp.com/attachments/c1/m1/large.png",
					filename: "large.png",
					contentType: "image/png",
					size: largeImageBytes,
					width: 2400,
					height: 1600,
				},
			],
		}),
		"platform_mention",
		"Paul",
		{
			env: { DISCORD_BOT_TOKEN: "test-token" },
			fetchImpl: async () => {
				fetched = true;
				return new Response(largePng, {
					headers: { "content-type": "image/png", "content-length": String(largePng.length) },
				});
			},
		},
	);
	check("presence payload default inline limit fetches >25 MiB images", fetched);
	const parts = Array.isArray(payload) ? payload : [];
	check("presence payload includes >25 MiB image by default", parts.some((part) => part.type === "file"));
}

// --- explicit Discord memory capture ------------------------------------
{
	const callMe = extractDiscordMemoryCandidates(
		msg({ authorName: "James", text: "hey clanky, call me Paul from now on" }),
	);
	check("'call me Paul' captures preferred name", callMe[0]?.fact === "This user wants to be called Paul.");
	check("'call me Paul' is a discord_user memory", callMe[0]?.subjectKind === "discord_user");

	const preference = extractDiscordMemoryCandidates(msg({ authorName: "Paul", text: "clanky please remember I like pie" }));
	check("'remember I like pie' captures preference", preference[0]?.fact === "Paul likes pie.");

	const server = extractDiscordMemoryCandidates(
		msg({ guildId: "g1", text: "clanky remember this server uses Linear for work tracking" }),
	);
	check("'remember this server ...' captures server fact", server[0]?.subjectKind === "discord_server");
	check("server memory keeps guild id", server[0]?.subjectId === "g1");

	check("ordinary chat does not create memory", extractDiscordMemoryCandidates(msg({ text: "I like pie today" })).length === 0);
}

// --- bridge commands (escape to main Clanky) -----------------------------
{
	const direct = parseBridgeCommand("/clanky direct fix the build");
	check("'/clanky direct ...' -> direct", direct?.type === "direct" && direct.prompt === "fix the build");
	const bare = parseBridgeCommand("/clanky hello there");
	check("'/clanky <msg>' -> direct with full text", bare?.type === "direct" && bare.prompt === "hello there");
	check("'/clank new' -> new", parseBridgeCommand("/clank new")?.type === "new");
	check("'/new' -> new", parseBridgeCommand("/new")?.type === "new");
	const compact = parseBridgeCommand("/compact focus area");
	check("'/compact focus' -> compact with focus", compact?.type === "compact" && compact.prompt === "focus area");
	check("'!clanky help' -> help", parseBridgeCommand("!clanky help")?.type === "help");
	check("bare '/clanky' -> help", parseBridgeCommand("/clanky")?.type === "help");
	check("normal chat -> not a bridge command", parseBridgeCommand("just chatting about clanky") === null);
}

// --- credential kind -----------------------------------------------------
check("default credential kind is bot-token", resolveDiscordCredentialKind({}) === "bot-token");
check(
	"user-token credential kind resolves",
	resolveDiscordCredentialKind({ CLANKY_DISCORD_CREDENTIAL_KIND: "user-token" }) === "user-token",
);
check(
	"unknown credential kind falls back to bot-token",
	resolveDiscordCredentialKind({ CLANKY_DISCORD_CREDENTIAL_KIND: "nonsense" }) === "bot-token",
);
check(
	"discord id allowlist parses comma and space separated ids",
	parseDiscordIdAllowlist("g1, g2  g1").join("|") === "g1|g2",
);
check("discord DMs allowed by default", resolveDiscordAllowDms({}) === true);
check("discord DMs can be disabled", resolveDiscordAllowDms({ CLANKY_DISCORD_ALLOW_DMS: "off" }) === false);

// --- .env upsert (TUI token config) --------------------------------------
{
	const replaced = applyEnvUpserts("FOO=1\nDISCORD_BOT_TOKEN=old\n# note\n", {
		DISCORD_BOT_TOKEN: "new",
		CLANKY_DISCORD_CREDENTIAL_KIND: "user-token",
	});
	check("upsert replaces existing key in place", replaced.includes("DISCORD_BOT_TOKEN=new"));
	check("upsert drops the old value", !replaced.includes("DISCORD_BOT_TOKEN=old"));
	check("upsert preserves other lines", replaced.includes("FOO=1") && replaced.includes("# note"));
	check("upsert appends new key", replaced.includes("CLANKY_DISCORD_CREDENTIAL_KIND=user-token"));
	const fromEmpty = applyEnvUpserts("", { DISCORD_BOT_TOKEN: "abc" });
	check("upsert from empty writes the key", fromEmpty === "DISCORD_BOT_TOKEN=abc\n");
	const quoted = applyEnvUpserts("", { CLANKY_VOICE_INSTRUCTIONS: "be brief" });
	check("upsert quotes values with spaces", quoted.includes('CLANKY_VOICE_INSTRUCTIONS="be brief"'));
}

// --- Go Live stream-key helpers ------------------------------------------
check(
	"buildDiscordStreamKey shapes guild:g:c:u",
	buildDiscordStreamKey({ guildId: "g1", channelId: "c1", userId: "u1" }) === "guild:g1:c1:u1",
);
check(
	"dave channel id is rtcServerId - 1",
	deriveDiscordStreamWatchDaveChannelId("100") === "99",
);
check("dave channel id undefined for empty rtcServerId", deriveDiscordStreamWatchDaveChannelId(null) === undefined);
check("dave channel id undefined for non-numeric", deriveDiscordStreamWatchDaveChannelId("abc") === undefined);

// --- voice intent --------------------------------------------------------
check("'clanky hop in vc' -> join", detectVoiceIntent("clanky hop in vc") === "join");
check("'yo clank join the call' -> join", detectVoiceIntent("yo clank join the call") === "join");
check("'clanky get in voice chat' -> join", detectVoiceIntent("clanky get in voice chat") === "join");
check("'clanky leave vc' -> leave", detectVoiceIntent("clanky leave vc") === "leave");
check("'clank hop out of the call' -> leave", detectVoiceIntent("clank hop out of the call") === "leave");
check("'what did you think of the vc earlier' is not an intent", detectVoiceIntent("what about the vc earlier") === null);
check("'how are you' has no voice intent", detectVoiceIntent("how are you") === null);
check("voice join success reply is explicit", formatVoiceIntentSuccess("join") === "Joining VC.");
check("voice leave success reply is explicit", formatVoiceIntentSuccess("leave") === "Left VC.");
check(
	"missing OpenAI voice key gets a friendly Discord reply",
	formatVoiceIntentFailure(
		"join",
		new Error("voice requires CLANKY_OPENAI_API_KEY or OPENAI_API_KEY for the OpenAI realtime agent"),
	) === "I couldn't join VC: voice is configured for OpenAI realtime but no OpenAI API key is available.",
);
check(
	"recent voice intent qualifies for gateway startup catch-up",
	shouldCatchUpVoiceIntentMessage(
		msg({ externalMessageId: snowflakeAt(2_000), text: "Join Vc clanky" }),
		1_000,
	),
);
check(
	"old voice intent is skipped by gateway startup catch-up",
	!shouldCatchUpVoiceIntentMessage(
		msg({ externalMessageId: snowflakeAt(500), text: "Join Vc clanky" }),
		1_000,
	),
);
check(
	"non-voice chat is skipped by gateway startup catch-up",
	!shouldCatchUpVoiceIntentMessage(
		msg({ externalMessageId: snowflakeAt(2_000), text: "clanky what happened" }),
		1_000,
	),
);

// --- engagement window with injected clock -------------------------------
{
	let t = 1_000_000;
	const tracker = new EngagementTracker(60_000, () => t);
	tracker.record("c1", "u1");
	check("engaged immediately after record", tracker.isEngaged("c1", "u1"));
	t += 30_000;
	check("still engaged inside window", tracker.isEngaged("c1", "u1"));
	t += 31_000;
	check("not engaged past window", !tracker.isEngaged("c1", "u1"));
	check("different user not engaged", !tracker.isEngaged("c1", "u2"));
}

console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
