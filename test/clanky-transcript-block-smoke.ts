import { visibleWidth, type MarkdownTheme } from "@earendil-works/pi-tui";
import {
	ClankyTranscriptMarkdownBlock,
	parseTranscriptMarkdown,
	type ClankyTranscriptBlockTheme,
} from "../agent/lib/clanky-transcript-block.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const plain = (text: string) => text;
const markdownTheme: MarkdownTheme = {
	bold: plain,
	code: plain,
	codeBlock: plain,
	codeBlockBorder: plain,
	heading: plain,
	hr: plain,
	italic: plain,
	link: plain,
	linkUrl: plain,
	listBullet: plain,
	quote: plain,
	quoteBorder: plain,
	strikethrough: plain,
	underline: plain,
};
const theme: ClankyTranscriptBlockTheme = {
	bold: plain,
	cyan: plain,
	dim: plain,
	green: plain,
	markdown: markdownTheme,
	red: plain,
	yellow: plain,
};

const parsed = parseTranscriptMarkdown("**Tool: bash - completed**\n\n- stdout: ok");
assert(parsed.title === "Tool: bash - completed", "parser should lift bold first-line titles");
assert(parsed.body === "- stdout: ok", "parser should preserve body markdown");
assert(parsed.tone === "tool", "parser should classify tool titles");

const block = new ClankyTranscriptMarkdownBlock("**Tool: bash - completed**\n\n- stdout: ok", theme);
const rows = block.render(48);
const compactRows = rows.map((line) => line.trimEnd());
assert(compactRows[0] === "✓ bash completed", "tool blocks should render compact Eve-style headers");
assert(rows.some((line) => line.includes("stdout: ok")), "tool block body should render as markdown body");
assert(rows.every((line) => visibleWidth(line) <= 48), "block rows should fit the viewport width");

block.setMarkdown("**Error**\n\nSomething failed.");
const errorRows = block.render(32);
assert(errorRows[0]?.trimEnd() === "⨯ Error", "updated block should rerender its title");
assert(errorRows.some((line) => line.includes("Something failed.")), "updated block should rerender its body");

const noTitle = new ClankyTranscriptMarkdownBlock("Plain transcript body", theme);
assert(noTitle.render(32)[0]?.trimEnd() === "Transcript", "untitled markdown should get a system header");

const subagentBlock = new ClankyTranscriptMarkdownBlock("**Subagent: Planner - running**\n\nspawned by codex", theme);
const subagentRows = subagentBlock.render(48).map((line) => line.trimEnd());
assert(subagentRows[0] === "◆ Planner subagent running", "subagent blocks should render compact lifecycle headers");
assert(subagentRows.some((line) => line.startsWith("│ ") && line.includes("spawned by codex")), "subagent bodies should use a rule gutter");

const subagentToolBlock = new ClankyTranscriptMarkdownBlock("**Subagent tool: Planner / bash - completed**\n\n-> ok", theme);
assert(
	subagentToolBlock.render(48)[0]?.trimEnd() === "│ ✓ bash Planner completed",
	"subagent tool blocks should render nested compact tool headers",
);

const authBlock = new ClankyTranscriptMarkdownBlock("**Authorization required**\n\nLinear", theme);
assert(authBlock.render(48)[0]?.trimEnd() === "● Auth required", "authorization blocks should render auth headers");

const inputBlock = new ClankyTranscriptMarkdownBlock("**Input requested**\n\nContinue?", theme);
assert(inputBlock.render(48)[0]?.trimEnd() === "? Input requested", "input blocks should render question headers");

const approvalBlock = new ClankyTranscriptMarkdownBlock("**Tool: bash - approved**\n\nanswer: approve", theme);
assert(approvalBlock.render(48)[0]?.trimEnd() === "✓ bash approved", "approved tool prompts should render as completed approvals");

const subagentFailedBlock = new ClankyTranscriptMarkdownBlock("**Subagent failed: Planner**\n\nboom", theme);
assert(subagentFailedBlock.render(48)[0]?.trimEnd() === "◆ Planner subagent failed", "subagent failures should render as failed lifecycle headers");

console.log("clanky-transcript-block-smoke: ok");
