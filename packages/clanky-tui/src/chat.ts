import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import {
	type Component,
	Input,
	type KeyId,
	Markdown,
	type MarkdownTheme,
	matchesKey,
	ProcessTerminal,
	TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	type RpcAgentMessage,
	RpcChatClient,
	type RpcExtensionUIRequest,
	type RpcExtensionUIResponse,
	sessionFileForId,
} from "./rpc-client.ts";

export interface RunChatOptions {
	socketFile: string;
	sessionId?: string;
	eventStreamUrl?: string;
}

export async function runChat(options: RunChatOptions): Promise<void> {
	if (input.isTTY && output.isTTY) {
		await runInteractiveChat(options);
		return;
	}
	await runLineChat(options);
}

const CHAT_SCROLL_UP_KEYS: readonly KeyId[] = ["up", "k"];
const CHAT_SCROLL_DOWN_KEYS: readonly KeyId[] = ["down", "j"];
const CHAT_PAGE_UP_KEYS: readonly KeyId[] = ["pageUp"];
const CHAT_PAGE_DOWN_KEYS: readonly KeyId[] = ["pageDown"];
const CHAT_HOME_KEYS: readonly KeyId[] = ["home"];
const CHAT_END_KEYS: readonly KeyId[] = ["end"];

async function runLineChat(options: RunChatOptions): Promise<void> {
	const rpc = await RpcChatClient.connect(options.socketFile);
	const unsubscribeExtensionUi = rpc.onExtensionUiRequest((request) => {
		handleLineExtensionUiRequest(rpc, request);
	});
	if (options.sessionId !== undefined) {
		await rpc.switchSession(await sessionFileForId(options.socketFile, options.sessionId));
	}
	let sessionId = (await rpc.getState()).sessionId;
	const reader = createInterface({ input, output });
	output.write(`Clanky Chat (${sessionId})\n`);
	output.write("Type /exit to leave.\n\n");
	const initialMessages = agentMessagesToChatMessages(await rpc.getMessages());
	if (initialMessages.length > 0) {
		for (const message of initialMessages) {
			output.write(`${lineMessageLabel(message)} ${message.text}\n`);
		}
		output.write("\n");
	}
	try {
		while (true) {
			const promptInput = await readPrompt(reader);
			if (promptInput === undefined) return;
			const prompt = promptInput.trim();
			if (prompt.length === 0) continue;
			if (prompt === "/exit" || prompt === "/quit" || prompt === ":q") return;
			let printedDelta = false;
			try {
				const text = await rpc.prompt(prompt, (delta) => {
					printedDelta = true;
					output.write(delta);
				});
				sessionId = (await rpc.getState()).sessionId;
				if (printedDelta) {
					output.write("\n\n");
				} else if (text.length > 0) {
					output.write(`${text}\n\n`);
				} else {
					output.write(`session: ${sessionId}\n\n`);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				output.write(`error: ${message}\n\n`);
			}
		}
	} finally {
		unsubscribeExtensionUi();
		rpc.close();
		reader.close();
	}
}

async function runInteractiveChat(options: RunChatOptions): Promise<void> {
	const rpc = await RpcChatClient.connect(options.socketFile);
	if (options.sessionId !== undefined) {
		await rpc.switchSession(await sessionFileForId(options.socketFile, options.sessionId));
	}
	const initialState = await rpc.getState();
	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal, true);
	tui.setClearOnShrink(true);
	const app = new ChatComponent(initialState.sessionId, () => tui.requestRender());
	app.setMessages(agentMessagesToChatMessages(await rpc.getMessages()));
	tui.addChild(app);
	tui.setFocus(app);
	const unsubscribeExtensionUi = rpc.onExtensionUiRequest((request) => {
		app.handleExtensionUiRequest(request);
		tui.requestRender();
	});

	let stopped = false;
	let promptRunning = false;

	const stop = () => {
		if (stopped) return;
		stopped = true;
		tui.stop();
	};

	app.onExit = stop;
	app.onExtensionResponse = (response) => {
		rpc.sendExtensionUiResponse(response);
	};
	app.onSubmit = (value) => {
		const extensionResponse = app.takeExtensionResponse(value);
		if (extensionResponse !== undefined) {
			rpc.sendExtensionUiResponse(extensionResponse);
			tui.requestRender();
			return;
		}
		if (promptRunning) return;
		const prompt = value.trim();
		app.clearInput();
		if (prompt.length === 0) {
			tui.requestRender();
			return;
		}
		if (prompt === "/exit" || prompt === "/quit" || prompt === ":q") {
			stop();
			return;
		}
		if (prompt === "/clear") {
			app.clearMessages();
			tui.requestRender();
			return;
		}
		if (prompt === "/new") {
			promptRunning = true;
			app.setStatus("starting new session");
			tui.requestRender();
			void (async () => {
				try {
					await rpc.newSession();
					const state = await rpc.getState();
					app.resetSession(state.sessionId);
					app.setStatus("idle");
				} catch (error) {
					app.addMessage({ role: "error", text: error instanceof Error ? error.message : String(error) });
					app.setStatus("error");
				} finally {
					promptRunning = false;
					tui.requestRender();
				}
			})();
			return;
		}
		promptRunning = true;
		app.addMessage({ role: "user", text: prompt });
		app.startAssistantMessage();
		app.setStatus("waiting");
		tui.requestRender();
		void (async () => {
			try {
				let text = "";
				const response = await rpc.prompt(prompt, (delta) => {
					text += delta;
					app.updateAssistantMessage(text);
					app.setStatus("streaming");
					tui.requestRender();
				});
				if (text.length === 0) text = response;
				app.updateAssistantMessage(text);
				const state = await rpc.getState();
				app.setSessionId(state.sessionId);
				app.setStatus("idle");
			} catch (error) {
				app.finishAssistantMessage();
				app.addMessage({ role: "error", text: error instanceof Error ? error.message : String(error) });
				app.setStatus("error");
			} finally {
				promptRunning = false;
				tui.requestRender();
			}
		})();
	};

	await new Promise<void>((resolve) => {
		const cleanup = () => {
			process.off("SIGINT", stop);
			process.off("SIGTERM", stop);
			resolve();
		};
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
		tui.start();
		tui.requestRender(true);
		const poll = setInterval(() => {
			if (stopped) {
				clearInterval(poll);
				cleanup();
			}
		}, 25);
		poll.unref?.();
	});
	unsubscribeExtensionUi();
	rpc.close();
}

interface ChatMessage {
	role: "assistant" | "error" | "status" | "user";
	text: string;
}

type RpcExtensionUIDialogRequest = Extract<
	RpcExtensionUIRequest,
	{ method: "confirm" | "editor" | "input" | "select" }
>;

class ChatComponent implements Component {
	readonly input = new Input();
	focused = false;
	onExit: (() => void) | undefined;
	onExtensionResponse: ((response: RpcExtensionUIResponse) => void) | undefined;
	onSubmit: ((value: string) => void) | undefined;

	private readonly messages: ChatMessage[] = [];
	private pendingExtensionRequest: RpcExtensionUIDialogRequest | undefined;
	private sessionId: string;
	private status = "idle";
	private scrollOffset = 0;
	private followTail = true;
	private readonly requestRender: () => void;

	constructor(sessionId: string, requestRender: () => void) {
		this.sessionId = sessionId;
		this.requestRender = requestRender;
		this.input.onEscape = () => {
			if (this.pendingExtensionRequest !== undefined) {
				this.cancelExtensionRequest();
				return;
			}
			this.onExit?.();
		};
		this.input.onSubmit = (value) => {
			this.onSubmit?.(value);
		};
	}

	setSessionId(sessionId: string): void {
		this.sessionId = sessionId;
	}

	setStatus(status: string): void {
		this.status = status;
	}

	addMessage(message: ChatMessage): void {
		this.messages.push(message);
		this.followTail = true;
	}

	setMessages(messages: ChatMessage[]): void {
		this.messages.length = 0;
		this.messages.push(...messages);
		this.scrollOffset = 0;
		this.followTail = true;
	}

	startAssistantMessage(): void {
		this.messages.push({ role: "assistant", text: "" });
		this.followTail = true;
	}

	updateAssistantMessage(text: string): void {
		const last = this.messages[this.messages.length - 1];
		if (last?.role === "assistant") {
			last.text = text;
			this.followTail = true;
			return;
		}
		this.messages.push({ role: "assistant", text });
		this.followTail = true;
	}

	finishAssistantMessage(): void {
		const last = this.messages[this.messages.length - 1];
		if (last?.role === "assistant" && last.text.length === 0) {
			this.messages.pop();
		}
	}

	clearInput(): void {
		this.input.setValue("");
	}

	clearMessages(): void {
		this.messages.length = 0;
		this.scrollOffset = 0;
		this.followTail = true;
	}

	resetSession(sessionId: string): void {
		this.sessionId = sessionId;
		this.clearMessages();
		this.pendingExtensionRequest = undefined;
	}

	handleExtensionUiRequest(request: RpcExtensionUIRequest): void {
		switch (request.method) {
			case "select":
			case "confirm":
			case "input":
			case "editor":
				this.pendingExtensionRequest = request;
				this.addMessage({ role: "status", text: extensionPromptText(request) });
				this.status = "input requested";
				return;
			case "notify":
				this.addMessage({
					role: request.notifyType === "error" ? "error" : "status",
					text: request.message,
				});
				return;
			case "setStatus":
				if (request.statusText !== undefined) this.status = `${request.statusKey}: ${request.statusText}`;
				if (request.statusText === undefined) this.status = "idle";
				return;
			case "setWidget":
				if (request.widgetLines !== undefined && request.widgetLines.length > 0) {
					this.addMessage({ role: "status", text: `${request.widgetKey}\n${request.widgetLines.join("\n")}` });
				}
				return;
			case "setTitle":
				return;
			case "set_editor_text":
				this.input.setValue(request.text);
				return;
		}
	}

	takeExtensionResponse(value: string): RpcExtensionUIResponse | undefined {
		const request = this.pendingExtensionRequest;
		if (request === undefined) return undefined;
		const trimmed = value.trim();
		this.clearInput();
		this.pendingExtensionRequest = undefined;
		this.status = "waiting";
		if (trimmed.length === 0) {
			this.addMessage({ role: "status", text: `${request.method} cancelled` });
			return { type: "extension_ui_response", id: request.id, cancelled: true };
		}
		if (request.method === "confirm") {
			const confirmed = ["y", "yes", "true", "1"].includes(trimmed.toLowerCase());
			this.addMessage({ role: "status", text: `${request.title}: ${confirmed ? "confirmed" : "declined"}` });
			return { type: "extension_ui_response", id: request.id, confirmed };
		}
		if (request.method === "select") {
			const selected = selectExtensionOption(request.options, trimmed);
			if (selected === undefined) {
				this.addMessage({ role: "status", text: `${request.title}: cancelled` });
				return { type: "extension_ui_response", id: request.id, cancelled: true };
			}
			this.addMessage({ role: "status", text: `${request.title}: ${selected}` });
			return { type: "extension_ui_response", id: request.id, value: selected };
		}
		this.addMessage({ role: "status", text: `${request.title}: submitted` });
		return { type: "extension_ui_response", id: request.id, value };
	}

	private cancelExtensionRequest(): void {
		const request = this.pendingExtensionRequest;
		if (request === undefined) return;
		this.pendingExtensionRequest = undefined;
		this.clearInput();
		this.status = "idle";
		this.addMessage({ role: "status", text: `${request.method} cancelled` });
		this.onExtensionResponse?.({ type: "extension_ui_response", id: request.id, cancelled: true });
		this.requestRender();
	}

	render(width: number): string[] {
		this.input.focused = this.focused;
		const safeWidth = Math.max(40, width);
		const height = Math.max(10, output.rows ?? 24);
		const inputPanel = this.renderInputPanel(safeWidth);
		const transcriptHeight = Math.max(1, height - inputPanel.length - 3);
		const transcript = this.renderTranscript(safeWidth);
		const maxScrollOffset = Math.max(0, transcript.length - transcriptHeight);
		if (this.followTail) this.scrollOffset = maxScrollOffset;
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScrollOffset));
		const transcriptRows = transcript.slice(this.scrollOffset, this.scrollOffset + transcriptHeight);
		while (transcriptRows.length < transcriptHeight) transcriptRows.push("");
		return [
			paintLine(this.headerLine(), safeWidth, ANSI_SURFACE_HEADER),
			paintLine(this.actionLine(transcriptHeight, transcript.length), safeWidth, ANSI_SURFACE_PANEL),
			paintLine("", safeWidth, ANSI_SURFACE_PANEL),
			...transcriptRows.map((line) => paintLine(line, safeWidth, ANSI_SURFACE_PANEL)),
			...inputPanel,
		];
	}

	handleInput(data: string): void {
		if (matchesChatKey(data, CHAT_SCROLL_UP_KEYS)) {
			this.scrollBy(-1);
			return;
		}
		if (matchesChatKey(data, CHAT_SCROLL_DOWN_KEYS)) {
			this.scrollBy(1);
			return;
		}
		if (matchesChatKey(data, CHAT_PAGE_UP_KEYS)) {
			this.scrollBy(-Math.max(4, Math.floor((output.rows ?? 24) * 0.7)));
			return;
		}
		if (matchesChatKey(data, CHAT_PAGE_DOWN_KEYS)) {
			this.scrollBy(Math.max(4, Math.floor((output.rows ?? 24) * 0.7)));
			return;
		}
		if (matchesChatKey(data, CHAT_HOME_KEYS)) {
			this.scrollTo(0, false);
			return;
		}
		if (matchesChatKey(data, CHAT_END_KEYS)) {
			this.scrollTo(Number.MAX_SAFE_INTEGER, true);
			return;
		}
		this.input.handleInput(data);
		this.requestRender();
	}

	invalidate(): void {
		this.input.invalidate();
	}

	private renderTranscript(width: number): string[] {
		if (this.messages.length === 0) {
			return [
				"",
				muted("  Start typing below. Enter sends. /new starts a fresh session. /clear clears this view."),
				muted("  Use PageUp/PageDown, j/k, or arrow keys to move through chat history."),
				"",
			];
		}
		const lines: string[] = [];
		for (const message of this.messages) {
			lines.push(...this.renderMessage(message, width), "");
		}
		return lines;
	}

	private renderInputPanel(width: number): string[] {
		const innerWidth = Math.max(1, width - 4);
		const [inputLine = ""] = this.input.render(innerWidth);
		const label =
			this.pendingExtensionRequest === undefined ? "Message" : extensionInputLabel(this.pendingExtensionRequest);
		return [
			paintLine(
				`${border("+")} ${bold(fg(COLOR_TEXT, label))} ${border("-".repeat(Math.max(0, width - visibleWidth(label) - 4)))}${border("+")}`,
				width,
				ANSI_SURFACE_PANEL,
			),
			paintLine(`${border("|")} ${fitAnsi(inputLine, innerWidth)} ${border("|")}`, width, ANSI_SURFACE_PANEL),
			paintLine(`${border("+")}${border("-".repeat(Math.max(0, width - 2)))}${border("+")}`, width, ANSI_SURFACE_PANEL),
		];
	}

	private renderMessage(message: ChatMessage, width: number): string[] {
		const innerWidth = Math.max(1, width - 4);
		if (message.role === "assistant") {
			const text = message.text.length === 0 ? "..." : message.text;
			return [
				`${muted("clanky")} ${border("-".repeat(Math.max(0, innerWidth - 7)))}`,
				...new Markdown(text, 2, 0, chatMarkdownTheme).render(innerWidth),
			];
		}
		if (message.role === "user") {
			return [
				`${fg(COLOR_ACCENT, "you")} ${border("-".repeat(Math.max(0, innerWidth - 4)))}`,
				...wrapPlain(message.text, innerWidth).map((line) => `  ${line}`),
			];
		}
		if (message.role === "status") {
			return [
				`${muted("status")} ${border("-".repeat(Math.max(0, innerWidth - 8)))}`,
				...wrapPlain(message.text, innerWidth).map((line) => `  ${muted(line)}`),
			];
		}
		return [
			`${fg(COLOR_ERROR, "error")} ${border("-".repeat(Math.max(0, innerWidth - 7)))}`,
			...wrapPlain(message.text, innerWidth).map((line) => `  ${fg(COLOR_ERROR, line)}`),
		];
	}

	private headerLine(): string {
		return `${bold(fg(COLOR_ACCENT, "Clanky Chat"))}  ${muted("session")} ${fg(COLOR_TEXT, this.sessionId.slice(0, 8))}  ${muted("status")} ${statusText(this.status)}`;
	}

	private actionLine(viewportHeight: number, transcriptLines: number): string {
		const scroll =
			transcriptLines > viewportHeight
				? `   ${muted(scrollStatus(this.scrollOffset, viewportHeight, transcriptLines))}`
				: "";
		if (this.pendingExtensionRequest !== undefined) {
			return `${muted("Actions")}  ${key("[Enter]")} respond   ${key("[blank]")} cancel   ${key("[Esc]")} cancel${scroll}`;
		}
		return `${muted("Actions")}  ${key("[Enter]")} send   ${key("[/new]")} new   ${key("[/clear]")} clear   ${key("[PgUp/PgDn]")} scroll   ${key("[Esc]")} exit${scroll}`;
	}

	private scrollBy(delta: number): void {
		this.scrollTo(this.scrollOffset + delta, false);
	}

	private scrollTo(offset: number, followTail: boolean): void {
		this.followTail = followTail;
		const nextOffset = Math.max(0, offset);
		if (nextOffset === this.scrollOffset && !followTail) return;
		this.scrollOffset = nextOffset;
		this.requestRender();
	}
}

function handleLineExtensionUiRequest(rpc: RpcChatClient, request: RpcExtensionUIRequest): void {
	if (request.method === "notify") {
		output.write(`${request.notifyType ?? "info"}: ${request.message}\n\n`);
		return;
	}
	if (request.method === "setStatus") {
		if (request.statusText !== undefined) output.write(`status: ${request.statusKey}: ${request.statusText}\n`);
		return;
	}
	if (request.method === "setWidget") {
		if (request.widgetLines !== undefined) output.write(`${request.widgetKey}: ${request.widgetLines.join("\n")}\n`);
		return;
	}
	if (request.method === "set_editor_text") {
		output.write(`editor: ${request.text}\n`);
		return;
	}
	if (request.method === "setTitle") return;
	rpc.sendExtensionUiResponse({ type: "extension_ui_response", id: request.id, cancelled: true });
}

function agentMessagesToChatMessages(messages: RpcAgentMessage[]): ChatMessage[] {
	const result: ChatMessage[] = [];
	for (const message of messages) {
		const converted = chatMessageFromAgent(message);
		if (converted !== undefined) result.push(converted);
	}
	return result;
}

function chatMessageFromAgent(message: RpcAgentMessage): ChatMessage | undefined {
	if (!isRecord(message) || typeof message.role !== "string") return undefined;
	if (message.role === "user") return { role: "user", text: contentText(message.content) };
	if (message.role === "assistant") return { role: "assistant", text: contentText(message.content) };
	if (message.role === "toolResult")
		return { role: "status", text: `${String(message.toolName ?? "tool")}: ${contentText(message.content)}` };
	if (message.role === "bashExecution")
		return { role: "status", text: `bash: ${String(message.command ?? "")}\n${String(message.output ?? "")}` };
	if (message.role === "custom" && message.display !== false)
		return { role: "status", text: contentText(message.content) };
	if (message.role === "branchSummary")
		return { role: "status", text: `branch summary\n${String(message.summary ?? "")}` };
	if (message.role === "compactionSummary")
		return { role: "status", text: `compaction summary\n${String(message.summary ?? "")}` };
	return undefined;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (!isRecord(part) || typeof part.type !== "string") continue;
		if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
		if (part.type === "image") parts.push("[image]");
		if (part.type === "toolCall") parts.push(`[tool:${typeof part.name === "string" ? part.name : "unknown"}]`);
	}
	return parts.join("\n").trim();
}

function lineMessageLabel(message: ChatMessage): string {
	if (message.role === "assistant") return "assistant:";
	if (message.role === "user") return "you:";
	return `${message.role}:`;
}

function extensionPromptText(request: RpcExtensionUIDialogRequest): string {
	if (request.method === "select") {
		const options = request.options.map((option, index) => `${index + 1}. ${option}`).join("\n");
		return `${request.title}\n${options}\nEnter a number or exact value. Blank cancels.`;
	}
	if (request.method === "confirm") return `${request.title}\n${request.message}\nEnter yes or no. Blank cancels.`;
	if (request.method === "editor") return `${request.title}\nSubmit edited text. Blank cancels.`;
	return `${request.title}${request.placeholder === undefined ? "" : `\n${request.placeholder}`}\nBlank cancels.`;
}

function extensionInputLabel(request: RpcExtensionUIDialogRequest): string {
	if (request.method === "select") return "Select";
	if (request.method === "confirm") return "Confirm";
	if (request.method === "editor") return "Editor";
	return "Input";
}

function selectExtensionOption(options: string[], value: string): string | undefined {
	const numeric = Number.parseInt(value, 10);
	if (Number.isInteger(numeric) && String(numeric) === value && numeric >= 1 && numeric <= options.length) {
		return options[numeric - 1];
	}
	return options.find((option) => option === value);
}

const ANSI_RESET = "\x1b[0m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_BOLD_RESET = "\x1b[22m";
const ANSI_FG_RESET = "\x1b[39m";
const ANSI_SURFACE_HEADER = "";
const ANSI_SURFACE_PANEL = "";

const COLOR_ACCENT = 81;
const COLOR_BORDER = 244;
const COLOR_ERROR = 203;
const COLOR_MUTED = 245;
const COLOR_SUCCESS = 114;
const COLOR_TEXT = 252;
const COLOR_WARNING = 221;

const chatMarkdownTheme: MarkdownTheme = {
	heading: (text) => text,
	link: (text) => fg(COLOR_ACCENT, text),
	linkUrl: (text) => muted(text),
	code: (text) => fg(COLOR_WARNING, text),
	codeBlock: (text) => text,
	codeBlockBorder: (text) => border(text),
	quote: (text) => muted(text),
	quoteBorder: (text) => border(text),
	hr: (text) => border(text),
	listBullet: (text) => fg(COLOR_ACCENT, text),
	bold: (text) => bold(text),
	italic: (text) => muted(text),
	strikethrough: (text) => text,
	underline: (text) => text,
};

function matchesChatKey(data: string, keys: readonly KeyId[]): boolean {
	return keys.some((key) => matchesKey(data, key));
}

function scrollStatus(scrollOffset: number, viewportHeight: number, totalLines: number): string {
	const start = Math.min(totalLines, scrollOffset + 1);
	const end = Math.min(totalLines, scrollOffset + viewportHeight);
	return `${start}-${end}/${totalLines}`;
}

function statusText(status: string): string {
	if (status === "idle") return fg(COLOR_SUCCESS, status);
	if (status === "error") return fg(COLOR_ERROR, status);
	if (status === "waiting" || status === "streaming") return fg(COLOR_WARNING, status);
	return fg(COLOR_TEXT, status);
}

function key(text: string): string {
	return bold(fg(COLOR_ACCENT, text));
}

function border(text: string): string {
	return fg(COLOR_BORDER, text);
}

function muted(text: string): string {
	return fg(COLOR_MUTED, text);
}

function bold(text: string): string {
	return `${ANSI_BOLD}${text}${ANSI_BOLD_RESET}`;
}

function fg(color: number, text: string): string {
	return `\x1b[38;5;${color}m${text}${ANSI_FG_RESET}`;
}

function paintLine(text: string, width: number, background: string): string {
	return `${background}${fitAnsi(text, width)}${ANSI_RESET}`;
}

function fitAnsi(text: string, width: number): string {
	const truncated = truncateToWidth(text, width, "");
	return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function wrapPlain(text: string, width: number): string[] {
	const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
	if (words.length === 0) return [""];
	const lines: string[] = [];
	let line = "";
	for (const word of words) {
		const candidate = line.length === 0 ? word : `${line} ${word}`;
		if (visibleWidth(candidate) <= width) {
			line = candidate;
			continue;
		}
		if (line.length > 0) lines.push(line);
		line = truncateToWidth(word, width, "");
	}
	if (line.length > 0) lines.push(line);
	return lines;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readPrompt(reader: ReturnType<typeof createInterface>): Promise<string | undefined> {
	try {
		return await reader.question("clanky> ");
	} catch {
		return undefined;
	}
}
