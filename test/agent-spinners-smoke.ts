import {
	AGENT_SPINNER_NAMES,
	AGENT_SPINNER_CYCLE_NAMES,
	AGENT_SPINNERS,
	normalizeAgentSpinnerSelection,
	resolveAgentSpinner,
} from "../agent/lib/agent-spinners.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

assert(AGENT_SPINNER_NAMES.length === 55, `expected 55 expo-agent-spinners entries, got ${AGENT_SPINNER_NAMES.length}`);

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
assert(AGENT_SPINNER_CYCLE_NAMES[0] === "dots" && AGENT_SPINNER_CYCLE_NAMES.at(-1) === "weather", "cycle order should match the Expo category order");
assert(cycle.frames.length === AGENT_SPINNER_CYCLE_NAMES.length * 12, "cycle spinner should dwell on each copied Expo spinner");
assert(new Set(cycle.frames.map((frame) => frame.length)).size > 1, "cycle spinner should include multiple spinner styles");
assert(resolveAgentSpinner(undefined, { unicode: false }).name === "rolling-line", "ascii fallback should be rolling-line");
assert(resolveAgentSpinner("sparkle").frames[0] === "⡡⠊⢔⠡", "sparkle should resolve copied Expo frames");
assert(normalizeAgentSpinnerSelection("all") === "cycle", "all should alias cycle mode");
assert(normalizeAgentSpinnerSelection("simple_dots_scrolling") === "simple-dots-scrolling", "underscores should normalize to kebab-case");
assert(normalizeAgentSpinnerSelection("missing") === undefined, "unknown spinner should not resolve");

console.log("agent-spinners-smoke: ok");
