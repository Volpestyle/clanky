import type { Socket } from "node:net";
import type { RegisteredSession, SessionRegistry } from "@clanky/core";
import type { RpcCommand, RpcResponse, RpcSessionState, SourceInfo } from "@earendil-works/pi-coding-agent";

type RpcExtensionUIResponse = {
	type: "extension_ui_response";
	id: string;
	value?: string;
	confirmed?: boolean;
	cancelled?: true;
};

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

export class PiRpcSocket {
	private readonly registry: SessionRegistry;
	private readonly socket: Socket;
	private current: RegisteredSession | undefined;
	private unsubscribe: (() => void) | undefined;
	private queue = Promise.resolve();
	private closed = false;

	constructor(options: PiRpcSocketOptions) {
		this.registry = options.registry;
		this.socket = options.socket;
		const initialSessionId = options.initialSessionId;
		if (initialSessionId !== undefined) {
			this.queue = this.queue.then(async () => {
				this.bind(await this.registry.getOrOpen(initialSessionId));
			});
		}
	}

	handleLine(line: string): void {
		this.queue = this.queue.then(async () => {
			if (this.closed) return;
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
			if (parsed.type === "extension_ui_response") return;
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
				this.bind(await this.registry.createSession(createOptions));
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
				this.bind(await this.sessionForPath(command.sessionPath));
				return success(id, "switch_session", { cancelled: false });
			}
			case "fork": {
				const current = await this.ensureCurrent();
				const result = await this.registry.forkLiveSession({
					sourceSessionId: current.id,
					entryId: command.entryId,
					position: "before",
				});
				if (!result.cancelled) this.bind(result.session);
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
				if (!result.cancelled) this.bind(result.session);
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
				return success(id, "get_messages", { messages: current.session.messages });
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
		this.bind(current);
		return current;
	}

	private bind(next: RegisteredSession): void {
		this.unsubscribe?.();
		this.current = next;
		this.unsubscribe = next.session.subscribe((event) => {
			this.write(event);
		});
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
