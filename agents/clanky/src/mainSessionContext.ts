import { clampInteger, type MainSessionContextToolInput } from "@clanky/core";
import type { AgentSessionRuntime, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

const DEFAULT_ENTRY_LIMIT = 16;
const MAX_ENTRY_LIMIT = 50;
const DEFAULT_MAX_CHARS = 8000;
const MAX_MAX_CHARS = 40000;
const DEFAULT_ENTRY_TEXT_LIMIT = 1600;

interface MainSessionContextEntry {
	id: string;
	parentId: string | null;
	type: string;
	timestamp: string;
	role?: string;
	text?: string;
	toolName?: string;
	toolCalls?: string[];
	isError?: boolean;
	omitted?: string;
}

export function readMainSessionContext(
	runtime: AgentSessionRuntime | undefined,
	input: MainSessionContextToolInput,
): unknown {
	if (runtime === undefined) {
		return {
			available: false,
			reason: "main Clanky runtime is not bound",
		};
	}
	const session = runtime.session;
	const sessionManager = session.sessionManager;
	const limit = clampInteger(input.limit, DEFAULT_ENTRY_LIMIT, 1, MAX_ENTRY_LIMIT);
	const maxChars = clampInteger(input.maxChars ?? input.max_chars, DEFAULT_MAX_CHARS, 1000, MAX_MAX_CHARS);
	const includeToolResults = input.includeToolResults ?? input.include_tool_results ?? false;
	const includeHidden = input.includeHidden ?? input.include_hidden ?? false;
	const branch = sessionManager.getBranch();
	const selected = branch.slice(Math.max(0, branch.length - limit));
	const entries: MainSessionContextEntry[] = [];
	let remainingChars = maxChars;
	let truncated = selected.length < branch.length;

	for (const entry of selected) {
		const formatted = formatEntry(entry, {
			includeToolResults,
			includeHidden,
			remainingChars,
		});
		if (formatted === undefined) continue;
		if ((formatted.text?.length ?? 0) > remainingChars) truncated = true;
		remainingChars -= formatted.text?.length ?? 0;
		entries.push(formatted);
		if (remainingChars <= 0) {
			truncated = true;
			break;
		}
	}

	return {
		available: true,
		sessionId: session.sessionId,
		sessionFile: session.sessionFile,
		cwd: runtime.cwd,
		busy: session.isStreaming,
		leafId: sessionManager.getLeafId(),
		branchEntries: branch.length,
		returnedEntries: entries.length,
		truncated,
		includeToolResults,
		includeHidden,
		entries,
	};
}

function formatEntry(
	entry: SessionEntry,
	options: { includeToolResults: boolean; includeHidden: boolean; remainingChars: number },
): MainSessionContextEntry | undefined {
	const base: MainSessionContextEntry = {
		id: entry.id,
		parentId: entry.parentId,
		type: entry.type,
		timestamp: entry.timestamp,
	};
	if (entry.type === "message") return formatMessageEntry(base, entry.message, options);
	if (entry.type === "compaction") return { ...base, text: truncateToBudget(entry.summary, options.remainingChars) };
	if (entry.type === "branch_summary")
		return { ...base, text: truncateToBudget(entry.summary, options.remainingChars) };
	if (entry.type === "custom_message") {
		if (!entry.display && !options.includeHidden) return undefined;
		return {
			...base,
			role: "custom",
			text: truncateToBudget(contentText(entry.content), options.remainingChars),
			...(entry.display ? {} : { omitted: "hidden custom message; shown because include_hidden was true" }),
		};
	}
	if (entry.type === "thinking_level_change") return { ...base, text: `thinking level: ${entry.thinkingLevel}` };
	if (entry.type === "model_change") return { ...base, text: `model: ${entry.provider}/${entry.modelId}` };
	if (entry.type === "session_info") return { ...base, text: `session name: ${entry.name ?? "(unnamed)"}` };
	if (entry.type === "custom" || entry.type === "label") {
		if (!options.includeHidden) return undefined;
		return { ...base, omitted: "metadata entry" };
	}
	return base;
}

function formatMessageEntry(
	base: MainSessionContextEntry,
	message: SessionMessageEntry["message"],
	options: { includeToolResults: boolean; remainingChars: number },
): MainSessionContextEntry | undefined {
	if (typeof message !== "object" || message === null || !("role" in message)) return base;
	const record = message as unknown as Record<string, unknown>;
	const role = typeof record.role === "string" ? record.role : "unknown";
	if (role === "toolResult" && !options.includeToolResults) {
		const toolName = readString(record.toolName);
		return {
			...base,
			role,
			...(toolName === undefined ? {} : { toolName }),
			isError: record.isError === true,
			omitted: "tool result text omitted; call with include_tool_results=true to include it",
		};
	}
	if (role === "bashExecution") {
		const command = readString(record.command) ?? "(unknown command)";
		const output = options.includeToolResults ? readString(record.output) : undefined;
		return {
			...base,
			role,
			text: truncateToBudget(
				output === undefined ? `command: ${command}` : `command: ${command}\noutput:\n${output}`,
				options.remainingChars,
			),
			...(record.truncated === true ? { omitted: "bash output was already truncated by Pi" } : {}),
		};
	}
	const content = record.content;
	const toolCalls = extractToolCalls(content);
	return {
		...base,
		role,
		text: truncateToBudget(contentText(content), options.remainingChars),
		...(toolCalls === undefined ? {} : { toolCalls }),
	};
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			if (typeof part !== "object" || part === null) return [];
			const record = part as Record<string, unknown>;
			if (record.type === "text" && typeof record.text === "string") return [record.text];
			return [];
		})
		.join("\n");
}

function extractToolCalls(content: unknown): string[] | undefined {
	if (!Array.isArray(content)) return undefined;
	const names = content.flatMap((part) => {
		if (typeof part !== "object" || part === null) return [];
		const record = part as Record<string, unknown>;
		if (record.type !== "toolCall") return [];
		const name = readString(record.name) ?? readString(record.toolName);
		return name === undefined ? [] : [name];
	});
	return names.length === 0 ? undefined : names;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function truncateToBudget(text: string, remainingChars: number): string {
	const maxLength = Math.max(0, Math.min(DEFAULT_ENTRY_TEXT_LIMIT, remainingChars));
	const normalized = text.replace(/\s+$/g, "");
	if (normalized.length <= maxLength) return normalized;
	if (maxLength <= 3) return normalized.slice(0, maxLength);
	return `${normalized.slice(0, maxLength - 3)}...`;
}
