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

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/gu, "");
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
assert(stripAnsi(textPrompt.render(44)[0] ?? "").startsWith("┌"), "text prompt should render a solid outline");

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
assert(stripAnsi(filteredSingleRows[0] ?? "").startsWith("┌"), "single select should render a solid outline");
assert(filteredSingleRows.some((line) => line.includes("Provider")), "single select should derive a contextual title");
assert(filteredSingleRows.some((line) => line.includes("claude")), "single select filter should show matching options");
assert(filteredSingleRows.some((line) => line.includes("filter \"cl\"") && line.includes("Showing 1 of 3")), "single select should render filtered status text");
assert(filteredSingleRows.some((line) => line.includes(CURSOR_MARKER)), "focused select should render a cursor marker on the filter row");
assert(filteredSingleRows.some((line) => line.includes("Anthropic subscription")), "single select should render current option detail");
singlePrompt.handleInput("\r");
assert(singleSelected?.[0] === "claude", "single select should submit the filtered highlighted value");
assertFits(singlePrompt.render(50), 50, "single select");

let rightSelected: readonly string[] | undefined;
const rightPrompt = new InteractiveSelectPrompt({
	kind: "single",
	message: "Choose provider.",
	onCancel: () => undefined,
	onRender: () => undefined,
	onSubmit: (values) => {
		rightSelected = values;
	},
	options: selectOptions,
	theme,
});
rightPrompt.handleInput("\x1b[B");
rightPrompt.handleInput("\x1b[C");
assert(rightSelected?.[0] === "claude", "right arrow should choose the highlighted single-select option");
assert(rightPrompt.render(60).some((line) => stripAnsi(line).includes("Enter/→ chooses")), "single select should advertise right-arrow choose");

const currentPrompt = new InteractiveSelectPrompt({
	currentValue: "local",
	initialValue: "local",
	kind: "single",
	message: "Place the chat input.",
	onCancel: () => undefined,
	onRender: () => undefined,
	onSubmit: () => undefined,
	options: selectOptions,
	theme,
});
const currentRows = currentPrompt.render(72).map(stripAnsi);
assert(currentRows.some((line) => line.includes("local (current)")), "single select should mark the current value");
assert(currentRows.some((line) => line.includes("> local (current)")), "single select should hover the current initial value");

const descriptionActionPrompt = new InteractiveSelectPrompt({
	kind: "single",
	message: "Choose a setting.",
	onCancel: () => undefined,
	onRender: () => undefined,
	onSubmit: () => undefined,
	options: [
		{ value: "setting", label: "setting", description: "normal row" },
		{ value: "details", label: "", description: "show details" },
	],
	theme,
});
const descriptionActionRows = descriptionActionPrompt.render(72).map(stripAnsi);
const normalDetailRow = descriptionActionRows.find((line) => line.includes("normal row"));
const statusToggleRow = descriptionActionRows.find((line) => line.includes("show details"));
assert(normalDetailRow !== undefined, "description action fixture should render a normal detail row");
assert(statusToggleRow !== undefined, "description action should render its action text");
assert(
	statusToggleRow.indexOf("show details") === normalDetailRow.indexOf("normal row"),
	"description action should align with the detail column instead of the option-label column",
);

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
const clearedMultiRows = multiPrompt.render(52);
assert(!clearedMultiRows.some((line) => line.includes("Showing")), "unfiltered multi-select status should avoid count noise");
assert(clearedMultiRows.some((line) => stripAnsi(line).includes("Enter/→ saves")), "multi select should advertise right-arrow save");
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

const backTextPrompt = new InteractiveTextPrompt({
	allowBack: true,
	message: "Set the realtime voice.",
	onCancel: () => undefined,
	onRender: () => undefined,
	onSubmit: () => undefined,
});
assert(
	backTextPrompt.render(60).some((line) => stripAnsi(line).includes("Esc goes back")),
	"allowBack text prompt should render a back hint",
);

let backCancelled = false;
let backSubmitted = false;
const backPrompt = new InteractiveSelectPrompt({
	allowBack: true,
	kind: "single",
	message: "Choose provider.",
	onCancel: () => {
		backCancelled = true;
	},
	onRender: () => undefined,
	onSubmit: () => {
		backSubmitted = true;
	},
	options: selectOptions,
	theme,
});
backPrompt.focused = true;
assert(backPrompt.render(100).some((line) => stripAnsi(line).includes("← Back")), "allowBack select should render a back hint");
backPrompt.handleInput("\x1b[D");
assert(backCancelled, "left arrow should trigger back when allowBack is set");
assert(!backSubmitted, "left arrow should not submit");

let noBackCancelled = false;
const noBackPrompt = new InteractiveSelectPrompt({
	kind: "single",
	message: "Choose provider.",
	onCancel: () => {
		noBackCancelled = true;
	},
	onRender: () => undefined,
	onSubmit: () => undefined,
	options: selectOptions,
	theme,
});
noBackPrompt.focused = true;
assert(noBackPrompt.render(100).some((line) => stripAnsi(line).includes("Esc cancels")), "select without allowBack should keep the cancel hint");
noBackPrompt.handleInput("\x1b[D");
assert(!noBackCancelled, "left arrow should be inert when allowBack is not set");

console.log("clanky-interactive-flow-smoke: ok");
