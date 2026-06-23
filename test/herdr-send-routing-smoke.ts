import { normalizeHerdrSend } from "../agent/tools/herdr_send.ts";

function expectEqual(actual: unknown, expected: unknown, label: string): void {
	const actualJson = JSON.stringify(actual);
	const expectedJson = JSON.stringify(expected);
	if (actualJson !== expectedJson) {
		throw new Error(`${label}: expected ${expectedJson}, got ${actualJson}`);
	}
}

expectEqual(
	normalizeHerdrSend({
		agent: "clanky:codex",
		pane: "",
		text: "",
		keys: ["ENTER"],
	}),
	{
		target: { kind: "agent", target: "clanky:codex" },
		keys: ["Enter"],
	},
	"agent keys-only send is valid",
);

expectEqual(
	normalizeHerdrSend({
		agent: " clanky:codex ",
		text: "hello",
		keys: ["return"],
	}),
	{
		target: { kind: "agent", target: "clanky:codex" },
		text: "hello",
		keys: ["Enter"],
	},
	"agent text plus enter is valid",
);

expectEqual(
	normalizeHerdrSend({
		pane: " pane-1 ",
		text: "hello",
		keys: ["esc", "Tab"],
	}),
	{
		target: { kind: "pane", paneId: "pane-1" },
		text: "hello",
		keys: ["Escape", "Tab"],
	},
	"pane text plus keys is valid",
);

let rejectedEmpty = false;
try {
	normalizeHerdrSend({ agent: "", pane: "", text: "", keys: [] });
} catch {
	rejectedEmpty = true;
}
if (!rejectedEmpty) throw new Error("empty send should be rejected");

console.log("herdr_send routing smoke OK");
