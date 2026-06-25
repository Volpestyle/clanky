import assert from "node:assert/strict";
import {
	formatPromptHistoryJsonl,
	installPromptHistoryPrototype,
	parsePromptHistoryJsonl,
	type PromptHistoryLike,
} from "../agent/lib/tui-prompt-history.ts";

class TestPromptHistory implements PromptHistoryLike {
	add(_entry: string): void {}
	begin(_draft: string): void {}
	previous(_currentDraft: string): string | undefined {
		return undefined;
	}
	next(): string | undefined {
		return undefined;
	}
}

const appended: string[] = [];
const rewrites: string[][] = [];
installPromptHistoryPrototype(TestPromptHistory, {
	entries: ["one", "two"],
	maxEntries: 3,
	onEntryAdded: (entry) => appended.push(entry),
	onEntriesChanged: (entries) => rewrites.push([...entries]),
});

const history = new TestPromptHistory();
history.begin("draft");
assert.equal(history.previous("draft"), "two", "up recalls newest entry");
assert.equal(history.previous("two"), "one", "up steps toward older entries");
assert.equal(history.previous("one"), undefined, "up stops at the oldest entry");
assert.equal(history.next(), "two", "down steps toward newer entries");
assert.equal(history.next(), "draft", "down restores the live draft after newest entry");
assert.equal(history.next(), undefined, "down stops after restoring the live draft");

history.add("");
history.add("two");
assert.deepEqual(appended, [], "blank and consecutive duplicate entries are not persisted");

history.add("three");
assert.deepEqual(appended, ["three"], "new entries append to persistence");
history.add("four");
assert.deepEqual(rewrites, [["two", "three", "four"]], "history rewrites when max entries are trimmed");

history.begin("");
assert.equal(history.previous(""), "four", "newest added entry is recalled first");
assert.equal(history.previous("four"), "three", "trimmed history keeps the middle entry");
assert.equal(history.previous("three"), "two", "trimmed history keeps max entries");
assert.equal(history.previous("two"), undefined, "trimmed oldest boundary is respected");

const parsed = parsePromptHistoryJsonl('{"prompt":"one"}\n"two"\nnot json\n{"prompt":""}\n{"prompt":"two"}\n', 10);
assert.deepEqual(parsed, ["one", "two"], "parser accepts current and legacy records, skips invalid/blank/duplicate entries");
assert.equal(
	formatPromptHistoryJsonl(["", "one", "one", "two"]),
	'{"prompt":"one"}\n{"prompt":"two"}\n',
	"formatter writes normalized JSONL records",
);

console.log("tui-prompt-history smoke ok");
