import { parsePaneRoster, resolveSelf, resolveTarget, stampMessage } from "../agent/lib/herdr-message.ts";

function expectEqual(actual: unknown, expected: unknown, label: string): void {
	const actualJson = JSON.stringify(actual);
	const expectedJson = JSON.stringify(expected);
	if (actualJson !== expectedJson) {
		throw new Error(`${label}: expected ${expectedJson}, got ${actualJson}`);
	}
}

// A roster shaped like real `herdr pane list` output: harness agents given human
// labels, two claude panes (ambiguous by agent), one unlabeled pane, plus self.
const ROSTER = JSON.stringify({
	result: {
		type: "pane_list",
		panes: [
			{ pane_id: "w1:pBR", agent: "clanky:main", agent_status: "idle" },
			{ pane_id: "w1:pEZ", agent: "claude", label: "driver", agent_status: "working" },
			{ pane_id: "w1:pE0", agent: "claude", label: "animator", agent_status: "working" },
			{ pane_id: "w1:pF1", agent: "codex", label: "booty", agent_status: "idle" },
			{ pane_id: "w1:pES", agent: "claude", agent_status: "idle" },
			{ pane_id: "w1:pF3", agent: "claude", agent_status: "working" },
		],
	},
});

const roster = parsePaneRoster(ROSTER);
const SELF = "w1:pF3";

expectEqual(roster.length, 6, "parses every pane row");
expectEqual(
	roster[1],
	{ paneId: "w1:pEZ", agent: "claude", label: "driver", status: "working" },
	"maps pane_id/agent/label/agent_status into a row",
);

expectEqual(resolveSelf(roster, SELF).name, "w1:pF3", "self with no label resolves to its pane id");
expectEqual(resolveSelf(roster, "w1:pF1").name, "booty", "self resolves to its label when present");
expectEqual(resolveSelf(roster, "w1:pZZ").name, "w1:pZZ", "self absent from roster still yields the env pane id");

// The core fix: address by durable label, resolved against the live roster.
const byLabel = resolveTarget(roster, "booty", SELF);
expectEqual(byLabel, { ok: true, pane: { paneId: "w1:pF1", name: "booty", agent: "codex", label: "booty", status: "idle" } }, "unique label resolves");

expectEqual(resolveTarget(roster, "BOOTY", SELF).ok, true, "label match is case-insensitive");

// A pane id lifted from a message body still gets resolved against the roster,
// surfacing who it actually is rather than being trusted blind.
const byPane = resolveTarget(roster, "w1:pEZ", SELF);
expectEqual(byPane.ok && byPane.pane.name, "driver", "explicit pane id resolves to the live pane's name");

// The exact incident shape: a bare harness name matches several panes -> refused.
const ambiguous = resolveTarget(roster, "claude", SELF);
expectEqual(ambiguous.ok, false, "ambiguous harness name is refused");
expectEqual(ambiguous.ok === false && ambiguous.candidates.length, 3, "ambiguous match lists the colliding live panes");

const conductor = resolveTarget(roster, "clanky:main", SELF);
expectEqual(conductor.ok && conductor.pane.paneId, "w1:pBR", "the conductor is addressable by agent name");

expectEqual(resolveTarget(roster, "w1:pF3", SELF).ok, false, "cannot target your own pane id");
expectEqual(resolveTarget(roster, "ghost", SELF).ok, false, "no match is refused");

expectEqual(stampMessage("animator", "  build is green  "), "[from animator] build is green", "stamps verified sender and trims");
expectEqual(stampMessage("animator", "[from animator] already stamped"), "[from animator] already stamped", "stamp is idempotent for this sender");
expectEqual(
	stampMessage("animator", "[from spoofed] sneaky"),
	"[from animator] [from spoofed] sneaky",
	"a spoofed stamp is exposed in front of, not replaced by, the real one",
);

console.log("herdr_message smoke OK");
