import { createConnection, type Socket } from "node:net";
import { requestGateway, type SessionListResult } from "@clanky/gateway";
import type { RpcCommand, RpcResponse, RpcSessionState } from "@earendil-works/pi-coding-agent";

export type RpcAgentMessage = Extract<
	RpcResponse,
	{ command: "get_messages"; success: true }
>["data"]["messages"][number];

export type RpcExtensionUIRequest =
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

export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

export class RpcChatClient {
	private readonly socket: Socket;
	private readonly pending = new Map<string, (response: RpcResponse) => void>();
	private activePrompt: ActivePrompt | undefined;
	private extensionUiListener: ((request: RpcExtensionUIRequest) => void) | undefined;
	private nextId = 0;
	private buffer = "";

	private constructor(socket: Socket) {
		this.socket = socket;
		this.socket.on("data", (chunk) => {
			this.handleData(chunk.toString("utf8"));
		});
		this.socket.on("error", (error) => {
			this.failActive(error);
		});
		this.socket.on("close", () => {
			this.failActive(new Error("Pi RPC socket closed"));
		});
	}

	static async connect(socketFile: string): Promise<RpcChatClient> {
		const socket = createConnection(socketFile);
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		return new RpcChatClient(socket);
	}

	async getState(): Promise<RpcState> {
		const response = await this.request({ type: "get_state" });
		if (!response.success) throw new Error(response.error ?? "get_state failed");
		const data = responseData(response);
		if (!isRecord(data) || typeof data.sessionId !== "string") throw new Error("get_state returned no session id");
		return { sessionId: data.sessionId };
	}

	async switchSession(sessionPath: string): Promise<void> {
		const response = await this.request({ type: "switch_session", sessionPath });
		if (!response.success) throw new Error(response.error ?? "switch_session failed");
	}

	async newSession(): Promise<void> {
		const response = await this.request({ type: "new_session" });
		if (!response.success) throw new Error(response.error ?? "new_session failed");
	}

	async getMessages(): Promise<RpcAgentMessage[]> {
		const response = await this.request({ type: "get_messages" });
		if (!response.success) throw new Error(response.error ?? "get_messages failed");
		const data = responseData(response);
		if (!isRecord(data) || !Array.isArray(data.messages)) throw new Error("get_messages returned no messages");
		return data.messages as RpcAgentMessage[];
	}

	async prompt(prompt: string, onDelta: (delta: string) => void): Promise<string> {
		if (this.activePrompt !== undefined) throw new Error("A prompt is already running");
		const chunks: string[] = [];
		const done = new Promise<string>((resolve, reject) => {
			this.activePrompt = {
				onDelta: (delta) => {
					chunks.push(delta);
					onDelta(delta);
				},
				resolve: () => resolve(chunks.join("")),
				reject,
			};
		});
		const response = await this.request({ type: "prompt", message: prompt }, 30_000);
		if (!response.success) {
			this.activePrompt = undefined;
			throw new Error(response.error ?? "prompt failed");
		}
		const text = await done;
		if (text.length > 0) return text;
		return await this.getLastAssistantText();
	}

	close(): void {
		this.socket.destroy();
	}

	onExtensionUiRequest(listener: (request: RpcExtensionUIRequest) => void): () => void {
		this.extensionUiListener = listener;
		return () => {
			if (this.extensionUiListener === listener) this.extensionUiListener = undefined;
		};
	}

	sendExtensionUiResponse(response: RpcExtensionUIResponse): void {
		this.socket.write(`${JSON.stringify(response)}\n`);
	}

	private async getLastAssistantText(): Promise<string> {
		const response = await this.request({ type: "get_last_assistant_text" });
		if (!response.success) return "";
		const data = responseData(response);
		if (!isRecord(data) || typeof data.text !== "string") return "";
		return data.text;
	}

	private request(command: RpcCommandBody, timeoutMs = 10 * 60 * 1000): Promise<RpcResponse> {
		const id = `chat-${this.nextId}`;
		this.nextId += 1;
		return new Promise<RpcResponse>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Timed out waiting for Pi RPC response to ${command.type}`));
			}, timeoutMs);
			this.pending.set(id, (response) => {
				clearTimeout(timeout);
				this.pending.delete(id);
				resolve(response);
			});
			const fullCommand = { ...command, id } as RpcCommand;
			this.socket.write(`${JSON.stringify(fullCommand)}\n`);
		});
	}

	private handleData(chunk: string): void {
		this.buffer += chunk;
		let newlineIndex = this.buffer.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = this.buffer.slice(0, newlineIndex);
			this.buffer = this.buffer.slice(newlineIndex + 1);
			this.handleLine(line);
			newlineIndex = this.buffer.indexOf("\n");
		}
	}

	private handleLine(line: string): void {
		if (line.endsWith("\r")) line = line.slice(0, -1);
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return;
		}
		if (!isRecord(parsed)) return;
		if (parsed.type === "response" && typeof parsed.id === "string") {
			this.pending.get(parsed.id)?.(parsed as RpcResponse);
			return;
		}
		if (isExtensionUiRequest(parsed)) {
			this.extensionUiListener?.(parsed);
			return;
		}
		const delta = textDeltaFromEvent(parsed);
		if (delta !== undefined) {
			this.activePrompt?.onDelta(delta);
			return;
		}
		if (parsed.type === "agent_end") {
			const activePrompt = this.activePrompt;
			this.activePrompt = undefined;
			activePrompt?.resolve();
		}
	}

	private failActive(error: Error): void {
		const activePrompt = this.activePrompt;
		this.activePrompt = undefined;
		activePrompt?.reject(error);
	}
}

export async function sessionFileForId(socketFile: string, sessionId: string): Promise<string> {
	const result = (await requestGateway({ socketFile, method: "session.list" })) as SessionListResult;
	const matches = result.sessions.filter((session) => session.id.startsWith(sessionId));
	if (matches.length > 1) throw new Error(`Ambiguous session id: ${sessionId}`);
	const match = matches[0];
	if (match === undefined) throw new Error(`Unknown session: ${sessionId}`);
	if (match.sessionFile === undefined) throw new Error(`Session ${match.id} is not persisted yet`);
	return match.sessionFile;
}

interface ActivePrompt {
	onDelta(delta: string): void;
	resolve(): void;
	reject(error: Error): void;
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;
type RpcState = Pick<RpcSessionState, "sessionId">;

function textDeltaFromEvent(event: Record<string, unknown>): string | undefined {
	if (event.type !== "message_update") return undefined;
	const assistantMessageEvent = event.assistantMessageEvent;
	if (!isRecord(assistantMessageEvent)) return undefined;
	if (assistantMessageEvent.type !== "text_delta") return undefined;
	const delta = assistantMessageEvent.delta;
	return typeof delta === "string" ? delta : undefined;
}

function responseData(response: Extract<RpcResponse, { success: true }>): unknown {
	return "data" in response ? response.data : undefined;
}

function isExtensionUiRequest(value: unknown): value is RpcExtensionUIRequest {
	if (!isRecord(value)) return false;
	if (value.type !== "extension_ui_request" || typeof value.id !== "string" || typeof value.method !== "string") {
		return false;
	}
	switch (value.method) {
		case "select":
			return typeof value.title === "string" && Array.isArray(value.options);
		case "confirm":
			return typeof value.title === "string" && typeof value.message === "string";
		case "input":
			return typeof value.title === "string";
		case "editor":
			return typeof value.title === "string";
		case "notify":
			return typeof value.message === "string";
		case "setStatus":
			return typeof value.statusKey === "string";
		case "setWidget":
			return typeof value.widgetKey === "string";
		case "setTitle":
			return typeof value.title === "string";
		case "set_editor_text":
			return typeof value.text === "string";
		default:
			return false;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
