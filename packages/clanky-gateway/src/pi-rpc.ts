import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import type { RegisteredSession, SessionRegistry } from "@clanky/core";
import {
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
	type ExtensionWidgetOptions,
	type RpcCommand,
	type RpcResponse,
	type RpcSessionState,
	type SourceInfo,
	Theme,
	type ThemeColor,
	type WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";

type RpcExtensionUIResponse = {
	type: "extension_ui_response";
	id: string;
	value?: string;
	confirmed?: boolean;
	cancelled?: true;
};

type RpcExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type RpcExtensionUIRequestBody = DistributiveOmit<RpcExtensionUIRequest, "id" | "type">;

type RpcInput = RpcCommand | RpcExtensionUIResponse;

interface RpcSlashCommand {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
	sourceInfo: SourceInfo;
}

interface PiRpcSocketOptions {
	registry: SessionRegistry;
	socket: Socket;
	initialSessionId?: string;
}

const RPC_THEME_FG: Record<ThemeColor, number> = {
	accent: 81,
	border: 244,
	borderAccent: 81,
	borderMuted: 240,
	success: 114,
	error: 203,
	warning: 221,
	muted: 245,
	dim: 240,
	text: 252,
	thinkingText: 245,
	userMessageText: 252,
	customMessageText: 252,
	customMessageLabel: 81,
	toolTitle: 81,
	toolOutput: 252,
	mdHeading: 252,
	mdLink: 81,
	mdLinkUrl: 245,
	mdCode: 221,
	mdCodeBlock: 252,
	mdCodeBlockBorder: 244,
	mdQuote: 245,
	mdQuoteBorder: 244,
	mdHr: 244,
	mdListBullet: 81,
	toolDiffAdded: 114,
	toolDiffRemoved: 203,
	toolDiffContext: 245,
	syntaxComment: 245,
	syntaxKeyword: 81,
	syntaxFunction: 114,
	syntaxVariable: 252,
	syntaxString: 221,
	syntaxNumber: 214,
	syntaxType: 141,
	syntaxOperator: 245,
	syntaxPunctuation: 245,
	thinkingOff: 245,
	thinkingMinimal: 81,
	thinkingLow: 114,
	thinkingMedium: 221,
	thinkingHigh: 214,
	thinkingXhigh: 203,
	bashMode: 114,
};

const RPC_THEME = new Theme(
	RPC_THEME_FG,
	{
		selectedBg: 236,
		userMessageBg: 236,
		customMessageBg: 236,
		toolPendingBg: 236,
		toolSuccessBg: 236,
		toolErrorBg: 236,
	},
	"256color",
	{ name: "clanky-rpc" },
);

export class PiRpcSocket {
	private readonly registry: SessionRegistry;
	private readonly socket: Socket;
	private current: RegisteredSession | undefined;
	private unsubscribe: (() => void) | undefined;
	private readonly pendingExtensionRequests = new Map<string, (response: RpcExtensionUIResponse) => void>();
	private queue = Promise.resolve();
	private closed = false;

	constructor(options: PiRpcSocketOptions) {
		this.registry = options.registry;
		this.socket = options.socket;
		const initialSessionId = options.initialSessionId;
		if (initialSessionId !== undefined) {
			this.queue = this.queue.then(async () => {
				await this.bind(await this.registry.getOrOpen(initialSessionId));
			});
		}
	}

	handleLine(line: string): void {
		this.queue = this.queue.then(async () => {
			if (this.closed) return;
			if (line.endsWith("\r")) line = line.slice(0, -1);
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch (error) {
				this.writeError(undefined, "parse", `Failed to parse command: ${errorMessage(error)}`);
				return;
			}
			if (!isRpcInput(parsed)) {
				this.writeError(undefined, "unknown", "Invalid Pi RPC command");
				return;
			}
			if (parsed.type === "extension_ui_response") {
				this.pendingExtensionRequests.get(parsed.id)?.(parsed);
				return;
			}
			await this.handleCommand(parsed);
		});
	}

	close(): void {
		this.closed = true;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	private async handleCommand(command: RpcCommand): Promise<void> {
		try {
			const response = await this.dispatch(command);
			if (response !== undefined) this.write(response);
		} catch (error) {
			this.writeError(command.id, command.type, errorMessage(error));
		}
	}

	private async dispatch(command: RpcCommand): Promise<RpcResponse | undefined> {
		const id = command.id;
		switch (command.type) {
			case "prompt":
				return this.prompt(command);
			case "steer": {
				const current = await this.ensureCurrent();
				await current.session.steer(command.message, command.images);
				return success(id, "steer");
			}
			case "follow_up": {
				const current = await this.ensureCurrent();
				await current.session.followUp(command.message, command.images);
				return success(id, "follow_up");
			}
			case "abort": {
				const current = await this.ensureCurrent();
				await current.session.abort();
				return success(id, "abort");
			}
			case "new_session": {
				const createOptions: Parameters<typeof this.registry.createSession>[0] = {};
				if (command.parentSession !== undefined) createOptions.parentSession = command.parentSession;
				await this.bind(await this.registry.createSession(createOptions));
				return success(id, "new_session", { cancelled: false });
			}
			case "get_state":
				return success(id, "get_state", rpcState(await this.ensureCurrent()));
			case "set_model": {
				const current = await this.ensureCurrent();
				const model = current.session.modelRegistry.find(command.provider, command.modelId);
				if (model === undefined)
					return failure(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				await current.session.setModel(model);
				return success(id, "set_model", model);
			}
			case "cycle_model": {
				const current = await this.ensureCurrent();
				return success(id, "cycle_model", (await current.session.cycleModel()) ?? null);
			}
			case "get_available_models": {
				const current = await this.ensureCurrent();
				return success(id, "get_available_models", { models: current.session.modelRegistry.getAvailable() });
			}
			case "set_thinking_level": {
				const current = await this.ensureCurrent();
				current.session.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			}
			case "cycle_thinking_level": {
				const current = await this.ensureCurrent();
				const level = current.session.cycleThinkingLevel();
				return success(id, "cycle_thinking_level", level === undefined ? null : { level });
			}
			case "set_steering_mode": {
				const current = await this.ensureCurrent();
				current.session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}
			case "set_follow_up_mode": {
				const current = await this.ensureCurrent();
				current.session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}
			case "compact": {
				const current = await this.ensureCurrent();
				return success(id, "compact", await current.session.compact(command.customInstructions));
			}
			case "set_auto_compaction": {
				const current = await this.ensureCurrent();
				current.session.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}
			case "set_auto_retry": {
				const current = await this.ensureCurrent();
				current.session.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}
			case "abort_retry": {
				const current = await this.ensureCurrent();
				current.session.abortRetry();
				return success(id, "abort_retry");
			}
			case "bash": {
				const current = await this.ensureCurrent();
				return success(id, "bash", await current.session.executeBash(command.command));
			}
			case "abort_bash": {
				const current = await this.ensureCurrent();
				current.session.abortBash();
				return success(id, "abort_bash");
			}
			case "get_session_stats": {
				const current = await this.ensureCurrent();
				return success(id, "get_session_stats", current.session.getSessionStats());
			}
			case "export_html": {
				const current = await this.ensureCurrent();
				return success(id, "export_html", { path: await current.session.exportToHtml(command.outputPath) });
			}
			case "switch_session": {
				await this.bind(await this.sessionForPath(command.sessionPath));
				return success(id, "switch_session", { cancelled: false });
			}
			case "fork": {
				const current = await this.ensureCurrent();
				const result = await this.registry.forkLiveSession({
					sourceSessionId: current.id,
					entryId: command.entryId,
					position: "before",
				});
				if (!result.cancelled) await this.bind(result.session);
				return success(id, "fork", {
					text: result.cancelled ? "" : (result.selectedText ?? ""),
					cancelled: result.cancelled,
				});
			}
			case "clone": {
				const current = await this.ensureCurrent();
				const leafId = current.session.sessionManager.getLeafId();
				if (leafId === null) return failure(id, "clone", "Cannot clone session: no current entry selected");
				const result = await this.registry.forkLiveSession({
					sourceSessionId: current.id,
					entryId: leafId,
					position: "at",
				});
				if (!result.cancelled) await this.bind(result.session);
				return success(id, "clone", { cancelled: result.cancelled });
			}
			case "get_fork_messages": {
				const current = await this.ensureCurrent();
				return success(id, "get_fork_messages", { messages: current.session.getUserMessagesForForking() });
			}
			case "get_last_assistant_text": {
				const current = await this.ensureCurrent();
				return success(id, "get_last_assistant_text", { text: current.session.getLastAssistantText() ?? null });
			}
			case "set_session_name": {
				const current = await this.ensureCurrent();
				const name = command.name.trim();
				if (name.length === 0) return failure(id, "set_session_name", "Session name cannot be empty");
				current.session.setSessionName(name);
				return success(id, "set_session_name");
			}
			case "get_messages": {
				const current = await this.ensureCurrent();
				const contextMessages = current.session.sessionManager.buildSessionContext().messages;
				const liveMessages = current.session.messages;
				return success(id, "get_messages", {
					messages: liveMessages.length > contextMessages.length ? liveMessages : contextMessages,
				});
			}
			case "get_commands": {
				const current = await this.ensureCurrent();
				return success(id, "get_commands", { commands: rpcCommands(current) });
			}
		}
	}

	private async prompt(command: Extract<RpcCommand, { type: "prompt" }>): Promise<RpcResponse | undefined> {
		const current = await this.ensureCurrent();
		let preflightSucceeded = false;
		const promptOptions: Parameters<typeof current.session.prompt>[1] = {
			source: "rpc",
			preflightResult: (didSucceed) => {
				if (!didSucceed || preflightSucceeded) return;
				preflightSucceeded = true;
				this.write(success(command.id, "prompt"));
			},
		};
		if (command.images !== undefined) promptOptions.images = command.images;
		if (command.streamingBehavior !== undefined) promptOptions.streamingBehavior = command.streamingBehavior;
		void current.session
			.prompt(command.message, promptOptions)
			.then(async () => {
				await this.registry.refreshSessionFile(current.id);
			})
			.catch((error: unknown) => {
				if (!preflightSucceeded) this.writeError(command.id, "prompt", errorMessage(error));
			});
		return undefined;
	}

	private async ensureCurrent(): Promise<RegisteredSession> {
		if (this.current !== undefined) return this.current;
		const current = await this.registry.createSession();
		await this.bind(current);
		return current;
	}

	private async bind(next: RegisteredSession): Promise<void> {
		this.unsubscribe?.();
		this.current = next;
		await next.session.bindExtensions({
			uiContext: this.createExtensionUIContext(),
			commandContextActions: {
				waitForIdle: async () => {
					const current = await this.ensureCurrent();
					await current.session.agent.waitForIdle();
				},
				newSession: async (options) => {
					const createOptions: Parameters<typeof this.registry.createSession>[0] = {};
					if (options?.parentSession !== undefined) createOptions.parentSession = options.parentSession;
					const created = await this.registry.createSession(createOptions);
					if (options?.setup !== undefined) await options.setup(created.session.sessionManager);
					await this.bind(created);
					return { cancelled: false };
				},
				fork: async (entryId, forkOptions) => {
					const current = await this.ensureCurrent();
					const result = await this.registry.forkLiveSession({
						sourceSessionId: current.id,
						entryId,
						position: forkOptions?.position ?? "before",
					});
					if (!result.cancelled) await this.bind(result.session);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const current = await this.ensureCurrent();
					const treeOptions: Parameters<typeof current.session.navigateTree>[1] = {};
					if (options?.summarize !== undefined) treeOptions.summarize = options.summarize;
					if (options?.customInstructions !== undefined) treeOptions.customInstructions = options.customInstructions;
					if (options?.replaceInstructions !== undefined) treeOptions.replaceInstructions = options.replaceInstructions;
					if (options?.label !== undefined) treeOptions.label = options.label;
					const result = await current.session.navigateTree(targetId, treeOptions);
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath) => {
					await this.bind(await this.sessionForPath(sessionPath));
					return { cancelled: false };
				},
				reload: async () => {
					const current = await this.ensureCurrent();
					await current.session.reload();
				},
			},
			shutdownHandler: () => {
				this.socket.end();
			},
			onError: (error) => {
				this.write({ type: "extension_error", ...error });
			},
		});
		this.unsubscribe = next.session.subscribe((event) => {
			this.write(event);
		});
	}

	private createExtensionUIContext(): ExtensionUIContext {
		return {
			select: async (title, options, opts) => {
				const request: RpcExtensionUIRequest = {
					type: "extension_ui_request",
					id: "",
					method: "select",
					title,
					options,
				};
				if (opts?.timeout !== undefined) request.timeout = opts.timeout;
				return await this.extensionDialog(opts, undefined, request, (response) =>
					response.cancelled === true ? undefined : typeof response.value === "string" ? response.value : undefined,
				);
			},
			confirm: async (title, message, opts) => {
				const request: RpcExtensionUIRequest = {
					type: "extension_ui_request",
					id: "",
					method: "confirm",
					title,
					message,
				};
				if (opts?.timeout !== undefined) request.timeout = opts.timeout;
				return await this.extensionDialog(opts, false, request, (response) =>
					response.cancelled === true ? false : response.confirmed === true,
				);
			},
			input: async (title, placeholder, opts) => {
				const request: RpcExtensionUIRequest = { type: "extension_ui_request", id: "", method: "input", title };
				if (placeholder !== undefined) request.placeholder = placeholder;
				if (opts?.timeout !== undefined) request.timeout = opts.timeout;
				return await this.extensionDialog(opts, undefined, request, (response) =>
					response.cancelled === true ? undefined : typeof response.value === "string" ? response.value : undefined,
				);
			},
			notify: (message, type) => {
				if (type === undefined) {
					this.writeExtensionRequest({ method: "notify", message });
					return;
				}
				this.writeExtensionRequest({ method: "notify", message, notifyType: type });
			},
			onTerminalInput: () => () => undefined,
			setStatus: (key, text) => {
				this.writeExtensionRequest({ method: "setStatus", statusKey: key, statusText: text });
			},
			setWorkingMessage: (_message?: string) => undefined,
			setWorkingVisible: (_visible: boolean) => undefined,
			setWorkingIndicator: (_options?: WorkingIndicatorOptions) => undefined,
			setHiddenThinkingLabel: (_label?: string) => undefined,
			setWidget: (key: string, content: unknown, options?: ExtensionWidgetOptions) => {
				if (content === undefined || Array.isArray(content)) {
					const request: Omit<Extract<RpcExtensionUIRequest, { method: "setWidget" }>, "type" | "id"> = {
						method: "setWidget",
						widgetKey: key,
						widgetLines: content,
					};
					if (options?.placement !== undefined) request.widgetPlacement = options.placement;
					this.writeExtensionRequest(request);
				}
			},
			setFooter: () => undefined,
			setHeader: () => undefined,
			setTitle: (title) => {
				this.writeExtensionRequest({ method: "setTitle", title });
			},
			custom: async <T>() => undefined as T,
			pasteToEditor: (text) => {
				this.writeExtensionRequest({ method: "set_editor_text", text });
			},
			setEditorText: (text) => {
				this.writeExtensionRequest({ method: "set_editor_text", text });
			},
			getEditorText: () => "",
			editor: async (title, prefill) => {
				const request: RpcExtensionUIRequest = { type: "extension_ui_request", id: "", method: "editor", title };
				if (prefill !== undefined) request.prefill = prefill;
				return await this.extensionDialog(undefined, undefined, request, (response) =>
					response.cancelled === true ? undefined : typeof response.value === "string" ? response.value : undefined,
				);
			},
			addAutocompleteProvider: () => undefined,
			setEditorComponent: () => undefined,
			getEditorComponent: () => undefined,
			theme: RPC_THEME,
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false, error: "Theme switching is not supported over Clanky Pi RPC" }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => undefined,
		};
	}

	private async extensionDialog<T>(
		options: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: RpcExtensionUIRequest,
		parse: (response: RpcExtensionUIResponse) => T,
	): Promise<T> {
		if (options?.signal?.aborted) return defaultValue;
		const id = randomUUID();
		return await new Promise<T>((resolve) => {
			let timeout: NodeJS.Timeout | undefined;
			const cleanup = () => {
				if (timeout !== undefined) clearTimeout(timeout);
				options?.signal?.removeEventListener("abort", onAbort);
				this.pendingExtensionRequests.delete(id);
			};
			const finish = (value: T) => {
				cleanup();
				resolve(value);
			};
			const onAbort = () => {
				finish(defaultValue);
			};
			options?.signal?.addEventListener("abort", onAbort, { once: true });
			if (options?.timeout !== undefined) {
				timeout = setTimeout(() => {
					finish(defaultValue);
				}, options.timeout);
			}
			this.pendingExtensionRequests.set(id, (response) => {
				finish(parse(response));
			});
			this.write({ ...request, id });
		});
	}

	private writeExtensionRequest(request: RpcExtensionUIRequestBody): void {
		this.write({ type: "extension_ui_request", id: randomUUID(), ...request });
	}

	private async sessionForPath(sessionPath: string): Promise<RegisteredSession> {
		const sessions = await this.registry.listSummaries();
		const match = sessions.find((session) => session.sessionFile === sessionPath);
		if (match === undefined) throw new Error(`Unknown session path: ${sessionPath}`);
		return await this.registry.getOrOpen(match.id);
	}

	private writeError(id: string | undefined, command: string, message: string): void {
		this.write(failure(id, command, message));
	}

	private write(value: unknown): void {
		if (this.closed || this.socket.destroyed) return;
		this.socket.write(`${JSON.stringify(value)}\n`);
	}
}

export function isRpcInput(value: unknown): value is RpcInput {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const type = (value as Record<string, unknown>).type;
	return typeof type === "string" && (type === "extension_ui_response" || RPC_COMMAND_TYPES.has(type));
}

function rpcState(registered: RegisteredSession): RpcSessionState {
	const session = registered.session;
	const state: RpcSessionState = {
		thinkingLevel: session.thinkingLevel,
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
		sessionId: session.sessionId,
		autoCompactionEnabled: session.autoCompactionEnabled,
		messageCount: session.messages.length,
		pendingMessageCount: session.pendingMessageCount,
	};
	if (session.model !== undefined) state.model = session.model;
	if (session.sessionFile !== undefined) state.sessionFile = session.sessionFile;
	if (session.sessionName !== undefined) state.sessionName = session.sessionName;
	return state;
}

function rpcCommands(registered: RegisteredSession): RpcSlashCommand[] {
	const session = registered.session;
	const commands: RpcSlashCommand[] = [];
	for (const command of session.extensionRunner.getRegisteredCommands()) {
		const item: RpcSlashCommand = {
			name: command.invocationName,
			source: "extension",
			sourceInfo: command.sourceInfo,
		};
		if (command.description !== undefined) item.description = command.description;
		commands.push(item);
	}
	for (const template of session.promptTemplates) {
		const item: RpcSlashCommand = {
			name: template.name,
			source: "prompt",
			sourceInfo: template.sourceInfo,
		};
		if (template.description !== undefined) item.description = template.description;
		commands.push(item);
	}
	for (const skill of session.resourceLoader.getSkills().skills) {
		const item: RpcSlashCommand = {
			name: `skill:${skill.name}`,
			source: "skill",
			sourceInfo: skill.sourceInfo,
		};
		if (skill.description !== undefined) item.description = skill.description;
		commands.push(item);
	}
	return commands;
}

function success(id: string | undefined, command: string, data?: unknown): RpcResponse {
	const response: Record<string, unknown> = { type: "response", command, success: true };
	if (id !== undefined) response.id = id;
	if (data !== undefined) response.data = data;
	return response as RpcResponse;
}

function failure(id: string | undefined, command: string, error: string): RpcResponse {
	const response: RpcResponse = { type: "response", command, success: false, error };
	if (id !== undefined) response.id = id;
	return response;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const RPC_COMMAND_TYPES = new Set<string>([
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"new_session",
	"get_state",
	"set_model",
	"cycle_model",
	"get_available_models",
	"set_thinking_level",
	"cycle_thinking_level",
	"set_steering_mode",
	"set_follow_up_mode",
	"compact",
	"set_auto_compaction",
	"set_auto_retry",
	"abort_retry",
	"bash",
	"abort_bash",
	"get_session_stats",
	"export_html",
	"switch_session",
	"fork",
	"clone",
	"get_fork_messages",
	"get_last_assistant_text",
	"set_session_name",
	"get_messages",
	"get_commands",
]);
