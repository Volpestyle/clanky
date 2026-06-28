import {
	CombinedAutocompleteProvider,
	fuzzyFilter,
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
} from "@earendil-works/pi-tui";

type Awaitable<T> = T | Promise<T>;

export type ClankyAutocompleteCommand = {
	readonly name: string;
	readonly aliases: readonly string[];
	readonly description: string;
	readonly argumentHint?: string;
	readonly takesArgument: boolean;
};

export type ClankyAutocompleteOptions = {
	readonly listMcpConnectionNames?: () => Awaitable<readonly string[]>;
	readonly listMcpServerNames?: () => Awaitable<readonly string[]>;
	readonly listIntegrationConnectionNames?: () => Awaitable<readonly string[]>;
};

type ArgumentContext = {
	readonly args: readonly string[];
	readonly argumentText: string;
	readonly prefix: string;
};

type CommandMatch = {
	readonly command: ClankyAutocompleteCommand;
	readonly canonical: boolean;
};

type StaticArgumentSpec = {
	readonly values: readonly AutocompleteItem[];
	readonly examples: readonly string[];
};

export type ClankyCommandSearchItem = {
	readonly command: ClankyAutocompleteCommand;
	readonly category: string;
	readonly invocation: string;
	readonly aliasesText: string;
	readonly description: string;
};

export type ClankyCommandDetail = {
	readonly command: ClankyAutocompleteCommand;
	readonly invocation: string;
	readonly category: string;
	readonly aliases: readonly string[];
	readonly description: string;
	readonly validArgs: readonly AutocompleteItem[];
	readonly examples: readonly string[];
	readonly warning?: string;
};

const COMMAND_SUGGESTION_LIMIT = 18;
const ARGUMENT_SUGGESTION_LIMIT = 18;

export function createClankyAutocompleteProvider(
	commands: readonly ClankyAutocompleteCommand[],
	basePath: string,
	options: ClankyAutocompleteOptions = {},
): AutocompleteProvider {
	return new ClankyAutocompleteProvider(commands, basePath, options);
}

export function formatClankyCommandInspector(input: string, commands: readonly ClankyAutocompleteCommand[]): string {
	const trimmedStart = input.trimStart();
	if (!trimmedStart.startsWith("/")) return "";
	const parsed = parseSlashInput(trimmedStart);
	if (parsed.commandToken.length === 0) {
		return [
			"**Command palette**",
			"",
			"Type a command name or alias. Use Tab to accept a highlighted suggestion.",
			"",
			...formatCommandSuggestionLines(commands.slice(0, 8)),
		].join("\n");
	}

	const match = findCommand(commands, parsed.commandToken);
	if (match === undefined) {
		const suggestions = commandSuggestions(commands, parsed.commandToken).slice(0, 6);
		return [
			`**/${parsed.commandToken}**`,
			"",
			"Unknown command.",
			suggestions.length === 0 ? "No close matches." : "Close matches:",
			...formatCommandSuggestionLines(suggestions),
		].join("\n");
	}

	const command = match.command;
	const detail = describeClankyCommand(command, parsed.argumentText);
	const lines = [
		`**${detail.invocation}**`,
		detail.description,
	];
	if (detail.aliases.length > 0) lines.push(`Aliases: ${detail.aliases.map((alias) => `/${alias}`).join(", ")}`);
	if (detail.warning !== undefined) lines.push(`Warning: ${detail.warning}`);
	if (detail.validArgs.length > 0) {
		lines.push("Valid next args:", detail.validArgs.slice(0, 10).map(formatArgumentItem).join(", "));
	}
	if (detail.examples.length > 0) {
		lines.push("Examples:", ...detail.examples.slice(0, 4).map((example) => `- ${example}`));
	}
	return lines.join("\n");
}

export function searchClankyCommands(commands: readonly ClankyAutocompleteCommand[], query: string): ClankyCommandSearchItem[] {
	const trimmed = query.trim();
	if (trimmed.length === 0) return listClankyCommands(commands);
	return fuzzyFilter([...commands], trimmed, commandSearchText).map(commandSearchItem);
}

export function listClankyCommands(commands: readonly ClankyAutocompleteCommand[]): ClankyCommandSearchItem[] {
	return commands.map(commandSearchItem);
}

export function describeClankyCommand(command: ClankyAutocompleteCommand, argumentText = ""): ClankyCommandDetail {
	const context = argumentContext(argumentText);
	const staticSpec = staticArgumentSpec(command.name, context);
	return {
		command,
		invocation: commandInvocation(command),
		category: commandCategory(command.name),
		aliases: command.aliases,
		description: command.description,
		validArgs: staticSpec.values,
		examples: staticSpec.examples,
		warning: argumentWarning(command, staticSpec, argumentText),
	};
}

export function clankyCommandCompletion(command: ClankyAutocompleteCommand): string {
	return `/${command.name}${command.takesArgument ? " " : ""}`;
}

class ClankyAutocompleteProvider implements AutocompleteProvider {
	readonly triggerCharacters: string[] = [];
	private readonly commands: readonly ClankyAutocompleteCommand[];
	private readonly delegate: CombinedAutocompleteProvider;
	private readonly options: ClankyAutocompleteOptions;

	constructor(commands: readonly ClankyAutocompleteCommand[], basePath: string, options: ClankyAutocompleteOptions) {
		this.commands = commands;
		this.delegate = new CombinedAutocompleteProvider([], basePath);
		this.options = options;
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const currentLine = lines[cursorLine] ?? "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		if (!textBeforeCursor.trimStart().startsWith("/")) {
			return await this.delegate.getSuggestions(lines, cursorLine, cursorCol, options);
		}

		const parsed = parseSlashInput(textBeforeCursor.trimStart());
		if (parsed.commandToken.length === 0 || !parsed.hasArgumentText) return null;

		const match = findCommand(this.commands, parsed.commandToken);
		if (match === undefined || !match.command.takesArgument) return null;

		const context = argumentContext(parsed.argumentText);
		const items = await this.argumentSuggestions(match.command.name, context);
		if (items.length === 0) return null;
		return { items: items.slice(0, ARGUMENT_SUGGESTION_LIMIT), prefix: context.prefix };
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const currentLine = lines[cursorLine] ?? "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		if (!textBeforeCursor.trimStart().startsWith("/")) {
			return this.delegate.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		}

		const beforePrefix = currentLine.slice(0, Math.max(0, cursorCol - prefix.length));
		const afterCursor = currentLine.slice(cursorCol);
		const isCommandCompletion = prefix.startsWith("/");
		const completed = isCommandCompletion ? `${beforePrefix}/${item.value} ` : `${beforePrefix}${item.value} `;
		const nextLines = [...lines];
		nextLines[cursorLine] = completed + afterCursor.replace(/^\s+/u, "");
		return { lines: nextLines, cursorLine, cursorCol: completed.length };
	}

	shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
		const currentLine = lines[cursorLine] ?? "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		if (textBeforeCursor.trimStart().startsWith("/")) return true;
		return this.delegate.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false;
	}

	private async argumentSuggestions(commandName: string, context: ArgumentContext): Promise<AutocompleteItem[]> {
		const staticItems = staticArgumentSpec(commandName, context).values;
		const dynamicItems = await this.dynamicArgumentItems(commandName, context);
		const combined = uniqueAutocompleteItems([...staticItems, ...dynamicItems]);
		return fuzzyFilter(combined, context.prefix, (item) => `${item.value} ${item.label} ${item.description ?? ""}`);
	}

	private async dynamicArgumentItems(commandName: string, context: ArgumentContext): Promise<AutocompleteItem[]> {
		if (commandName === "mcp") return await this.dynamicMcpItems(context);
		if (commandName === "auth") return await this.dynamicAuthItems(context);
		if (commandName === "integrations") return await this.dynamicIntegrationItems(context);
		return [];
	}

	private async dynamicMcpItems(context: ArgumentContext): Promise<AutocompleteItem[]> {
		const action = context.args[0]?.toLowerCase();
		if (action === "list" || action === "remove" || action === "enable" || action === "disable") {
			const names = await this.options.listMcpServerNames?.();
			return namesToItems(names ?? [], "dynamic MCP server");
		}
		if (action === "auth" || action === "install") {
			const names = await this.options.listMcpConnectionNames?.();
			return namesToItems(names ?? [], "curated MCP connection");
		}
		return [];
	}

	private async dynamicAuthItems(context: ArgumentContext): Promise<AutocompleteItem[]> {
		if (context.args[0]?.toLowerCase() !== "mcp") return [];
		const names = await this.options.listMcpConnectionNames?.();
		return namesToItems(names ?? [], "curated MCP connection");
	}

	private async dynamicIntegrationItems(context: ArgumentContext): Promise<AutocompleteItem[]> {
		if (context.args.length <= 1) return [];
		const names = await this.options.listIntegrationConnectionNames?.();
		return [{ value: "unset", label: "unset", description: "Clear this role binding" }, ...namesToItems(names ?? [], "connection")];
	}
}

function parseSlashInput(text: string): { commandToken: string; argumentText: string; hasArgumentText: boolean } {
	const withoutSlash = text.startsWith("/") ? text.slice(1) : text;
	const match = /^(\S*)(\s+([\s\S]*))?$/u.exec(withoutSlash);
	return {
		commandToken: match?.[1]?.toLowerCase() ?? "",
		argumentText: match?.[3] ?? "",
		hasArgumentText: match?.[2] !== undefined,
	};
}

function argumentContext(argumentText: string): ArgumentContext {
	const trimmedLeft = argumentText.replace(/^\s+/u, "");
	const endsWithSpace = /\s$/u.test(argumentText);
	const args = splitArgumentTokens(trimmedLeft);
	const prefix = endsWithSpace ? "" : (args.at(-1) ?? "");
	return { args, argumentText, prefix };
}

function splitArgumentTokens(text: string): string[] {
	return text.trim().length === 0 ? [] : text.trim().split(/\s+/u);
}

function findCommand(commands: readonly ClankyAutocompleteCommand[], token: string): CommandMatch | undefined {
	const normalized = token.toLowerCase();
	const command = commands.find((entry) => entry.name === normalized);
	if (command !== undefined) return { command, canonical: true };
	const alias = commands.find((entry) => entry.aliases.some((value) => value === normalized));
	return alias === undefined ? undefined : { command: alias, canonical: false };
}

function commandSuggestions(commands: readonly ClankyAutocompleteCommand[], prefix: string): AutocompleteItem[] {
	return searchClankyCommands(commands, prefix).map((item) => commandItem(item.command));
}

function commandItem(command: ClankyAutocompleteCommand): AutocompleteItem {
	const aliasText = command.aliases.length === 0 ? "" : `aliases ${command.aliases.map((alias) => `/${alias}`).join(", ")}`;
	const category = commandCategory(command.name);
	return {
		value: command.name,
		label: commandInvocation(command),
		description: [category, aliasText, command.description].filter((part) => part.length > 0).join(" · "),
	};
}

function commandSearchItem(command: ClankyAutocompleteCommand): ClankyCommandSearchItem {
	return {
		command,
		category: commandCategory(command.name),
		invocation: commandInvocation(command),
		aliasesText: command.aliases.map((alias) => `/${alias}`).join(", "),
		description: command.description,
	};
}

function commandInvocation(command: ClankyAutocompleteCommand): string {
	return `/${command.name}${command.argumentHint === undefined ? "" : ` ${command.argumentHint}`}`;
}

function commandSearchText(command: ClankyAutocompleteCommand): string {
	return [command.name, ...command.aliases, command.description, command.argumentHint ?? "", commandCategory(command.name)].join(" ");
}

function formatCommandSuggestionLines(items: readonly (AutocompleteItem | ClankyAutocompleteCommand)[]): string[] {
	return items.map((item) => {
		const autocomplete = "value" in item ? item : commandItem(item);
		return `- ${autocomplete.label}${autocomplete.description === undefined ? "" : ` - ${autocomplete.description}`}`;
	});
}

function commandCategory(commandName: string): string {
	if (["model", "auth", "profile", "effort", "image-model", "video-model", "vision-model", "login"].includes(commandName)) return "model/auth";
	if (["harness", "spawn", "agents", "approvals", "agent-md", "skills", "trace", "layout", "status", "new", "clear", "exit"].includes(commandName)) return "runtime";
	if (["mcp", "integrations", "browser"].includes(commandName)) return "tools";
	if (["discord-token", "discord-scope", "voice"].includes(commandName)) return "discord";
	if (commandName === "pet") return "desktop";
	return "command";
}

function staticArgumentSpec(commandName: string, context: ArgumentContext): StaticArgumentSpec {
	switch (commandName) {
		case "discord-token":
			return values(["status", "--user-token", "--voice"], ["/discord-token status"]);
		case "model":
			return modelArguments(context);
		case "auth":
			return authArguments(context);
		case "profile":
			return values(["status", "local-tiered", "local-single", "api", "local-api", "api-local"], [
				"/profile status",
				"/profile local-tiered",
				"/profile local-tiered qwen3-vl:8b",
				"/profile local-single",
				"/profile api",
				"/profile local-api",
				"/profile api-local qwen3-vl:8b",
			]);
		case "effort":
			return values(["status", "minimal", "low", "medium", "high", "xhigh", "unset"], [
				"/effort status",
				"/effort high",
				"/effort unset",
			]);
		case "approvals":
			return values(["auto", "prompt", "status"], ["/approvals auto", "/approvals prompt"]);
		case "agent-md":
			return values(["status", "on", "off", "root", "clear-root"], ["/agent-md status", "/agent-md on", "/agent-md root ~/dev/project"]);
		case "trace":
			return values(["status", "off", "no-reply", "all"], ["/trace no-reply", "/trace all"]);
		case "layout":
			return layoutArguments(context);
		case "mcp":
			return mcpArguments(context);
		case "voice":
			return voiceArguments(context);
		case "harness":
			return harnessArguments(context);
		case "spawn":
			return spawnArguments(context);
		case "login":
			return values(["claude", "codex", "status"], ["/login codex", "/login claude"]);
		case "discord-scope":
			return discordScopeArguments(context);
		case "pet":
			return values(["status", "on", "off"], ["/pet status", "/pet on"]);
		case "browser":
			return values(["status", "install"], ["/browser status", "/browser install"]);
		case "image-model":
			return imageModelArguments(context);
		case "video-model":
			return values(["status", "xai", "grok-imagine-video", "unset"], ["/video-model xai grok-imagine-video", "/video-model status"]);
		case "vision-model":
			return values(["status", "local", "openai", "unset"], ["/vision-model local qwen3-vl:32b", "/vision-model unset"]);
		case "integrations":
			return integrationArguments(context);
		default:
			return { values: [], examples: [] };
	}
}

function modelArguments(context: ArgumentContext): StaticArgumentSpec {
	const provider = context.args[0]?.toLowerCase();
	if (provider === "status") return { values: [], examples: ["/model status"] };
	if (provider === "codex") {
		return values(
			["gpt-5.5", "gpt-5.4", "gpt-5.3-codex-spark", "minimal", "low", "medium", "high", "xhigh"],
			["/model codex gpt-5.5 high", "/model claude", "/model local qwen3-coder"],
		);
	}
	if (provider === "claude") {
		return values(["claude-opus-4-8", "claude-sonnet-4-6"], ["/model claude claude-opus-4-8"]);
	}
	if (provider === "local") {
		return { values: [], examples: ["/model local qwen3-coder:30b", "/model local qwen3-coder:30b http://127.0.0.1:11434/v1"] };
	}
	if (provider === "xai") {
		return values(["grok-4", "grok-4-fast", "grok-3"], ["/model xai grok-4"]);
	}
	if (provider === "gemini") {
		return values(["gemini-3-pro", "gemini-2.5-pro", "gemini-2.5-flash"], ["/model gemini gemini-3-pro"]);
	}
	return values(
		["status", "codex", "claude", "local", "xai", "gemini"],
		["/model status", "/model codex gpt-5.5 high", "/model xai grok-4", "/model gemini gemini-2.5-pro"],
	);
}

function authArguments(context: ArgumentContext): StaticArgumentSpec {
	const action = context.args[0]?.toLowerCase();
	if (action === "status") return { values: [], examples: ["/auth status"] };
	if (action === "login") return values(["codex", "claude", "status"], ["/auth login codex", "/auth login claude"]);
	if (action === "codex" || action === "claude") return values(["status"], [`/auth ${action}`]);
	if (action === "xai" || action === "gemini" || action === "openai" || action === "elevenlabs" || action === "relay" || action === "local-voice") {
		return values(["status"], [`/auth ${action}`]);
	}
	if (action === "discord") return values(["status", "--user-token", "--voice"], ["/auth discord status", "/auth discord --voice"]);
	if (action === "mcp") return { values: [], examples: ["/auth mcp linear", "/auth mcp figma"] };
	return values(
		["status", "codex", "claude", "xai", "gemini", "openai", "discord", "mcp", "elevenlabs", "relay", "local-voice", "login"],
		["/auth status", "/auth codex", "/auth xai", "/auth mcp linear"],
	);
}

function layoutArguments(context: ArgumentContext): StaticArgumentSpec {
	const setting = context.args[0]?.toLowerCase();
	if (setting === "input" || setting === "chat" || setting === "prompt") {
		return values(["top", "bottom"], ["/layout input top", "/layout input bottom"]);
	}
	if (setting === "status" || setting === "footer" || setting === "bar") {
		return values(["above", "below", "above-input", "below-input"], ["/layout status above", "/layout status below"]);
	}
	if (setting === "header" || setting === "banner") {
		return values(["on", "off", "toggle", "status"], ["/layout header off", "/layout header on"]);
	}
	return values(
		["status", "input", "top", "bottom", "footer", "header"],
		["/layout input top", "/layout status below", "/layout header off"],
	);
}

function imageModelArguments(context: ArgumentContext): StaticArgumentSpec {
	const provider = context.args[0]?.toLowerCase();
	if (provider === "openai") return values(["gpt-image-2"], ["/image-model openai gpt-image-2"]);
	if (provider === "xai") return values(["grok-imagine-image-quality", "grok-imagine-image-fast"], ["/image-model xai grok-imagine-image-quality"]);
	if (provider === "gemini") return values(["gemini-3.1-flash-image", "gemini-3-pro-image"], ["/image-model gemini gemini-3.1-flash-image"]);
	return values(
		["status", "openai", "xai", "gemini", "unset"],
		["/image-model status", "/image-model openai gpt-image-2", "/image-model gemini gemini-3.1-flash-image"],
	);
}

function mcpArguments(context: ArgumentContext): StaticArgumentSpec {
	const action = context.args[0]?.toLowerCase();
	if (action === "add" && context.args.length >= 2) return values(["stdio", "streamable-http", "sse"], ["/mcp add local-tools stdio node server.js"]);
	if (action === "auth" || action === "install") return { values: [], examples: ["/mcp auth linear", "/mcp auth figma"] };
	if (action === "list" || action === "remove" || action === "enable" || action === "disable") {
		return { values: [], examples: [`/mcp ${action} local-tools`] };
	}
	return values(["status", "list", "add", "remove", "enable", "disable", "auth", "install", "connections", "help"], [
		"/mcp status",
		"/mcp auth linear",
		"/mcp list local-tools",
	]);
}

function voiceArguments(context: ArgumentContext): StaticArgumentSpec {
	const setting = context.args[0]?.toLowerCase();
	if (setting === "mode" || setting === "provider" || setting === "realtime-provider") {
		return values(["openai", "xai", "local"], ["/voice mode local", "/voice mode openai"]);
	}
	if (setting === "tts-provider") return values(["realtime", "elevenlabs"], ["/voice tts-provider realtime"]);
	if (setting === "local-tts-engine") return values(["say", "command"], ["/voice local-tts-engine say"]);
	if (setting === "eve-session") return values(["on", "off"], ["/voice eve-session on"]);
	if (setting === "memory-limit") return values(["0", "8", "16", "32", "50"], ["/voice memory-limit 16"]);
	if (setting === "status") return { values: [], examples: ["/voice status"] };
	return values(
		[
			"status",
			"mode",
			"local-defaults",
			"realtime-model",
			"realtime-voice",
			"tts-provider",
			"asr-model",
			"asr-command",
			"local-base-url",
			"local-tts-engine",
			"local-tts-command",
			"elevenlabs-voice",
			"elevenlabs-model",
			"memory-limit",
			"eve-session",
		],
		["/voice mode local", "/voice mode openai", "/voice local-defaults"],
	);
}

function harnessArguments(context: ArgumentContext): StaticArgumentSpec {
	const first = context.args[0]?.toLowerCase();
	if (first === "allow") return values(["all", "clanky", "claude", "codex", "opencode", "custom"], ["/harness allow all"]);
	if (first === "claude" || first === "codex" || first === "opencode") {
		return values(["default", "ollama", "--launcher", "--model", "--runtime"], [`/harness ${first} ollama qwen3-coder:30b`]);
	}
	if (first === "custom") return values(["--runtime", "clanky", "native", "opencode"], ["/harness custom --runtime native node worker.js"]);
	return values(["status", "allow", "clanky", "claude", "codex", "opencode", "custom"], [
		"/harness status",
		"/harness allow clanky claude codex",
		"/harness codex ollama qwen3-coder:30b",
	]);
}

function spawnArguments(context: ArgumentContext): StaticArgumentSpec {
	const pendingFlag = context.argumentText.endsWith(" ") ? context.args.at(-1) : context.args.at(-2);
	if (pendingFlag === "--harness") {
		return values(["auto", "clanky", "claude", "codex", "opencode", "custom"], [
			"/spawn --harness codex docs-review Review the changed files.",
		]);
	}
	if (pendingFlag === "--performer") {
		return values(["auto", "clanky", "claude", "codex", "opencode"], [
			"/spawn --performer codex docs-review Review the changed files.",
		]);
	}
	return values(["--harness", "--performer", "--cwd", "help"], [
		"/spawn",
		"/spawn docs-review Review the changed files and report findings.",
		"/spawn --harness codex docs-review Review the changed files.",
	]);
}

function discordScopeArguments(context: ArgumentContext): StaticArgumentSpec {
	const action = context.args[0]?.toLowerCase();
	if (action === "dms") return values(["on", "off"], ["/discord-scope dms off"]);
	if (action === "clear") return values(["all", "guilds", "channels", "dms"], ["/discord-scope clear channels"]);
	if (action === "add" || action === "remove") return values(["guilds", "channels"], [`/discord-scope ${action} channels 123456789012345678`]);
	return values(["status", "guilds", "channels", "add", "remove", "clear", "dms"], [
		"/discord-scope status",
		"/discord-scope channels 123456789012345678",
		"/discord-scope dms off",
	]);
}

function integrationArguments(context: ArgumentContext): StaticArgumentSpec {
	if (context.args[0]?.toLowerCase() === "status") return { values: [], examples: ["/integrations status"] };
	if (context.args.length > 1) return values(["unset"], ["/integrations issue-tracker linear"]);
	return values(["status", "issue-tracker", "design", "browser", "code-host"], ["/integrations status", "/integrations issue-tracker linear"]);
}

function values(valuesList: readonly string[], examples: readonly string[]): StaticArgumentSpec {
	return {
		values: valuesList.map((value) => ({ value, label: value })),
		examples,
	};
}

function argumentWarning(
	command: ClankyAutocompleteCommand,
	staticSpec: StaticArgumentSpec,
	argumentText: string,
): string | undefined {
	if (!command.takesArgument && argumentText.trim().length > 0) return "this command does not take arguments";
	if (command.name === "spawn") return undefined;
	const first = splitArgumentTokens(argumentText)[0];
	if (first === undefined || first.length === 0) return undefined;
	const hasStaticFirstArgs = staticArgumentSpec(command.name, { args: [], argumentText: "", prefix: "" }).values.length > 0;
	if (!hasStaticFirstArgs) return undefined;
	const validFirstArgs = new Set(staticArgumentSpec(command.name, { args: [], argumentText: "", prefix: "" }).values.map((item) => item.value));
	if (validFirstArgs.has(first)) return undefined;
	if (staticSpec.values.some((item) => item.value === first)) return undefined;
	const closeFirstArgs = fuzzyFilter([...validFirstArgs], first, (value) => value);
	if (closeFirstArgs.length > 0) return undefined;
	return `unknown first arg "${first}"`;
}

function formatArgumentItem(item: AutocompleteItem): string {
	return item.description === undefined ? item.label : `${item.label} (${item.description})`;
}

function uniqueAutocompleteItems(items: readonly AutocompleteItem[]): AutocompleteItem[] {
	const seen = new Set<string>();
	const result: AutocompleteItem[] = [];
	for (const item of items) {
		if (seen.has(item.value)) continue;
		seen.add(item.value);
		result.push(item);
	}
	return result;
}

function namesToItems(names: readonly string[], description: string): AutocompleteItem[] {
	return names.map((name) => ({ value: name, label: name, description }));
}
