import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendRuntimeFooter,
	buildRuntimeFooter,
	DEFAULT_FOOTER_CONFIG,
	HookRegistry,
	type MessagingHookEvent,
	MirrorRouter,
	PairingStore,
	StickerCache,
} from "../src/index.ts";

const root = await mkdtemp(join(tmpdir(), "clanky-messaging-polish-"));

const pairing = new PairingStore(join(root, "pairing.json"));
const created = await pairing.create({
	platform: "telegram",
	userId: "user-1",
	chatId: "chat-1",
	scopes: ["read", "write"],
});
if (created.state !== "pending" || created.code === undefined) {
	throw new Error("Pairing should start as pending with a code");
}
if (created.code.length !== 6) throw new Error(`Pairing code should be 6 digits, got ${created.code.length}`);
const confirmed = await pairing.confirm(created.code, { confirmedBy: { platform: "telegram", userId: "user-1" } });
if (confirmed === undefined || confirmed.state !== "active") throw new Error("Pairing should confirm to active");
if (confirmed.code !== undefined) throw new Error("Confirmed pairing should drop the code");
const isActive = await pairing.isActive("telegram", "user-1");
if (!isActive) throw new Error("isActive should return true after confirmation");
const wrongCode = await pairing.confirm("000000", { confirmedBy: { platform: "telegram", userId: "user-1" } });
if (wrongCode !== undefined) throw new Error("Wrong code should not confirm");
const revoked = await pairing.revoke(confirmed.id);
if (!revoked) throw new Error("Revoke should succeed");
if (await pairing.isActive("telegram", "user-1")) throw new Error("Revoked pairing should not be active");

const mirror = new MirrorRouter(join(root, "mirror.json"));
const route = await mirror.create({
	source: { platform: "telegram", chatId: "tg-chat-1" },
	destinations: [
		{ platform: "discord", chatId: "dc-chat-1" },
		{ platform: "discord", chatId: "dc-chat-2", threadId: "thread-9" },
	],
	prefix: "[mirror] ",
});
if (route.destinations.length !== 2) throw new Error("Mirror route should keep all destinations");
const inboundDestinations = await mirror.destinationsFor({ platform: "telegram", chatId: "tg-chat-1" }, "inbound");
if (inboundDestinations.length !== 2)
	throw new Error(`Inbound destinations should match: ${inboundDestinations.length}`);
const outboundDestinations = await mirror.destinationsFor({ platform: "telegram", chatId: "tg-chat-1" }, "outbound");
if (outboundDestinations.length !== 2) throw new Error("Outbound destinations should match");
const noMatch = await mirror.destinationsFor({ platform: "telegram", chatId: "other" }, "inbound");
if (noMatch.length !== 0) throw new Error("Unmatched mirror source should return empty destinations");
await mirror.setEnabled(route.id, false);
const disabled = await mirror.destinationsFor({ platform: "telegram", chatId: "tg-chat-1" }, "inbound");
if (disabled.length !== 0) throw new Error("Disabled mirror should not deliver");

const footerDisabled = buildRuntimeFooter({ platform: "telegram" }, DEFAULT_FOOTER_CONFIG);
if (footerDisabled !== undefined) throw new Error("Default footer should be disabled");
const footerEnabled = buildRuntimeFooter(
	{ platform: "telegram", model: "claude-opus-4-7", provider: "anthropic", durationMs: 4_321, chunks: 3 },
	{ ...DEFAULT_FOOTER_CONFIG, enabled: true, includeChunks: true },
);
if (
	footerEnabled === undefined ||
	!footerEnabled.includes("claude-opus-4-7") ||
	!footerEnabled.includes("4.3s") ||
	!footerEnabled.includes("chunks: 3")
) {
	throw new Error(`Footer missing fields: ${footerEnabled}`);
}
const appended = appendRuntimeFooter(
	"Hello world.",
	{ platform: "telegram", model: "claude-opus-4-7", durationMs: 750 },
	{ ...DEFAULT_FOOTER_CONFIG, enabled: true },
);
if (!appended.startsWith("Hello world.") || !appended.includes("claude-opus-4-7")) {
	throw new Error("appendRuntimeFooter should preserve body and append footer");
}

const stickerCache = new StickerCache(join(root, ".stickers"));
const downloadCount = { value: 0 };
const fakeKey = { platform: "telegram" as const, fileId: "AgADXyz", emoji: "🐤" };
const entry = await stickerCache.get(fakeKey, {
	download: async () => {
		downloadCount.value += 1;
		return { data: Buffer.from("payload"), mime: "image/webp" };
	},
});
if (entry === undefined) throw new Error("Sticker cache should download on miss");
if (downloadCount.value !== 1) throw new Error("Sticker cache should download exactly once on miss");
const entryHit = await stickerCache.get(fakeKey, {
	download: async () => {
		downloadCount.value += 1;
		return { data: Buffer.from("again"), mime: "image/webp" };
	},
});
if (entryHit === undefined || entryHit.cacheFile !== entry.cacheFile)
	throw new Error("Sticker cache should return cached entry");
if (downloadCount.value !== 1) throw new Error(`Sticker cache should not re-download, got ${downloadCount.value}`);

const hooks = new HookRegistry({
	hooksDir: join(root, "hooks"),
	dynamicImport: async () => ({}),
});
const observed: MessagingHookEvent["type"][] = [];
hooks.registerProgrammatic((event) => {
	observed.push(event.type);
});
await hooks.emit({ type: "messaging.startup", profile: "default" });
await hooks.emit({
	type: "messaging.received",
	event: {
		platform: "telegram",
		chatId: "tg-chat-1",
		userId: "user-1",
		sessionId: "session-abc",
		text: "hi",
		at: new Date().toISOString(),
	},
});
if (observed.length !== 2 || observed[0] !== "messaging.startup" || observed[1] !== "messaging.received") {
	throw new Error(`Hook events not delivered: ${observed.join(",")}`);
}

await rm(root, { recursive: true, force: true });

console.log(
	JSON.stringify({
		pairingConfirmed: confirmed.id,
		mirrorRoute: route.id,
		footer: appended.slice(-40),
		stickerCached: entry.cacheFile.endsWith(".webp"),
		hookCalls: observed.length,
	}),
);
