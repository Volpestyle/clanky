import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGatewayServer } from "@clanky/gateway";
import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";

interface RpcResponseRecord {
	id?: string;
	type?: string;
	command?: string;
	success?: boolean;
	data?: unknown;
	error?: string;
}

const homeDir = await mkdtemp(join(tmpdir(), "clanky-pi-rpc-"));
const provider = "clanky-pi-rpc-faux";
const model = "clanky-pi-rpc-faux-model";
const rpcPromptText = "Pi RPC faux response.";
const fauxState = { callCount: 0 };
const server = await startGatewayServer({
	homeDir,
	configureModelRegistry: (modelRegistry) => {
		modelRegistry.registerProvider(provider, {
			api: "clanky-pi-rpc-faux-api",
			baseUrl: "http://localhost:0",
			apiKey: "test-key",
			streamSimple: (streamModel) => createFauxStream(streamModel, rpcPromptText),
			models: [
				{
					id: model,
					name: "Clanky Pi RPC Faux",
					reasoning: false,
					input: ["text"],
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
					},
					contextWindow: 128_000,
					maxTokens: 4_096,
				},
			],
		});
	},
});
let socket: Socket | undefined;
const watchdog = setTimeout(() => {
	console.error("Timed out in pi-rpc smoke");
	process.exit(1);
}, 15_000);

try {
	const seeded = await seedForkableSession();
	socket = createConnection(server.socketFile);
	await once(socket, "connect");
	const responses = collectResponses(socket);
	const statePromise = responses.next("state-1");
	const messagesPromise = responses.next("messages-1");
	socket.write(`${JSON.stringify({ id: "state-1", type: "get_state" })}\n`);
	socket.write(`${JSON.stringify({ id: "messages-1", type: "get_messages" })}\n`);

	const state = await statePromise;
	const messages = await messagesPromise;
	assert(state.command === "get_state" && state.success === true, "get_state failed");
	assert(messages.command === "get_messages" && messages.success === true, "get_messages failed");
	const stateData = state.data;
	const messagesData = messages.data;
	if (!isRecord(stateData) || typeof stateData.sessionId !== "string")
		throw new Error("get_state returned no session id");
	if (!isRecord(messagesData) || !Array.isArray(messagesData.messages)) {
		throw new Error("get_messages returned no messages array");
	}

	const abortPromise = responses.next("abort-1");
	socket.write(`${JSON.stringify({ id: "abort-1", type: "abort" })}\n`);
	const abort = await abortPromise;
	assert(abort.command === "abort" && abort.success === true, "abort failed");

	const newSessionPromise = responses.next("new-session-1");
	socket.write(`${JSON.stringify({ id: "new-session-1", type: "new_session", parentSession: seeded.sessionFile })}\n`);
	const newSession = await newSessionPromise;
	assert(newSession.command === "new_session" && newSession.success === true, "new_session failed");
	const newSessionStatePromise = responses.next("new-session-state-1");
	socket.write(`${JSON.stringify({ id: "new-session-state-1", type: "get_state" })}\n`);
	const newSessionState = await newSessionStatePromise;
	const newSessionStateData = newSessionState.data;
	if (
		!isRecord(newSessionStateData) ||
		typeof newSessionStateData.sessionId !== "string" ||
		typeof newSessionStateData.sessionFile !== "string" ||
		newSessionStateData.sessionId === stateData.sessionId
	) {
		throw new Error(`new_session did not bind a new current session: ${JSON.stringify(newSessionState)}`);
	}
	const parentedSessionFile = newSessionStateData.sessionFile;

	const setNamePromise = responses.next("set-name-1");
	socket.write(`${JSON.stringify({ id: "set-name-1", type: "set_session_name", name: "RPC smoke session" })}\n`);
	const setName = await setNamePromise;
	assert(setName.command === "set_session_name" && setName.success === true, "set_session_name failed");
	const namedStatePromise = responses.next("named-state-1");
	socket.write(`${JSON.stringify({ id: "named-state-1", type: "get_state" })}\n`);
	const namedState = await namedStatePromise;
	const namedStateData = namedState.data;
	if (!isRecord(namedStateData) || namedStateData.sessionName !== "RPC smoke session") {
		throw new Error(`set_session_name did not update RPC state: ${JSON.stringify(namedState)}`);
	}

	const steeringModePromise = responses.next("steering-mode-1");
	socket.write(`${JSON.stringify({ id: "steering-mode-1", type: "set_steering_mode", mode: "all" })}\n`);
	const steeringMode = await steeringModePromise;
	assert(steeringMode.command === "set_steering_mode" && steeringMode.success === true, "set_steering_mode failed");
	const followUpModePromise = responses.next("follow-up-mode-1");
	socket.write(`${JSON.stringify({ id: "follow-up-mode-1", type: "set_follow_up_mode", mode: "all" })}\n`);
	const followUpMode = await followUpModePromise;
	assert(followUpMode.command === "set_follow_up_mode" && followUpMode.success === true, "set_follow_up_mode failed");
	const autoCompactionPromise = responses.next("auto-compaction-1");
	socket.write(`${JSON.stringify({ id: "auto-compaction-1", type: "set_auto_compaction", enabled: false })}\n`);
	const autoCompaction = await autoCompactionPromise;
	assert(
		autoCompaction.command === "set_auto_compaction" && autoCompaction.success === true,
		"set_auto_compaction failed",
	);
	const autoRetryPromise = responses.next("auto-retry-1");
	socket.write(`${JSON.stringify({ id: "auto-retry-1", type: "set_auto_retry", enabled: false })}\n`);
	const autoRetry = await autoRetryPromise;
	assert(autoRetry.command === "set_auto_retry" && autoRetry.success === true, "set_auto_retry failed");
	const abortRetryPromise = responses.next("abort-retry-1");
	socket.write(`${JSON.stringify({ id: "abort-retry-1", type: "abort_retry" })}\n`);
	const abortRetry = await abortRetryPromise;
	assert(abortRetry.command === "abort_retry" && abortRetry.success === true, "abort_retry failed");
	const abortBashPromise = responses.next("abort-bash-1");
	socket.write(`${JSON.stringify({ id: "abort-bash-1", type: "abort_bash" })}\n`);
	const abortBash = await abortBashPromise;
	assert(abortBash.command === "abort_bash" && abortBash.success === true, "abort_bash failed");
	const modeStatePromise = responses.next("mode-state-1");
	socket.write(`${JSON.stringify({ id: "mode-state-1", type: "get_state" })}\n`);
	const modeState = await modeStatePromise;
	const modeStateData = modeState.data;
	if (
		!isRecord(modeStateData) ||
		modeStateData.steeringMode !== "all" ||
		modeStateData.followUpMode !== "all" ||
		modeStateData.autoCompactionEnabled !== false
	) {
		throw new Error(`RPC mode toggles did not update session state: ${JSON.stringify(modeState)}`);
	}
	const bashPromise = responses.next("bash-1");
	socket.write(`${JSON.stringify({ id: "bash-1", type: "bash", command: "printf clanky-rpc-bash" })}\n`);
	const bash = await bashPromise;
	const bashData = bash.data;
	if (
		bash.command !== "bash" ||
		bash.success !== true ||
		!isRecord(bashData) ||
		typeof bashData.output !== "string" ||
		!bashData.output.includes("clanky-rpc-bash")
	) {
		throw new Error(`bash returned unexpected payload: ${JSON.stringify(bash)}`);
	}

	const commandsPromise = responses.next("commands-1");
	socket.write(`${JSON.stringify({ id: "commands-1", type: "get_commands" })}\n`);
	const commands = await commandsPromise;
	const commandsData = commands.data;
	if (!isRecord(commandsData) || !Array.isArray(commandsData.commands)) {
		throw new Error(`get_commands returned unexpected payload: ${JSON.stringify(commands)}`);
	}

	const statsPromise = responses.next("stats-1");
	socket.write(`${JSON.stringify({ id: "stats-1", type: "get_session_stats" })}\n`);
	const stats = await statsPromise;
	if (stats.command !== "get_session_stats" || stats.success !== true || !isRecord(stats.data)) {
		throw new Error(`get_session_stats returned unexpected payload: ${JSON.stringify(stats)}`);
	}

	const modelsPromise = responses.next("models-1");
	socket.write(`${JSON.stringify({ id: "models-1", type: "get_available_models" })}\n`);
	const models = await modelsPromise;
	assert(models.command === "get_available_models" && models.success === true, "get_available_models failed");
	const modelsData = models.data;
	if (!isRecord(modelsData) || !hasAvailableModel(modelsData.models, provider, model)) {
		throw new Error(`get_available_models did not include the faux model: ${JSON.stringify(models)}`);
	}

	const setModelPromise = responses.next("set-model-1");
	socket.write(`${JSON.stringify({ id: "set-model-1", type: "set_model", provider, modelId: model })}\n`);
	const setModel = await setModelPromise;
	assert(setModel.command === "set_model" && setModel.success === true, "set_model failed");
	const cycleModelPromise = responses.next("cycle-model-1");
	socket.write(`${JSON.stringify({ id: "cycle-model-1", type: "cycle_model" })}\n`);
	const cycleModel = await cycleModelPromise;
	assert(cycleModel.command === "cycle_model" && cycleModel.success === true, "cycle_model failed");
	const thinkingPromise = responses.next("thinking-1");
	socket.write(`${JSON.stringify({ id: "thinking-1", type: "set_thinking_level", level: "high" })}\n`);
	const thinking = await thinkingPromise;
	assert(thinking.command === "set_thinking_level" && thinking.success === true, "set_thinking_level failed");
	const cycleThinkingPromise = responses.next("cycle-thinking-1");
	socket.write(`${JSON.stringify({ id: "cycle-thinking-1", type: "cycle_thinking_level" })}\n`);
	const cycleThinking = await cycleThinkingPromise;
	assert(
		cycleThinking.command === "cycle_thinking_level" && cycleThinking.success === true,
		"cycle_thinking_level failed",
	);

	const promptPromise = responses.next("prompt-1");
	const agentEndPromise = responses.nextEvent("agent_end");
	socket.write(`${JSON.stringify({ id: "prompt-1", type: "prompt", message: "Exercise Pi RPC prompt" })}\n`);
	const prompt = await promptPromise;
	assert(prompt.command === "prompt" && prompt.success === true, "prompt preflight failed");
	await agentEndPromise;
	const lastAssistantPromise = responses.next("last-assistant-1");
	socket.write(`${JSON.stringify({ id: "last-assistant-1", type: "get_last_assistant_text" })}\n`);
	const lastAssistant = await lastAssistantPromise;
	const lastAssistantData = lastAssistant.data;
	if (!isRecord(lastAssistantData) || lastAssistantData.text !== rpcPromptText) {
		throw new Error(`Pi RPC prompt did not persist the assistant response: ${JSON.stringify(lastAssistant)}`);
	}
	const parentedSessionHeaderText = (await readFile(parentedSessionFile, "utf8")).split("\n")[0];
	if (parentedSessionHeaderText === undefined) {
		throw new Error("new_session parent session JSONL did not contain a header");
	}
	const parentedSessionHeader = JSON.parse(parentedSessionHeaderText) as unknown;
	if (!isRecord(parentedSessionHeader) || parentedSessionHeader.parentSession !== seeded.sessionFile) {
		throw new Error(`new_session did not preserve parentSession: ${JSON.stringify(parentedSessionHeader)}`);
	}
	const exportPath = join(homeDir, "rpc-session.html");
	const exportHtmlPromise = responses.next("export-html-1");
	socket.write(`${JSON.stringify({ id: "export-html-1", type: "export_html", outputPath: exportPath })}\n`);
	const exportedHtml = await exportHtmlPromise;
	const exportedHtmlData = exportedHtml.data;
	if (
		exportedHtml.command !== "export_html" ||
		exportedHtml.success !== true ||
		!isRecord(exportedHtmlData) ||
		exportedHtmlData.path !== exportPath
	) {
		throw new Error(`export_html returned unexpected payload: ${JSON.stringify(exportedHtml)}`);
	}
	const exportedHtmlText = await readFile(exportPath, "utf8");
	const exportedSessionDataMatch = exportedHtmlText.match(
		/<script id="session-data" type="application\/json">([^<]+)<\/script>/,
	);
	const exportedSessionPayload = exportedSessionDataMatch?.[1];
	if (exportedSessionPayload === undefined) {
		throw new Error("export_html output did not include the embedded session payload");
	}
	const exportedSessionData = JSON.parse(Buffer.from(exportedSessionPayload, "base64").toString("utf8")) as unknown;
	if (!JSON.stringify(exportedSessionData).includes(rpcPromptText)) {
		throw new Error("export_html embedded session payload did not include the RPC assistant response");
	}

	const switchPromise = responses.next("switch-1");
	socket.write(`${JSON.stringify({ id: "switch-1", type: "switch_session", sessionPath: seeded.sessionFile })}\n`);
	const switched = await switchPromise;
	assert(switched.command === "switch_session" && switched.success === true, "switch_session failed");

	const forkMessagesPromise = responses.next("fork-messages-1");
	socket.write(`${JSON.stringify({ id: "fork-messages-1", type: "get_fork_messages" })}\n`);
	const forkMessages = await forkMessagesPromise;
	assert(forkMessages.command === "get_fork_messages" && forkMessages.success === true, "get_fork_messages failed");
	const forkMessagesData = forkMessages.data;
	if (!isRecord(forkMessagesData) || !Array.isArray(forkMessagesData.messages)) {
		throw new Error("get_fork_messages returned no messages array");
	}

	const clonePromise = responses.next("clone-1");
	const cloneStatePromise = responses.next("clone-state-1");
	socket.write(`${JSON.stringify({ id: "clone-1", type: "clone" })}\n`);
	const cloned = await clonePromise;
	assert(cloned.command === "clone" && cloned.success === true, "clone failed");
	socket.write(`${JSON.stringify({ id: "clone-state-1", type: "get_state" })}\n`);
	const cloneState = await cloneStatePromise;
	const cloneStateData = cloneState.data;
	if (!isRecord(cloneStateData) || cloneStateData.sessionId === seeded.sessionId) {
		throw new Error("clone did not switch to a new session");
	}

	const switchBackPromise = responses.next("switch-2");
	socket.write(`${JSON.stringify({ id: "switch-2", type: "switch_session", sessionPath: seeded.sessionFile })}\n`);
	await switchBackPromise;
	const forkPromise = responses.next("fork-1");
	const forkStatePromise = responses.next("fork-state-1");
	socket.write(`${JSON.stringify({ id: "fork-1", type: "fork", entryId: seeded.userEntryId })}\n`);
	const forked = await forkPromise;
	assert(forked.command === "fork" && forked.success === true, "fork failed");
	const forkedData = forked.data;
	if (!isRecord(forkedData) || forkedData.text !== "First prompt") throw new Error("fork returned wrong text");
	socket.write(`${JSON.stringify({ id: "fork-state-1", type: "get_state" })}\n`);
	const forkState = await forkStatePromise;
	const forkStateData = forkState.data;
	if (!isRecord(forkStateData) || forkStateData.sessionId === seeded.sessionId) {
		throw new Error("fork did not switch to a new session");
	}

	console.log(
		JSON.stringify({
			sessionId: stateData.sessionId,
			messageCount: messagesData.messages.length,
			modelCalls: fauxState.callCount,
			forkMessages: forkMessagesData.messages.length,
			cloneSessionId: cloneStateData.sessionId,
			forkSessionId: forkStateData.sessionId,
		}),
	);
} finally {
	clearTimeout(watchdog);
	socket?.destroy();
	await server.close();
	await rm(homeDir, { force: true, recursive: true });
}

async function seedForkableSession(): Promise<{ sessionId: string; sessionFile: string; userEntryId: string }> {
	const registered = await server.registry.createSession({ noTools: "all" });
	const userEntryId = registered.session.sessionManager.appendMessage({
		role: "user",
		content: "First prompt",
		timestamp: Date.now(),
	});
	registered.session.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "First answer" }],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
	const sessionFile = await server.registry.refreshSessionFile(registered.id);
	if (sessionFile === undefined) throw new Error("Seeded session was not persisted");
	return { sessionId: registered.id, sessionFile, userEntryId };
}

function collectResponses(socket: Socket): {
	next(id: string): Promise<RpcResponseRecord>;
	nextEvent(type: string): Promise<Record<string, unknown>>;
} {
	let buffer = "";
	const pending = new Map<string, (response: RpcResponseRecord) => void>();
	const pendingEvents = new Map<string, (event: Record<string, unknown>) => void>();
	socket.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		let newlineIndex = buffer.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = buffer.slice(0, newlineIndex);
			buffer = buffer.slice(newlineIndex + 1);
			const parsed = JSON.parse(line) as unknown;
			if (isRecord(parsed) && parsed.type === "response" && typeof parsed.id === "string") {
				pending.get(parsed.id)?.(parsed as RpcResponseRecord);
			} else if (isRecord(parsed) && typeof parsed.type === "string") {
				pendingEvents.get(parsed.type)?.(parsed);
			}
			newlineIndex = buffer.indexOf("\n");
		}
	});
	return {
		next: (id) =>
			new Promise<RpcResponseRecord>((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${id}`)), 5000);
				pending.set(id, (response) => {
					clearTimeout(timeout);
					pending.delete(id);
					resolve(response);
				});
			}),
		nextEvent: (type) =>
			new Promise<Record<string, unknown>>((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 5000);
				pendingEvents.set(type, (event) => {
					clearTimeout(timeout);
					pendingEvents.delete(type);
					resolve(event);
				});
			}),
	};
}

async function once(socket: Socket, event: "connect"): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		socket.once(event, resolve);
		socket.once("error", reject);
	});
}

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasAvailableModel(value: unknown, expectedProvider: string, expectedModel: string): boolean {
	if (!Array.isArray(value)) return false;
	return value.some((item) => isRecord(item) && item.provider === expectedProvider && item.id === expectedModel);
}

function createFauxStream(streamModel: Model<Api>, text: string) {
	fauxState.callCount += 1;
	const message = createAssistantMessage(streamModel, text);
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		stream.push({ type: "text_start", contentIndex: 0, partial: message });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

function createAssistantMessage(streamModel: Model<Api>, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: streamModel.api,
		provider: streamModel.provider,
		model: streamModel.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}
