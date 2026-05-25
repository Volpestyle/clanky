import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChatSessionKey, type ChatSessionKey, ChatSessionStore } from "../src/index.ts";

const root = await mkdtemp(join(tmpdir(), "clanky-messaging-sessions-"));
const storeFile = join(root, "telegram-sessions.json");
const store = new ChatSessionStore(storeFile);

// Platform isolation: same chatId across telegram and discord must be distinct sessions.
const telegramAlpha = await store.reset({ platform: "telegram", chatId: "chat-A" }, "session-tg-A");
const discordAlpha = await store.reset({ platform: "discord", chatId: "chat-A" }, "session-dc-A");
if (telegramAlpha.sessionId === discordAlpha.sessionId) {
	throw new Error("Platform isolation broken: telegram and discord chats share a session");
}
const telegramAlphaLookup = await store.get({ platform: "telegram", chatId: "chat-A" });
const discordAlphaLookup = await store.get({ platform: "discord", chatId: "chat-A" });
if (telegramAlphaLookup?.sessionId !== "session-tg-A") {
	throw new Error("Telegram chat-A lookup did not return the right session");
}
if (discordAlphaLookup?.sessionId !== "session-dc-A") {
	throw new Error("Discord chat-A lookup did not return the right session");
}

// Thread disambiguation: same chat with different threadIds are distinct entries.
await store.reset({ platform: "telegram", chatId: "chat-B" }, "session-bare");
await store.reset({ platform: "telegram", chatId: "chat-B", threadId: "thread-1" }, "session-t1");
await store.reset({ platform: "telegram", chatId: "chat-B", threadId: "thread-2" }, "session-t2");
const bare = await store.get({ platform: "telegram", chatId: "chat-B" });
const t1 = await store.get({ platform: "telegram", chatId: "chat-B", threadId: "thread-1" });
const t2 = await store.get({ platform: "telegram", chatId: "chat-B", threadId: "thread-2" });
if (bare?.sessionId !== "session-bare") throw new Error("Bare chat-B lookup failed");
if (t1?.sessionId !== "session-t1") throw new Error("Thread-1 lookup failed");
if (t2?.sessionId !== "session-t2") throw new Error("Thread-2 lookup failed");
if (bare.threadId !== undefined) throw new Error("Bare mapping must not have a threadId");
if (t1.threadId !== "thread-1" || t2.threadId !== "thread-2") {
	throw new Error("Thread-keyed mappings lost their threadId");
}

// Critical: undefined threadId must NOT collide with empty-string threadId.
// (keyString encodes ":t=" for empty string but nothing for undefined.)
await store.reset({ platform: "telegram", chatId: "chat-C" }, "session-c-undef");
await store.reset({ platform: "telegram", chatId: "chat-C", threadId: "" }, "session-c-empty");
const cUndef = await store.get({ platform: "telegram", chatId: "chat-C" });
const cEmpty = await store.get({ platform: "telegram", chatId: "chat-C", threadId: "" });
if (cUndef?.sessionId !== "session-c-undef") {
	throw new Error("Undefined threadId lookup returned the wrong session");
}
if (cEmpty?.sessionId !== "session-c-empty") {
	throw new Error("Empty-string threadId lookup returned the wrong session");
}
// (string-literal equality is statically proven above; cUndef.sessionId/cEmpty.sessionId are disjoint by type)
const undefKey = buildChatSessionKey({ platform: "telegram", chatId: "chat-C" });
const emptyKey = buildChatSessionKey({ platform: "telegram", chatId: "chat-C", threadId: "" });
if (undefKey === emptyKey) throw new Error("buildChatSessionKey conflated undefined and empty-string threadId");

// User disambiguation within the same group chat.
await store.reset({ platform: "telegram", chatId: "group-1", userId: "user-1" }, "session-u1");
await store.reset({ platform: "telegram", chatId: "group-1", userId: "user-2" }, "session-u2");
const u1 = await store.get({ platform: "telegram", chatId: "group-1", userId: "user-1" });
const u2 = await store.get({ platform: "telegram", chatId: "group-1", userId: "user-2" });
if (u1?.sessionId !== "session-u1" || u2?.sessionId !== "session-u2") {
	throw new Error("Per-user disambiguation in group failed");
}
const groupNoUser = await store.get({ platform: "telegram", chatId: "group-1" });
if (groupNoUser !== undefined) {
	throw new Error("Lookup with absent userId should not match user-keyed entries");
}

// Combined thread+user keying.
await store.reset(
	{ platform: "telegram", chatId: "forum-1", threadId: "topic-9", userId: "user-7" },
	"session-forum-9-7",
);
const forumHit = await store.get({ platform: "telegram", chatId: "forum-1", threadId: "topic-9", userId: "user-7" });
if (forumHit?.sessionId !== "session-forum-9-7") throw new Error("Forum thread+user lookup failed");
const forumWrongThread = await store.get({
	platform: "telegram",
	chatId: "forum-1",
	threadId: "topic-other",
	userId: "user-7",
});
const forumWrongUser = await store.get({
	platform: "telegram",
	chatId: "forum-1",
	threadId: "topic-9",
	userId: "user-other",
});
if (forumWrongThread !== undefined) throw new Error("Forum lookup matched the wrong threadId");
if (forumWrongUser !== undefined) throw new Error("Forum lookup matched the wrong userId");

// reset() bumps resetCount on an existing key and preserves displayName/consentedAt.
const firstMapping = await store.reset({ platform: "telegram", chatId: "chat-D" }, "session-d-1");
if (firstMapping.resetCount !== 0) throw new Error(`First reset count must be 0, got ${firstMapping.resetCount}`);
const setModeResult = await store.setMode({ platform: "telegram", chatId: "chat-D" }, "dm_relationship");
if (setModeResult?.mode !== "dm_relationship") throw new Error("setMode failed");
if (setModeResult.consentedAt === undefined) throw new Error("setMode should record consentedAt");
const secondMapping = await store.reset({ platform: "telegram", chatId: "chat-D" }, "session-d-2");
if (secondMapping.resetCount !== 1) {
	throw new Error(`Second reset count must be 1, got ${secondMapping.resetCount}`);
}
if (secondMapping.consentedAt !== setModeResult.consentedAt) {
	throw new Error("reset should preserve consentedAt from previous mapping");
}
if (secondMapping.mode !== "dm_relationship") {
	throw new Error("reset should preserve existing mode when no mode is supplied");
}
const thirdMapping = await store.reset({ platform: "telegram", chatId: "chat-D" }, "session-d-3", { mode: "mention" });
if (thirdMapping.mode !== "mention") throw new Error("reset with explicit mode should override existing mode");
if (thirdMapping.resetCount !== 2) {
	throw new Error(`Third reset count must be 2, got ${thirdMapping.resetCount}`);
}

// touch() advances lastUsedAt for existing entries and returns undefined for misses.
const beforeTouch = await store.get({ platform: "telegram", chatId: "chat-D" });
const beforeAt = beforeTouch?.lastUsedAt;
await new Promise<void>((resolve) => setTimeout(resolve, 5));
const touched = await store.touch({ platform: "telegram", chatId: "chat-D" });
if (touched === undefined) throw new Error("touch should return the updated mapping");
if (touched.lastUsedAt === beforeAt) throw new Error("touch did not advance lastUsedAt");
const missTouch = await store.touch({ platform: "telegram", chatId: "does-not-exist" });
if (missTouch !== undefined) throw new Error("touch on missing key should return undefined");

// list() filters by platform and includes everything we wrote.
const allEntries = await store.list();
const telegramEntries = await store.list("telegram");
const discordEntries = await store.list("discord");
if (telegramEntries.length + discordEntries.length !== allEntries.length) {
	throw new Error("Platform-filtered counts do not sum to total");
}
if (discordEntries.length !== 1) throw new Error(`Expected 1 discord entry, got ${discordEntries.length}`);
if (telegramEntries.some((entry) => entry.platform !== "telegram")) {
	throw new Error("Telegram filter returned a non-telegram entry");
}

// remove() drops the entry and is idempotent.
const removed = await store.remove({ platform: "discord", chatId: "chat-A" });
if (!removed) throw new Error("remove should return true on first call");
const removedAgain = await store.remove({ platform: "discord", chatId: "chat-A" });
if (removedAgain) throw new Error("remove on absent key should return false");

// Persistence across "process restart": a fresh store reading the same file sees identical state.
const reopened = new ChatSessionStore(storeFile);
const reopenedAll = await reopened.list();
const liveAll = await store.list();
if (reopenedAll.length !== liveAll.length) {
	throw new Error(`Reopened store size mismatch: ${reopenedAll.length} vs ${liveAll.length}`);
}
const reopenedForum = await reopened.get({
	platform: "telegram",
	chatId: "forum-1",
	threadId: "topic-9",
	userId: "user-7",
});
if (reopenedForum?.sessionId !== "session-forum-9-7") {
	throw new Error("Reopened store lost forum thread+user mapping");
}
const reopenedCUndef = await reopened.get({ platform: "telegram", chatId: "chat-C" });
const reopenedCEmpty = await reopened.get({ platform: "telegram", chatId: "chat-C", threadId: "" });
if (reopenedCUndef?.sessionId !== "session-c-undef" || reopenedCEmpty?.sessionId !== "session-c-empty") {
	throw new Error("Reopened store conflated undefined and empty-string threadId");
}

// Concurrent writes converge to a valid file (last writer wins on disk, all in-memory state present).
const concurrent: Promise<unknown>[] = [];
for (let index = 0; index < 16; index += 1) {
	concurrent.push(store.reset({ platform: "telegram", chatId: `burst-${index}` }, `session-burst-${index}`));
}
await Promise.all(concurrent);
const reopenedAfterBurst = new ChatSessionStore(storeFile);
const burstEntries = (await reopenedAfterBurst.list("telegram")).filter((entry) => entry.chatId.startsWith("burst-"));
if (burstEntries.length !== 16) {
	throw new Error(`Concurrent reset lost entries: expected 16 on-disk, got ${burstEntries.length}`);
}
const persistedRaw = await readFile(storeFile, "utf8");
const parsedAfterBurst = JSON.parse(persistedRaw) as { version: number; mappings: unknown[] };
if (parsedAfterBurst.version !== 1) throw new Error("Persisted file lost version=1");
if (!Array.isArray(parsedAfterBurst.mappings)) throw new Error("Persisted file mappings is not an array");

// Corrupt file path: a brand-new store pointed at garbage should not throw and should behave as empty.
const corruptFile = join(root, "corrupt.json");
await writeFile(corruptFile, "{not valid json", { mode: 0o600 });
const corruptStore = new ChatSessionStore(corruptFile);
const corruptList = await corruptStore.list();
if (corruptList.length !== 0) throw new Error("Corrupt file should load as empty");
await corruptStore.reset({ platform: "telegram", chatId: "post-corrupt" }, "session-post-corrupt");
const corruptHit = await corruptStore.get({ platform: "telegram", chatId: "post-corrupt" });
if (corruptHit?.sessionId !== "session-post-corrupt")
	throw new Error("Store unusable after recovering from corrupt file");

// Wrong-version file: schema-mismatched entries are dropped on load.
const wrongVersionFile = join(root, "wrong-version.json");
await writeFile(
	wrongVersionFile,
	JSON.stringify({ version: 999, mappings: [{ platform: "telegram", chatId: "ignored" }] }),
	{ mode: 0o600 },
);
const wrongVersionStore = new ChatSessionStore(wrongVersionFile);
const wrongVersionList = await wrongVersionStore.list();
if (wrongVersionList.length !== 0) throw new Error("Wrong-version file should load no entries");

// Bad-mapping rejection: invalid records inside an otherwise valid file are skipped.
const mixedFile = join(root, "mixed.json");
const goodMapping = {
	platform: "telegram",
	chatId: "good",
	sessionId: "session-good",
	createdAt: new Date().toISOString(),
	lastUsedAt: new Date().toISOString(),
	resetCount: 0,
	mode: "mention",
};
await writeFile(
	mixedFile,
	JSON.stringify({
		version: 1,
		mappings: [
			goodMapping,
			{ platform: "telegram", chatId: "", sessionId: "missing-chat", createdAt: "", lastUsedAt: "", resetCount: 0 },
			{ platform: "bogus", chatId: "x", sessionId: "x", createdAt: "", lastUsedAt: "", resetCount: 0 },
			"not-an-object",
		],
	}),
	{ mode: 0o600 },
);
const mixedStore = new ChatSessionStore(mixedFile);
const mixedList = await mixedStore.list();
if (mixedList.length !== 1) throw new Error(`Mixed file should yield exactly 1 valid entry, got ${mixedList.length}`);
if (mixedList[0]?.sessionId !== "session-good") throw new Error("Mixed file dropped the good mapping");

await rm(root, { recursive: true, force: true });

const summary: ChatSessionKey = { platform: "telegram", chatId: "chat-A" };
console.log(
	JSON.stringify({
		sampleKey: buildChatSessionKey(summary),
		totalAfterBurst: burstEntries.length,
		platformIsolated: true,
		threadEmptyVsUndef: true,
		corruptRecovered: true,
		mixedKept: mixedList.length,
	}),
);
