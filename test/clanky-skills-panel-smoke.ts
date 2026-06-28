import { visibleWidth } from "@earendil-works/pi-tui";
import { renderClankySkillsPanel } from "../agent/lib/clanky-skills-panel.ts";
import type { ClankySkillInventoryEntry } from "../agent/lib/skill-inventory.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const theme = {
	bold: (text: string) => text,
	cyan: (text: string) => text,
	dim: (text: string) => text,
	yellow: (text: string) => text,
};

const entries: ClankySkillInventoryEntry[] = [
	{
		description: "Use when Clanky needs to fan out, monitor, unblock, or summarize visible Herdr workers named clanky:<slug>.",
		name: "clanky-herdr-operator",
		path: "agent/skills/clanky-herdr-operator.md",
		scope: "agent",
	},
	{
		description: "Use Playwright from Clanky's local CLI for general web browsing, page extraction, screenshots, and repeatable browser automation.",
		name: "clanky-playwright-browser",
		path: "skills/clanky-playwright-browser/SKILL.md",
		scope: "bundled",
	},
];

for (const width of [52, 72, 96, 120]) {
	const lines = renderClankySkillsPanel(entries, width, theme);
	assert(lines.length > 0, "panel should render lines");
	for (const line of lines) {
		assert(visibleWidth(line) <= width, `line should fit width ${width}: ${JSON.stringify(line)}`);
	}
}

const narrow = renderClankySkillsPanel(entries, 52, theme).join("\n");
assert(narrow.includes("Agent skills"), "panel should include agent section");
assert(narrow.includes("Bundled skills"), "panel should include bundled section");
assert(narrow.includes("agent"), "panel should include agent row label");
assert(narrow.includes("bundled"), "panel should include bundled row label");
assert(narrow.includes("summarize visible Herdr"), "long descriptions should wrap instead of truncate");
assert(narrow.includes("automation."), "wrapped descriptions should preserve their final words");

const wide = renderClankySkillsPanel(entries, 120, theme);
assert(visibleWidth(wide[0] ?? "") === 120, "wide panel should expand to full requested width");

console.log("clanky skills panel smoke OK");
