import {
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	AGENT_SPINNER_CYCLE_INTERVAL_MS,
	AGENT_SPINNER_NAMES,
	AGENT_SPINNER_CYCLE_PRESETS,
	AGENT_SPINNER_CYCLE_NAMES,
	DEFAULT_AGENT_SPINNER_CYCLE_DWELL_MS,
	AGENT_SPINNER_PRESET_NAMES,
	AGENT_SPINNER_PRESETS,
	AGENT_SPINNERS,
	AGENT_SPINNER_WIDTH_PRESETS,
	normalizeAgentSpinnerCycleDwellMs,
	normalizeAgentSpinnerSelection,
	resolveAgentSpinner,
} from "../agent/lib/agent-spinners.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

assert(AGENT_SPINNER_NAMES.length === 49, `expected 49 non-emoji expo-agent-spinners entries, got ${AGENT_SPINNER_NAMES.length}`);
assert(
	AGENT_SPINNER_PRESET_NAMES.join(",") === "micro,needle,pulse-3,ribbon-4,sweep-2,terminal,width-1,width-2,width-3,width-4",
	"spinner presets should be stable and sorted",
);
for (const name of ["hearts", "clock", "earth", "moon", "speaker", "weather"]) {
	assert(!(AGENT_SPINNER_NAMES as readonly string[]).includes(name), `${name} emoji spinner should not be exposed`);
	for (const presetName of AGENT_SPINNER_PRESET_NAMES) {
		assert(!(AGENT_SPINNER_PRESETS[presetName] as readonly string[]).includes(name), `${name} emoji spinner should not be in ${presetName}`);
	}
}

for (const name of AGENT_SPINNER_NAMES) {
	const spinner = AGENT_SPINNERS[name];
	assert(spinner.frames.length > 0, `${name} should have frames`);
	assert(spinner.frames.every((frame) => frame.length > 0), `${name} should not contain empty frames`);
	assert(Number.isSafeInteger(spinner.intervalMs) && spinner.intervalMs > 0, `${name} should have a positive interval`);
}

const cycle = resolveAgentSpinner(undefined, { unicode: true });
assert(cycle.name === "cycle", "unicode default should cycle through spinner styles");
assert(cycle.intervalMs === 100, "cycle spinner should use a stable terminal tick interval");
assert(AGENT_SPINNER_CYCLE_NAMES.length === AGENT_SPINNER_NAMES.length, "cycle order should include every spinner exactly once");
assert(new Set(AGENT_SPINNER_CYCLE_NAMES).size === AGENT_SPINNER_NAMES.length, "cycle order should not duplicate spinners");
assert(AGENT_SPINNER_CYCLE_NAMES.slice(0, 4).join(",") === "arc,dots,arrow,circle-quarters", "cycle order should interleave visual families immediately");
assert(cycle.frames.length === AGENT_SPINNER_CYCLE_NAMES.length * (DEFAULT_AGENT_SPINNER_CYCLE_DWELL_MS / AGENT_SPINNER_CYCLE_INTERVAL_MS), "cycle spinner should briefly dwell on each copied Expo spinner");
assert(cycle.frames.some((frame) => frame.includes("◜")), "cycle spinner should include ASCII-style arc frames");
assert(cycle.frames.some((frame) => frame.includes("⠋")), "cycle spinner should include braille frames");
assert(cycle.frames.some((frame) => frame.includes("←")), "cycle spinner should include arrow frames");
assert(normalizeAgentSpinnerCycleDwellMs(400) === 400, "cycle dwell should accept valid rates");
assert(normalizeAgentSpinnerCycleDwellMs(1) === 1, "cycle dwell should not clamp small positive rates");
assert(normalizeAgentSpinnerCycleDwellMs(0) === DEFAULT_AGENT_SPINNER_CYCLE_DWELL_MS, "cycle dwell should reject non-positive rates");
assert(resolveAgentSpinner(undefined, { unicode: false }).name === "rolling-line", "ascii fallback should be rolling-line");
assert(resolveAgentSpinner("sparkle").frames[0] === "⡡⠊⢔⠡", "sparkle should resolve copied Expo frames");
assert(normalizeAgentSpinnerSelection("all") === "cycle", "all should alias cycle mode");
assert(normalizeAgentSpinnerSelection("dots") === "dots", "bare dots should still select the exact spinner");
assert(normalizeAgentSpinnerSelection("width-1") === "width-1", "width-1 should select the width preset");
assert(normalizeAgentSpinnerSelection("preset:micro") === "micro", "preset:micro should select the curated preset");
assert(normalizeAgentSpinnerSelection("micro-only") === "micro", "micro-only should select the curated preset");
assert(normalizeAgentSpinnerSelection("custom:dots,dots2,dots9") === "custom:dots,dots2,dots9", "custom should preserve a valid custom cycle");
assert(normalizeAgentSpinnerSelection("custom:dots,dots,dots2") === "custom:dots,dots2", "custom should dedupe repeated spinner names");
assert(normalizeAgentSpinnerSelection("custom:dots,missing") === undefined, "custom should reject unknown spinner names");
assert(normalizeAgentSpinnerSelection("custom:dots") === undefined, "custom should require at least two spinner names");
assert(normalizeAgentSpinnerSelection("simple_dots_scrolling") === "simple-dots-scrolling", "underscores should normalize to kebab-case");
assert(normalizeAgentSpinnerSelection("missing") === undefined, "unknown spinner should not resolve");

const customCycle = resolveAgentSpinner("custom:dots,dots2,dots9");
assert(customCycle.name === "custom:dots,dots2,dots9", "custom cycle should preserve its selection name");
assert(customCycle.frames.length === 24, "custom cycle should dwell on each selected spinner");
assert(customCycle.frames.some((frame) => frame.includes("⢹")), "custom cycle should include later selected spinner frames");
const fastCustomCycle = resolveAgentSpinner("custom:dots,dots2,dots9", { cycleDwellMs: 400 });
assert(fastCustomCycle.frames.length === 12, "custom cycle rate should shorten dwell per selected spinner");

for (const [presetName, members] of Object.entries(AGENT_SPINNER_WIDTH_PRESETS)) {
	const width = Number(presetName.replace("width-", ""));
	assert(members.length > 0, `${presetName} should have members`);
	for (const name of members) assert(maxSpinnerWidth(name) === width, `${name} should be in ${presetName}`);
	const resolved = resolveAgentSpinner(presetName);
	assert(resolved.name === presetName, `${presetName} should preserve its selection name`);
	assert(resolved.frames.every((frame) => visibleWidth(frame) === width), `${presetName} resolved frames should stay width ${width}`);
}

for (const [presetName, members] of Object.entries(AGENT_SPINNER_CYCLE_PRESETS)) {
	const widths = new Set(members.map((name) => maxSpinnerWidth(name)));
	assert(widths.size === 1, `${presetName} should use one terminal width`);
	const resolved = resolveAgentSpinner(presetName);
	assert(resolved.name === presetName, `${presetName} should preserve its selection name`);
	assert(resolved.frames.length === members.length * (DEFAULT_AGENT_SPINNER_CYCLE_DWELL_MS / AGENT_SPINNER_CYCLE_INTERVAL_MS), `${presetName} should dwell on each curated spinner`);
}

console.log("agent-spinners-smoke: ok");

function maxSpinnerWidth(name: keyof typeof AGENT_SPINNERS): number {
	return Math.max(...AGENT_SPINNERS[name].frames.map((frame) => visibleWidth(frame)));
}
