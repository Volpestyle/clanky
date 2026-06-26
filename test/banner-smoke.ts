import {
	ClankyBannerComponent,
	type BannerCapabilities,
	type BannerFields,
	detectBannerCapabilities,
	renderClankyBanner,
} from "../agent/lib/clanky-banner.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createClankyFaceAnsiTheme } from "../agent/lib/clanky-face-theme.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const FIELDS: BannerFields = {
	title: "Clanky",
	tagline: "eve conductor · herdr stage",
	model: "claude-opus-4-8 (high effort)",
	cwd: "~/dev/clanky",
	hint: "/help for commands · ctrl+c to exit",
};

const ANSI = new RegExp(`${"\x1b"}\\[[0-9;]*m`, "gu");
const stripAnsi = (text: string): string => text.replace(ANSI, "");
const wide = (overrides: Partial<BannerCapabilities>): BannerCapabilities => ({
	color: true,
	unicode: true,
	trueColor: true,
	columns: 100,
	...overrides,
});

// Truecolor + unicode: inline robot mascot rides alongside the name.
const full = renderClankyBanner(FIELDS, wide({}));
const fullText = stripAnsi(full.join("\n"));
assert(fullText.includes("[◉‿◉]"), "banner should render the inline robot mascot");
assert(fullText.includes("clanky"), "feed should render the name beside the mascot");
assert(!fullText.includes("C L A N K Y"), "title should not use spaced lettering");
assert(
	/\[◉‿◉\]\s+clanky/u.test(fullText),
	"mascot should sit on the same line as the name",
);
assert(
	fullText.includes("claude-opus-4-8 (high effort)"),
	"feed should show the model",
);
assert(fullText.includes("~/dev/clanky"), "feed should show the cwd");
assert(
	full.join("\n").includes("\x1b[38;2;"),
	"truecolor banner should emit 24-bit color codes",
);
const fullTheme = createClankyFaceAnsiTheme(wide({}));
assert(
	fullTheme.cyan("system").includes("\x1b[38;2;255;196;112m"),
	"system accent should use the same truecolor accent as the banner",
);

// Text rows use a single left gutter.
const gutterRows = full.map(stripAnsi).filter((line) => line.length > 0);
assert(
	gutterRows.every((line) => line.startsWith(" ")),
	"non-empty banner rows should share a one-column left gutter",
);

// No-color mode: zero ANSI escapes, text still legible.
const mono = renderClankyBanner(
	FIELDS,
	wide({ color: false, trueColor: false }),
);
assert(
	mono.join("").indexOf("\x1b") === -1,
	"no-color banner must not emit escape codes",
);
assert(
	createClankyFaceAnsiTheme(wide({ color: false, trueColor: false })).cyan("system") === "system",
	"no-color system accent must not emit escape codes",
);
assert(
	mono.join("\n").includes("clanky"),
	"no-color banner keeps the simplified title",
);

// ASCII fallback: mascot degrades to plain ASCII, no unicode glyphs.
const ascii = stripAnsi(
	renderClankyBanner(FIELDS, wide({ unicode: false })).join("\n"),
);
assert(
	!ascii.includes("◉") && !ascii.includes("‿"),
	"ascii fallback must avoid unicode mascot glyphs",
);
assert(
	ascii.includes("[o_o]") && ascii.includes("clanky"),
	"ascii fallback renders the plain mascot beside the name",
);

// Narrow terminal collapses to a condensed header (no wrapped mascot rows).
const condensed = renderClankyBanner(FIELDS, wide({ columns: 36 }));
assert(
	condensed.length <= 2,
	`condensed banner should be at most 2 lines, got ${condensed.length}`,
);
assert(
	stripAnsi(condensed[0] ?? "").includes("clanky"),
	"condensed banner should still name Clanky",
);
for (const line of condensed) {
	assert(
		stripAnsi(line).length <= 64,
		"condensed banner lines should not blow past a narrow width",
	);
}

// Component form adapts to the render width, not just startup terminal width.
const component = new ClankyBannerComponent(FIELDS, wide({ columns: 100 }));
const narrowComponent = component.render(32);
assert(narrowComponent.length <= 4, "dynamic banner should condense in a narrow render pass");
for (const line of narrowComponent) {
	assert(visibleWidth(line) <= 32, `dynamic banner line should fit narrow width: ${JSON.stringify(line)}`);
}
assert(
	stripAnsi(narrowComponent.join("\n")).includes("clanky"),
	"dynamic banner should keep Clanky visible when narrow",
);
component.setFields({ ...FIELDS, model: "qwen3.6:27b-mlx-bf16 (high effort)" });
assert(
	stripAnsi(component.render(100).join("\n")).includes("qwen3.6:27b-mlx-bf16"),
	"dynamic banner should refresh model fields without recreating the component",
);

// Capability detection: non-TTY and NO_COLOR disable color.
const noTty = detectBannerCapabilities({ isTTY: false, columns: 80 }, {});
assert(!noTty.color, "non-TTY output should disable color");
const noColorEnv = detectBannerCapabilities(
	{ isTTY: true, columns: 80 },
	{ NO_COLOR: "1", COLORTERM: "truecolor" },
);
assert(
	!noColorEnv.color && !noColorEnv.trueColor,
	"NO_COLOR should disable color and truecolor",
);
const trueColorEnv = detectBannerCapabilities(
	{ isTTY: true, columns: 120 },
	{ COLORTERM: "truecolor" },
);
assert(
	trueColorEnv.color && trueColorEnv.trueColor,
	"COLORTERM=truecolor on a TTY should enable truecolor",
);

console.log("banner-smoke: ok");
