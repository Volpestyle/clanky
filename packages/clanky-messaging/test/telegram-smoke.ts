import {
	applyParseMode,
	defaultTelegramConfig,
	escapeMarkdownV2,
	splitForTelegram,
	TelegramAdapter,
} from "../src/index.ts";

const plain = "Hello, *world*! (test)";
const escaped = escapeMarkdownV2(plain);
if (!escaped.includes("\\*") || !escaped.includes("\\(") || !escaped.includes("\\)") || !escaped.includes("\\!")) {
	throw new Error(`MarkdownV2 escape missing special chars: ${escaped}`);
}

const codeBlock = "Here is code:\n```\nx = 1\nfoo(x)\n```\nDone.";
const escapedCode = escapeMarkdownV2(codeBlock);
if (!escapedCode.includes("```\nx = 1\nfoo(x)\n```")) {
	throw new Error(`Code block should be preserved: ${escapedCode}`);
}
if (!escapedCode.includes("Done\\.")) {
	throw new Error(`Trailing period should be escaped: ${escapedCode}`);
}

const htmlEscaped = applyParseMode("<b>hi</b> & friends", "HTML");
if (!htmlEscaped.includes("&lt;b&gt;") || !htmlEscaped.includes("&amp;")) {
	throw new Error(`HTML escape failed: ${htmlEscaped}`);
}

const plainPass = applyParseMode("no escaping please.", "none");
if (plainPass !== "no escaping please.") {
	throw new Error(`Parse mode "none" should not modify text: ${plainPass}`);
}

const longInput = `${"abcdefghij ".repeat(500)}END`;
const chunks = splitForTelegram(longInput, 100);
if (chunks.length < 50) throw new Error(`splitForTelegram produced too few chunks: ${chunks.length}`);
for (const chunk of chunks) {
	if (chunk.length > 100) throw new Error(`Chunk exceeded max length: ${chunk.length}`);
}
if (chunks.join("") !== longInput) {
	throw new Error("splitForTelegram lost content");
}

const fencedInput = `prelude text ${"x".repeat(80)}\n\`\`\`\n${"y".repeat(300)}\n\`\`\`\ntail`;
const fencedChunks = splitForTelegram(fencedInput, 100);
if (fencedChunks.length < 4) throw new Error("Fenced split should produce multiple chunks");
if (fencedChunks.join("") !== fencedInput) throw new Error("Fenced split lost content");

const config = defaultTelegramConfig();
config.botToken = "1234567:test-token";
config.enabled = true;

const adapter = new TelegramAdapter({
	config,
	apiRoot: "http://127.0.0.1:1/api",
	deps: {
		resetChatSession: async () => undefined,
		abortChatSession: async () => undefined,
	},
});

if (adapter.platform !== "telegram") throw new Error("Adapter platform mismatch");
if (adapter.capabilities.maxMessageLength <= 0) throw new Error("Capabilities missing maxMessageLength");
if (!adapter.capabilities.supportsEditing) throw new Error("Telegram should support editing");
if (!adapter.capabilities.supportsVoice) throw new Error("Telegram should support voice");
if (adapter.isConnected()) throw new Error("Adapter should not be connected before connect()");

const splitFromAdapter = adapter.splitForOverflow(longInput);
if (splitFromAdapter.length === 0) throw new Error("Adapter split returned empty");
if (splitFromAdapter.join("") !== longInput) throw new Error("Adapter split lost content");

console.log(
	JSON.stringify({
		escapedSample: escaped.slice(0, 40),
		chunkCount: chunks.length,
		fencedChunks: fencedChunks.length,
		adapterPlatform: adapter.platform,
		adapterMax: adapter.capabilities.maxMessageLength,
	}),
);
