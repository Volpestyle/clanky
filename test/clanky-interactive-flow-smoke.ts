import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import {
	InteractiveSelectPrompt,
	InteractiveTextPrompt,
	type InteractivePromptOption,
} from "../agent/lib/clanky-interactive-flow.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const theme = {
	description: (text: string) => text,
	noMatch: (text: string) => text,
	scrollInfo: (text: string) => text,
	selectedPrefix: (text: string) => text,
	selectedText: (text: string) => text,
};

function assertFits(lines: readonly string[], width: number, label: string): void {
	for (const line of lines) {
		assert(visibleWidth(line) <= width, `${label} rendered a line wider than ${width}: ${JSON.stringify(line)}`);
	}
}

let textSubmitted: string | undefined;
let textCancelled = false;
let renderCount = 0;
const textPrompt = new InteractiveTextPrompt({
	message: "Enter the local model id.",
	onCancel: () => {
		textCancelled = true;
	},
	onRender: () => {
		renderCount += 1;
	},
	onSubmit: (value) => {
		textSubmitted = value;
	},
	placeholder: "qwen3-coder",
});
textPrompt.focused = true;
textPrompt.handleInput("qwen");
textPrompt.handleInput("\n");
assert(textSubmitted === "qwen", "text prompt should submit typed input");
assert(!textCancelled, "text prompt should not cancel when submitted");
assert(renderCount > 0, "text prompt should request renders while typing");
assertFits(textPrompt.render(44), 44, "text prompt");

const selectOptions: InteractivePromptOption[] = [
	{ value: "codex", label: "codex", description: "OpenAI subscription" },
	{ value: "claude", label: "claude", description: "Anthropic subscription" },
	{ value: "local", label: "local", description: "OpenAI-compatible local endpoint" },
];

let singleSelected: readonly string[] | undefined;
const singlePrompt = new InteractiveSelectPrompt({
	kind: "single",
	message: "Choose provider.",
	onCancel: () => {
		singleSelected = undefined;
	},
	onRender: () => undefined,
	onSubmit: (values) => {
		singleSelected = values;
	},
	options: selectOptions,
	required: true,
	theme,
});
singlePrompt.focused = true;
singlePrompt.handleInput("cl");
const filteredSingleRows = singlePrompt.render(60);
assert(filteredSingleRows.some((line) => line.includes("claude")), "single select filter should show matching options");
assert(filteredSingleRows.some((line) => line.includes("Filter: cl") && line.includes("1/3")), "single select should render filter counts");
assert(filteredSingleRows.some((line) => line.includes(CURSOR_MARKER)), "focused select should render a cursor marker on the filter row");
assert(filteredSingleRows.some((line) => line.includes("Anthropic subscription")), "single select should render current option detail");
singlePrompt.handleInput("\r");
assert(singleSelected?.[0] === "claude", "single select should submit the filtered highlighted value");
assertFits(singlePrompt.render(50), 50, "single select");

let multiSelected: readonly string[] | undefined;
const multiPrompt = new InteractiveSelectPrompt({
	initialValues: ["codex"],
	kind: "multi",
	message: "Choose allowed harness providers.",
	onCancel: () => {
		multiSelected = undefined;
	},
	onRender: () => undefined,
	onSubmit: (values) => {
		multiSelected = values;
	},
	options: selectOptions,
	required: true,
	theme,
});
multiPrompt.handleInput("cla");
multiPrompt.handleInput("\x15");
assert(multiPrompt.render(52).some((line) => line.includes("3/3")), "ctrl-u should clear the multi-select filter");
multiPrompt.handleInput("cla");
multiPrompt.handleInput(" ");
multiPrompt.handleInput("\r");
assert(
	multiSelected !== undefined && multiSelected.includes("codex") && multiSelected.includes("claude"),
	"multi select should preserve initial values and toggle filtered values",
);
assertFits(multiPrompt.render(52), 52, "multi select");

let toggleAllSelected: readonly string[] | undefined;
const toggleAllPrompt = new InteractiveSelectPrompt({
	kind: "multi",
	message: "Choose all visible values.",
	onCancel: () => undefined,
	onRender: () => undefined,
	onSubmit: (values) => {
		toggleAllSelected = values;
	},
	options: selectOptions,
	theme,
});
toggleAllPrompt.handleInput("\x01");
toggleAllPrompt.handleInput("\r");
assert(toggleAllSelected?.length === selectOptions.length, "ctrl-a should select all filtered values");

let requiredSubmit: readonly string[] | undefined;
const requiredPrompt = new InteractiveSelectPrompt({
	kind: "multi",
	message: "At least one value is required.",
	onCancel: () => undefined,
	onRender: () => undefined,
	onSubmit: (values) => {
		requiredSubmit = values;
	},
	options: selectOptions,
	required: true,
	theme,
});
requiredPrompt.handleInput("\r");
assert(requiredSubmit === undefined, "required multi select should not submit an empty selection");
assert(requiredPrompt.render(60).some((line) => line.includes("Select at least one option.")), "required multi select should render validation");

console.log("clanky-interactive-flow-smoke: ok");
