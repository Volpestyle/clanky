import { createConnection, type Socket } from "node:net";
import { requestGateway, type SessionListResult } from "@clanky/gateway";
import type { RpcCommand, RpcResponse, RpcSessionState } from "@earendil-works/pi-coding-agent";

export class RpcChatClient {
	private readonly socket: Socket;
	private readonly pending = new Map<string, (response: RpcResponse) => void>();
	private activePrompt: ActivePrompt | undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
