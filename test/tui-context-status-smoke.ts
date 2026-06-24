import { appendContextUsagePercent } from "../agent/lib/tui-context-status.ts";

function check(name: string, condition: boolean): void {
	if (!condition) throw new Error(name);
	console.log(`ok    ${name}`);
}

const status = appendContextUsagePercent(
	"qwen3.6 ctx 262.1K  ·  ↑ 15.9K ↓ 200  ·  External endpoint",
	262_144,
);
check("context status appends labeled percentage", status.includes("↑ 15.9K ↓ 200 ctx 6%"));

const existing = appendContextUsagePercent("qwen3.6  ·  ↑ 15.9K ↓ 200 ctx 6%  ·  External endpoint", 262_144);
check("context status does not duplicate percentage", existing.match(/ctx 6%/gu)?.length === 1);

const bare = appendContextUsagePercent("qwen3.6  ·  ↑ 9.5K ↓ 53 4%  ·  External endpoint", undefined);
check("context status labels renderer-provided percentage", bare.includes("↑ 9.5K ↓ 53 ctx 4%"));

const ansiBare = appendContextUsagePercent("\x1b[2m↑ 9.5K ↓ 44 4%\x1b[0m", undefined);
check("context status labels renderer-provided percentage before ansi reset", ansiBare.includes("↑ 9.5K ↓ 44 ctx 4%"));

const noContext = appendContextUsagePercent("qwen3.6  ·  ↑ 15.9K ↓ 200", undefined);
check("context status leaves text unchanged without context", noContext === "qwen3.6  ·  ↑ 15.9K ↓ 200");

const fresh = appendContextUsagePercent("qwen3.6 ctx 262.1K (high effort)  ·  External endpoint", 262_144);
check("context status shows zero percent before token flow", fresh.includes("ctx 262.1K (high effort)  ·  ctx 0%"));

const ansiFresh = appendContextUsagePercent(
	"\x1b[2mqwen3.6 ctx 262.1K (high effort)\x1b[0m  \x1b[2m·\x1b[0m  \x1b[2mExternal endpoint\x1b[0m",
	262_144,
);
check("context status shows zero percent before token flow with ansi", ansiFresh.includes("ctx 0%"));

console.log("\nALL OK");
