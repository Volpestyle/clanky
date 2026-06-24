import {
	type BannerCapabilities,
	type BannerFields,
	detectBannerCapabilities,
	renderClankyBanner,
} from "../agent/lib/clanky-banner.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const FIELDS: BannerFields = {
	title: "Clanky",
	tagline: "a hooded agent on the eve · herdr stage",
	model: "claude-opus-4-8 (high effort)",
	cwd: "~/dev/clanky",
	hint: "/help for commands · /model to switch brains · ctrl+c to exit",
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

// Truecolor + unicode: full mascot, gradient title, and feed values present.
const full = renderClankyBanner(FIELDS, wide({}));
const fullText = stripAnsi(full.join("\n"));
assert(fullText.includes("█"), "unicode banner should render block mascot");
assert(fullText.includes("●"), "unicode banner should render glowing eyes");
assert(fullText.includes("C L A N K Y"), "feed should spell out the title");
assert(
	fullText.includes("claude-opus-4-8 (high effort)"),
	"feed should show the model",
);
assert(fullText.includes("~/dev/clanky"), "feed should show the cwd");
assert(
	full.join("\n").includes("\x1b[38;2;"),
	"truecolor banner should emit 24-bit color codes",
);

// Mascot and feed stay aligned: every mascot row shares the same feed column.
const feedColumns = new Set<number>();
for (const line of full) {
	const plain = stripAnsi(line);
	const match = /\S/u.exec(plain.slice(15));
	if (
		match !== null &&
		(plain.includes("●") || plain.includes("model") || plain.includes("CLANKY"))
	) {
		feedColumns.add(15 + match.index);
	}
}
assert(
	feedColumns.size === 1,
	`feed column should be consistent, saw ${[...feedColumns].join(",")}`,
);

// No-color mode: zero ANSI escapes, mascot still legible.
const mono = renderClankyBanner(
	FIELDS,
	wide({ color: false, trueColor: false }),
);
assert(
	mono.join("").indexOf("\x1b") === -1,
	"no-color banner must not emit escape codes",
);
assert(
	mono.join("\n").includes("█"),
	"no-color banner keeps the unicode mascot",
);

// ASCII fallback: no block-drawing glyphs.
const ascii = stripAnsi(
	renderClankyBanner(FIELDS, wide({ unicode: false })).join("\n"),
);
assert(
	!ascii.includes("█") && !ascii.includes("●"),
	"ascii fallback must avoid unicode block art",
);
assert(
	ascii.includes("o") && ascii.includes("#"),
	"ascii fallback draws the hooded figure with #/o",
);

// Narrow terminal collapses to a condensed header (no wrapped mascot rows).
const condensed = renderClankyBanner(FIELDS, wide({ columns: 36 }));
assert(
	condensed.length <= 2,
	`condensed banner should be at most 2 lines, got ${condensed.length}`,
);
assert(
	stripAnsi(condensed[0] ?? "").includes("Clanky"),
	"condensed banner should still name Clanky",
);
for (const line of condensed) {
	assert(
		stripAnsi(line).length <= 64,
		"condensed banner lines should not blow past a narrow width",
	);
}

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
