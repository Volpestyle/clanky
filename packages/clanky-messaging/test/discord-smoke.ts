import { DiscordAdapter, defaultDiscordConfig } from "../src/index.ts";

const config = defaultDiscordConfig();
config.botToken = "fake.bot.token";
config.enabled = true;
config.applicationId = "0";

const adapter = new DiscordAdapter({
	config,
	deps: {
		resetChatSession: async () => undefined,
		abortChatSession: async () => undefined,
	},
});

if (adapter.platform !== "discord") throw new Error("Adapter platform mismatch");
if (!adapter.capabilities.supportsEditing) throw new Error("Discord should support editing");
if (!adapter.capabilities.supportsDeletion) throw new Error("Discord should support deletion");
if (!adapter.capabilities.supportsImages) throw new Error("Discord should support images");
if (!adapter.capabilities.supportsThreads) throw new Error("Discord should support threads");
if (!adapter.capabilities.supportsSlashCommandSync)
	throw new Error("Discord should support slash command sync when policy=auto");
if (adapter.capabilities.maxMessageLength > 2000) throw new Error("Discord max length should not exceed 2000");
if (adapter.isConnected()) throw new Error("Adapter should not be connected before connect()");

const longText = "x".repeat(5_000);
const chunks = adapter.splitForOverflow(longText);
if (chunks.length === 0) throw new Error("Adapter split returned empty");
if (chunks.join("") !== longText) throw new Error("Adapter split lost content");
for (const chunk of chunks) {
	if (chunk.length > 2_000) throw new Error(`Chunk exceeded Discord max length: ${chunk.length}`);
}

const offConfig = defaultDiscordConfig();
offConfig.botToken = "fake";
offConfig.commandSyncPolicy = "off";
const offAdapter = new DiscordAdapter({ config: offConfig, deps: { resetChatSession: async () => undefined } });
if (offAdapter.capabilities.supportsSlashCommandSync) {
	throw new Error("supportsSlashCommandSync should be false when policy=off");
}

console.log(
	JSON.stringify({
		platform: adapter.platform,
		max: adapter.capabilities.maxMessageLength,
		chunkCount: chunks.length,
		supportsReactions: adapter.capabilities.supportsReactions,
		supportsSlashCommandSync: adapter.capabilities.supportsSlashCommandSync,
	}),
);
