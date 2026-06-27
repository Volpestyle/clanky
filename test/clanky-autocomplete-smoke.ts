import { visibleWidth, type AutocompleteProvider } from "@earendil-works/pi-tui";
import {
	clankyCommandCompletion,
	createClankyAutocompleteProvider,
	describeClankyCommand,
	formatClankyCommandInspector,
	searchClankyCommands,
	type ClankyAutocompleteCommand,
} from "../agent/lib/clanky-autocomplete.ts";
import {
	ClankyCommandTypeaheadPanel,
	ClankyCommandWorkbench,
	clankyCommandTypeaheadFor,
	dismissClankyCommandTypeahead,
	inlineClankyCommandHint,
	moveClankyCommandTypeaheadSelection,
	renderClankyCommandTypeahead,
	selectedClankyCommandTypeahead,
} from "../agent/lib/clanky-command-ui.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function assertFits(lines: readonly string[], width: number, label: string): void {
	for (const line of lines) {
		assert(visibleWidth(line) <= width, `${label} line should fit width ${width}: ${JSON.stringify(line)}`);
	}
}

const theme = {
	bold: (text: string) => text,
	cyan: (text: string) => text,
	dim: (text: string) => text,
	green: (text: string) => text,
	red: (text: string) => text,
	yellow: (text: string) => text,
};

const commands: ClankyAutocompleteCommand[] = [
	{
		name: "discord-token",
		aliases: ["token"],
		description: "Set the Discord credential and restart Clanky",
		argumentHint: "[status|<token>] [--user-token] [--voice]",
		takesArgument: true,
	},
	{
		name: "model",
		aliases: [],
		description: "Configure Codex or Claude subscription-backed model",
		argumentHint: "[status|codex|claude|local] [id] [effort]",
		takesArgument: true,
	},
	{
		name: "effort",
		aliases: [],
		description: "Set reasoning effort for the active provider",
		argumentHint: "[status|minimal|low|medium|high|xhigh|unset]",
		takesArgument: true,
	},
	{
		name: "image-model",
		aliases: ["images"],
		description: "Set OpenAI image generation model",
		argumentHint: "[model-id|status|unset]",
		takesArgument: true,
	},
	{
		name: "voice",
		aliases: [],
		description: "Configure Discord voice runtime",
		argumentHint: "[status|provider|model|realtime-voice|tts|elevenlabs|memory|eve-session] [value]",
		takesArgument: true,
	},
	{
		name: "integrations",
		aliases: [],
		description: "Bind integration roles to connections",
		argumentHint: "[status|role] [connection|unset]",
		takesArgument: true,
	},
	{
		name: "mcp",
		aliases: [],
		description: "Manage dynamic MCPs and curated MCP connection auth",
		argumentHint: "[status|list|add|remove|enable|disable|auth|install]",
		takesArgument: true,
	},
	{
		name: "browser",
		aliases: ["bridge"],
		description: "Install or inspect the browser-control extension bridge",
		argumentHint: "[status|install]",
		takesArgument: true,
	},
	{
		name: "trace",
		aliases: [],
		description: "Show compact per-turn stream traces",
		argumentHint: "[status|off|no-reply|all]",
		takesArgument: true,
	},
];

const provider = createClankyAutocompleteProvider(commands, process.cwd(), {
	listMcpConnectionNames: () => ["linear", "figma"],
	listMcpServerNames: () => ["local-tools", "browser-tools"],
}) as AutocompleteProvider;

const signal = new AbortController().signal;

const commandProviderSuggestions = await provider.getSuggestions(["/tok"], 0, 4, { signal });
assert(commandProviderSuggestions === null, "command token suggestions should be owned by the command typeahead");

const aliasState = clankyCommandTypeaheadFor(commands, "/tok");
assert(aliasState !== undefined, "alias query should produce typeahead state");
assert(selectedClankyCommandTypeahead(aliasState)?.name === "discord-token", "alias query should select the canonical command");
assert(clankyCommandCompletion(selectedClankyCommandTypeahead(aliasState)!) === "/discord-token ", "alias completion should insert the canonical slash command");
const aliasRows = renderClankyCommandTypeahead(aliasState, theme, 72);
assert(aliasRows.some((line) => line.includes("/discord-token")), "typeahead should render the canonical command");
assertFits(aliasRows, 72, "alias typeahead");

const exactMcpState = clankyCommandTypeaheadFor(commands, "/mcp");
assert(exactMcpState !== undefined, "exact command should produce typeahead state");
assert(inlineClankyCommandHint(exactMcpState) === "[status|list|add|remove|enable|disable|auth|install]", "exact command should collapse to an inline argument hint");
const exactAliasState = clankyCommandTypeaheadFor(commands, "/token");
assert(exactAliasState !== undefined, "exact alias should produce typeahead state");
assert(selectedClankyCommandTypeahead(exactAliasState)?.name === "discord-token", "exact alias should keep the aliased command selected");
assert(inlineClankyCommandHint(exactAliasState) === "[status|<token>] [--user-token] [--voice]", "exact alias should collapse to the command argument hint");

const rootState = clankyCommandTypeaheadFor(commands, "/");
assert(rootState !== undefined, "bare slash should produce command typeahead state");
assert(renderClankyCommandTypeahead(rootState, theme, 72, 2).length === 2, "typeahead should respect a short row budget");
assert(renderClankyCommandTypeahead(rootState, theme, 72, 0).length === 0, "typeahead should hide when no row budget remains");
const wrappedState = moveClankyCommandTypeaheadSelection(rootState, -1);
assert(selectedClankyCommandTypeahead(wrappedState)?.name === "trace", "typeahead selection should wrap when moving up from the first row");
const dismissedState = dismissClankyCommandTypeahead(rootState);
const sameDismissed = clankyCommandTypeaheadFor(commands, "/", dismissedState);
assert(sameDismissed?.dismissed === true, "dismissed typeahead should stay dismissed for the same query");
const changedAfterDismiss = clankyCommandTypeaheadFor(commands, "/m", dismissedState);
assert(changedAfterDismiss?.dismissed === false, "editing the query should reopen typeahead");
assert(clankyCommandTypeaheadFor(commands, "", rootState) === undefined, "backspacing slash away should clear typeahead");

const modelSuggestions = await provider.getSuggestions(["/model c"], 0, 8, { signal });
assert(modelSuggestions !== null, "model argument query should produce provider suggestions");
assert(modelSuggestions.items.some((item) => item.value === "codex"), "model argument completion should include codex");
const modelStatusSuggestions = await provider.getSuggestions(["/model st"], 0, 9, { signal });
assert(modelStatusSuggestions !== null, "model status query should produce suggestions");
assert(modelStatusSuggestions.items.some((item) => item.value === "status"), "model argument completion should include status");

const effortSuggestions = await provider.getSuggestions(["/effort st"], 0, 10, { signal });
assert(effortSuggestions !== null, "effort status query should produce suggestions");
assert(effortSuggestions.items.some((item) => item.value === "status"), "effort argument completion should include status");

const tokenStatusSuggestions = await provider.getSuggestions(["/discord-token st"], 0, 17, { signal });
assert(tokenStatusSuggestions !== null, "discord-token status query should produce suggestions");
assert(tokenStatusSuggestions.items.some((item) => item.value === "status"), "discord-token argument completion should include status");

const imageModelSuggestions = await provider.getSuggestions(["/image-model st"], 0, 15, { signal });
assert(imageModelSuggestions !== null, "image model argument query should produce suggestions");
assert(imageModelSuggestions.items.some((item) => item.value === "status"), "image model argument completion should include status");

const voiceStatusSuggestions = await provider.getSuggestions(["/voice st"], 0, 9, { signal });
assert(voiceStatusSuggestions !== null, "voice status query should produce suggestions");
assert(voiceStatusSuggestions.items.some((item) => item.value === "status"), "voice argument completion should include status");

const integrationStatusSuggestions = await provider.getSuggestions(["/integrations st"], 0, 16, { signal });
assert(integrationStatusSuggestions !== null, "integration status query should produce suggestions");
assert(integrationStatusSuggestions.items.some((item) => item.value === "status"), "integration argument completion should include status");

const browserSuggestions = await provider.getSuggestions(["/browser in"], 0, 11, { signal });
assert(browserSuggestions !== null, "browser argument query should produce suggestions");
assert(browserSuggestions.items.some((item) => item.value === "install"), "browser argument completion should include install");

const mcpActionSuggestions = await provider.getSuggestions(["/mcp a"], 0, 6, { signal });
assert(mcpActionSuggestions !== null, "mcp action query should produce action suggestions");
assert(mcpActionSuggestions.items.some((item) => item.value === "auth"), "mcp action completion should include auth");

const mcpConnectionSuggestions = await provider.getSuggestions(["/mcp auth li"], 0, 12, { signal });
assert(mcpConnectionSuggestions !== null, "mcp auth query should produce dynamic connection suggestions");
assert(mcpConnectionSuggestions.items.some((item) => item.value === "linear"), "mcp auth completion should include dynamic connection names");
const mcpConnectionCompletion = provider.applyCompletion(["/mcp auth li"], 0, 12, { value: "linear", label: "linear" }, mcpConnectionSuggestions.prefix);
assert(mcpConnectionCompletion.lines[0] === "/mcp auth linear ", "dynamic argument completion should replace the current token");

const mcpServerSuggestions = await provider.getSuggestions(["/mcp remove loc"], 0, 15, { signal });
assert(mcpServerSuggestions !== null, "mcp remove query should produce dynamic server suggestions");
assert(mcpServerSuggestions.items.some((item) => item.value === "local-tools"), "mcp remove completion should include dynamic server names");

const commandSearch = searchClankyCommands(commands, "dynamic");
assert(commandSearch[0]?.command.name === "mcp", "workbench search should match command descriptions");
const mcpDetail = describeClankyCommand(commands.find((command) => command.name === "mcp")!);
assert(mcpDetail.validArgs.some((item) => item.value === "auth"), "command detail should expose valid next args");
assert(mcpDetail.examples.includes("/mcp status"), "command detail should expose examples");

const panel = new ClankyCommandTypeaheadPanel(commands, theme);
panel.setText("/mcp ", undefined);
const panelRows = panel.render(76);
assert(panelRows.some((line) => line.includes("next")), "typeahead panel should show argument details after command whitespace");
assertFits(panelRows, 76, "argument detail panel");
panel.setText("/", rootState, true);
assert(panel.render(76).length === 0, "typeahead panel should stay hidden while setup/input overlays own keys");

const shortPanel = new ClankyCommandTypeaheadPanel(commands, theme, { maxVisibleRows: () => 2 });
shortPanel.setText("/", rootState);
assert(shortPanel.render(76).length === 2, "typeahead panel should cap list height from the layout budget");
shortPanel.setText("/mcp ", undefined);
assert(shortPanel.render(76).length <= 2, "argument detail panel should cap height from the layout budget");
const hiddenPanel = new ClankyCommandTypeaheadPanel(commands, theme, { maxVisibleRows: () => 0 });
hiddenPanel.setText("/", rootState);
assert(hiddenPanel.render(76).length === 0, "typeahead panel should hide when the layout budget is exhausted");

let submitted = "";
let cancelled = false;
const workbench = new ClankyCommandWorkbench(commands, {
	onCancel: () => {
		cancelled = true;
	},
	onRender: () => undefined,
	onSubmit: (text) => {
		submitted = text;
	},
}, theme, "tok");
assert(workbench.getFilter() === "tok", "workbench should keep the initial filter");
assert(workbench.getSelectedCommand()?.name === "discord-token", "workbench should search aliases");
assertFits(workbench.render(88), 88, "wide workbench");
assertFits(workbench.render(48), 48, "narrow workbench");
assert(workbench.render(88)[0]?.startsWith("┌") === true, "workbench should render a solid outline");
workbench.handleInput("\r");
assert(submitted === "/discord-token ", "workbench enter should insert the canonical command skeleton");
workbench.handleInput("\x1b");
assert(cancelled, "workbench escape should cancel without submitting");

submitted = "";
const exampleWorkbench = new ClankyCommandWorkbench(commands, {
	onCancel: () => undefined,
	onRender: () => undefined,
	onSubmit: (text) => {
		submitted = text;
	},
}, theme, "mcp");
exampleWorkbench.handleInput("\t");
assert(submitted === "/mcp status", "workbench tab should insert the first example when available");

const inspector = formatClankyCommandInspector("/mcp a", commands);
assert(inspector.includes("**/mcp"), "inspector should identify the active command");
assert(inspector.includes("Valid next args:"), "inspector should show valid next args");
assert(inspector.includes("/mcp auth linear"), "inspector should show useful examples");
assert(!inspector.includes("Warning: unknown first arg"), "partial valid arguments should not warn while the user is typing");

console.log("clanky-autocomplete-smoke: ok");
