import {
	layoutSettingsFromEnv,
	parseAgentSpinnerCycleRateMs,
	parseInputPlacement,
	parseStatusPlacement,
	parseTurnTraceMode,
} from "../scripts/clanky/face-settings.ts";

function check(label: string, ok: boolean): void {
	console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
	if (!ok) process.exitCode = 1;
}

check("trace parser accepts false aliases", parseTurnTraceMode("0") === "off");
check("trace parser accepts no-reply aliases", parseTurnTraceMode("empty") === "no-reply");
check("trace parser accepts true aliases", parseTurnTraceMode("on") === "all");
check("input placement accepts above", parseInputPlacement("above") === "top");
check("status placement accepts below", parseStatusPlacement("below") === "below-input");
check("spinner parser accepts fast", parseAgentSpinnerCycleRateMs("fast", 800) === 400);
check("spinner parser accepts default", parseAgentSpinnerCycleRateMs("default", 800) === 800);
check("spinner parser accepts seconds", parseAgentSpinnerCycleRateMs("1.2s", 800) === 1_200);
check(
	"layout env parser applies defaults",
	JSON.stringify(layoutSettingsFromEnv({})) === JSON.stringify({ inputPlacement: "bottom", statusPlacement: "above-input" }),
);

if (process.exitCode === undefined) console.log("face settings smoke OK");
