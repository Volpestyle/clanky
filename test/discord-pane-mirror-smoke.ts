import type { HandleMessageStreamEvent } from "eve/client";
import {
	ClankyFaceRenderer,
	type FaceBlockHandle,
	type FaceBlockOptions,
	type FaceRenderSink,
} from "../agent/lib/clanky-face-renderer.ts";
import { ClankyTranscriptMarkdownBlock, type ClankyTranscriptBlockTheme } from "../agent/lib/clanky-transcript-block.ts";
import { ClankyTranscriptViewport } from "../agent/lib/clanky-transcript-viewport.ts";
import { createClankyFaceAnsiTheme, createClankyFaceMarkdownTheme } from "../agent/lib/clanky-face-theme.ts";
import { applyMirrorStreamEvent, createMirrorRenderSink, type MirrorView } from "../agent/lib/discord/pane-mirror-view.ts";
import { formatVoiceEvePrompt } from "../agent/lib/voice/eve-session.ts";
import { summarizePresencePromptForMirror } from "../agent/lib/discord/prompt.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const ansi = createClankyFaceAnsiTheme({ color: false, trueColor: false });
const blockTheme: ClankyTranscriptBlockTheme = {
	bold: (t) => t,
	cyan: (t) => t,
	dim: (t) => t,
	green: (t) => t,
	loadingGlyph: () => "o",
	markdown: createClankyFaceMarkdownTheme(ansi),
	red: (t) => t,
	yellow: (t) => t,
};

// Part 1: the mirror surfaces the inbound prompt and full tool args + output
// through the shared face renderer (the data the old console mirror discarded).
class CapturedBlock implements FaceBlockHandle {
	markdown: string;
	readonly options: FaceBlockOptions | undefined;

	constructor(markdown: string, options?: FaceBlockOptions) {
		this.markdown = markdown;
		this.options = options;
	}

	setMarkdown(markdown: string): void {
		this.markdown = markdown;
	}
}

const captured: CapturedBlock[] = [];
const capturingSink: FaceRenderSink = {
	insertMarkdown(markdown, options) {
		const block = new CapturedBlock(markdown, options);
		captured.push(block);
		return block;
	},
	setLoaderMessage() {},
	setStatus() {},
};
const renderer = new ClankyFaceRenderer(capturingSink);
const view: MirrorView = { renderer, sink: capturingSink };

const presencePrompt = [
	"Discord conversation update:",
	"- kind: dm",
	"Newest Discord message:",
	"From: vuhlp",
	"Text: hi clank",
].join("\n");

const events: HandleMessageStreamEvent[] = [
	{ type: "session.started", data: {} },
	{ type: "turn.started", data: { sequence: 1, turnId: "turn-1" } },
	{ type: "message.received", data: { message: presencePrompt, sequence: 2, turnId: "turn-1" } },
	{ type: "step.started", data: { sequence: 3, stepIndex: 0, turnId: "turn-1" } },
	{
		type: "actions.requested",
		data: {
			actions: [{ callId: "call-1", input: { command: "printf hello-from-tool" }, kind: "tool-call", toolName: "bash" }],
			sequence: 4,
			stepIndex: 0,
			turnId: "turn-1",
		},
	},
	{
		type: "action.result",
		data: {
			result: { callId: "call-1", isError: false, kind: "tool-result", output: { stdout: "hello-output-line" }, toolName: "bash" },
			sequence: 5,
			status: "completed",
			stepIndex: 0,
			turnId: "turn-1",
		},
	},
	{ type: "turn.completed", data: { sequence: 6, turnId: "turn-1" } },
	// A second turn must reset per-turn state so it renders its own assistant block.
	{ type: "turn.started", data: { sequence: 7, turnId: "turn-2" } },
	{ type: "step.started", data: { sequence: 8, stepIndex: 0, turnId: "turn-2" } },
	{ type: "message.appended", data: { messageDelta: "second turn reply", messageSoFar: "second turn reply", sequence: 9, stepIndex: 0, turnId: "turn-2" } },
	{ type: "message.completed", data: { finishReason: "stop", message: "second turn reply", sequence: 10, stepIndex: 0, turnId: "turn-2" } },
	{ type: "turn.completed", data: { sequence: 11, turnId: "turn-2" } },
];
for (const event of events) applyMirrorStreamEvent(view, event);

const assistantBlocks = captured.filter((block) => block.markdown.startsWith("**Clanky**"));
assert(assistantBlocks.length === 1, "the first turn produced no assistant text, so only the second turn's block should exist");
assert(assistantBlocks[0]?.markdown.includes("second turn reply") === true, "turn boundary reset should give the second turn its own assistant block");

const inbound = captured.find((block) => block.markdown.startsWith("**You**"));
assert(inbound !== undefined, "message.received should surface an inbound You block");
assert(inbound.markdown.includes("Discord dm vuhlp: hi clank"), "inbound block should show the summarized Discord prompt");

const toolBlock = captured.find((block) => block.markdown.includes("Tool: bash") && block.markdown.includes("completed"));
assert(toolBlock !== undefined, "action.result should produce a completed bash tool block");
assert(toolBlock.markdown.includes("printf hello-from-tool"), "tool block should include the tool input/args");
assert(toolBlock.markdown.includes("hello-output-line"), "tool block should include the tool output");
assert(toolBlock.options?.collapsed === true, "tool blocks should default to collapsed");
assert(toolBlock.options?.clickToggle === true, "tool blocks should be click-to-toggle expandable");

// Part 2: the real viewport-backed sink renders a collapsed preview and expands
// to the full body when toggled - the watch-and-expand behavior.
const viewport = new ClankyTranscriptViewport(() => 40, { dim: (t) => t, selected: (t) => t }, { blockSpacing: 0 });
viewport.focused = false;
let renders = 0;
const liveSink = createMirrorRenderSink(viewport, blockTheme, {
	requestRender: () => {
		renders += 1;
	},
	setLoaderMessage: () => undefined,
	setStatus: () => undefined,
});

const toolMarkdown = "**Tool: bash - completed**\n\nfirst-body-line\nsecond-body-line\nthird-body-line";
liveSink.insertMarkdown(toolMarkdown, { clickToggle: true, collapsed: true });
assert(renders === 1, "inserting a block should request a render");

const collapsed = viewport.render(60).join("\n");
assert(collapsed.includes("bash"), "collapsed tool block should still show its title");
assert(collapsed.includes("hidden lines"), "collapsed tool block should show a hidden-lines hint");
assert(!collapsed.includes("third-body-line"), "collapsed tool block should hide trailing body lines");

// Expanding via the viewport (Enter on the selected block) reveals the body.
viewport.focused = true;
viewport.handleInput("\r");
const expanded = viewport.render(60).join("\n");
assert(expanded.includes("first-body-line"), "expanded tool block should reveal the body");
assert(expanded.includes("third-body-line"), "expanded tool block should reveal all body lines");

// Part 3: the click path uses toggleCollapsedAt, which only fires on clickToggle
// blocks (tool/skill) - what the mirror inserts a left-click onto.
const clickViewport = new ClankyTranscriptViewport(() => 12, { dim: (t) => t, selected: (t) => t }, { blockSpacing: 0, underfilledAlignment: "top" });
const clickSink = createMirrorRenderSink(clickViewport, blockTheme, {
	requestRender: () => undefined,
	setLoaderMessage: () => undefined,
	setStatus: () => undefined,
});
clickSink.insertMarkdown("**Tool: bash - completed**\n\nclick-body-a\nclick-body-b\nclick-body-c", { clickToggle: true, collapsed: true });
const clickCollapsed = clickViewport.render(60).join("\n"); // establishes layout (row 0 = title)
assert(!clickCollapsed.includes("click-body-c"), "tool block should start collapsed before a click");
assert(clickViewport.toggleCollapsedAt(0) === true, "left-click on a clickToggle tool block should toggle it");
assert(clickViewport.render(60).join("\n").includes("click-body-c"), "click should expand the tool block body");

const noClickViewport = new ClankyTranscriptViewport(() => 12, { dim: (t) => t, selected: (t) => t }, { blockSpacing: 0, underfilledAlignment: "top" });
const noClickSink = createMirrorRenderSink(noClickViewport, blockTheme, {
	requestRender: () => undefined,
	setLoaderMessage: () => undefined,
	setStatus: () => undefined,
});
noClickSink.insertMarkdown("**You**\n\njust-text", {});
noClickViewport.render(60);
assert(noClickViewport.toggleCollapsedAt(0) === false, "clicking a non-clickToggle block should be a no-op");

// Part 4: the voice durability session reuses the same mirror, so its inbound
// prompt must summarize to a readable "Voice <speaker>: <text>" line.
const voicePrompt = formatVoiceEvePrompt(
	{ text: "call a tool for me", eventType: "conversation.item.input_audio_transcription.completed", itemId: "item-1" },
	{ host: "http://127.0.0.1:2000", guildId: "g1", channelId: "c1", speaker: { userId: "u1", userName: "vuhlp" } },
);
assert(summarizePresencePromptForMirror(voicePrompt) === "Voice vuhlp: call a tool for me", "voice prompt should summarize to Voice <speaker>: <text>");

const voicePromptNoName = formatVoiceEvePrompt(
	{ text: "just talking", eventType: "conversation.item.input_audio_transcription.completed" },
	{ host: "http://127.0.0.1:2000", guildId: "g1", channelId: "c1" },
);
assert(summarizePresencePromptForMirror(voicePromptNoName) === "Voice: just talking", "voice prompt without a speaker name should still summarize");

console.log("discord-pane-mirror-smoke: ok");
