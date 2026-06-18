// Pure smoke for Clanky's Discord free-will gate (no credentials, no network).
// Covers wake-name matching, the acceptance decision, [SKIP], and the
// engagement window. Run: pnpm smoke:discord
import {
	type DiscordAcceptanceDecision,
	type DiscordInboundMessage,
	decideDiscordInbound,
	EngagementTracker,
	isSkipReplyText,
} from "../agent/lib/discord/acceptance.ts";
import { parseBridgeCommand } from "../agent/lib/discord/host.ts";
import { detectVoiceIntent } from "../agent/lib/discord/voice-intent.ts";
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

// --- voice intent --------------------------------------------------------
check("'clanky hop in vc' -> join", detectVoiceIntent("clanky hop in vc") === "join");
check("'yo clank join the call' -> join", detectVoiceIntent("yo clank join the call") === "join");
check("'clanky get in voice chat' -> join", detectVoiceIntent("clanky get in voice chat") === "join");
check("'clanky leave vc' -> leave", detectVoiceIntent("clanky leave vc") === "leave");
check("'clank hop out of the call' -> leave", detectVoiceIntent("clank hop out of the call") === "leave");
check("'what did you think of the vc earlier' is not an intent", detectVoiceIntent("what about the vc earlier") === null);
check("'how are you' has no voice intent", detectVoiceIntent("how are you") === null);

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
