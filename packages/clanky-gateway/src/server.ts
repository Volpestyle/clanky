import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { CronScheduler, SessionRegistry, type SessionRegistryOptions } from "@clanky/core";
import {
	type AdapterFactory,
	type ChatSessionMapping,
	createDiscordAdapterFactory,
	createTelegramAdapterFactory,
	loadMessagingConfigFromEnv,
	type MemoryRetriever,
	type MemoryWriter,
	type MessageEvent,
	MessagingManager,
	type MessagingManagerEvents,
} from "@clanky/messaging";
import { ExternalMcpManager } from "./external-mcp.ts";
import { type HttpGatewayOptions, type HttpGatewayServer, startHttpGateway } from "./http.ts";
import { ensureHttpToken, rotateHttpToken } from "./http-token.ts";
import {
	addCronJob,
	addSkill,
	addTask,
	beginAuthOAuth,
	callExternalMcpTool,
	cancelAuthOAuth,
	createLinearIssue,
	disableCronJob,
	enableCronJob,
	exportMemory,
	flushLinearOutbox,
	forgetMemory,
	forkSession,
	getAuthStatus,
	getMemoryStatus,
	getMessagingStatus,
	getStatus,
	linkLinearIssue,
	listCronJobs,
	listExternalMcpServers,
	listLinearLinks,
	listLinearOutbox,
	listMessagingSessions,
	listSessions,
	listSkills,
	listSkillUsage,
	listTasks,
	readMessagingResetParams,
	readMessagingSessionsParams,
	rememberMemory,
	removeAuth,
	removeCronJob,
	removeSkill,
	resetMessagingSession,
	runCronJobNow,
	searchMemory,
	searchSessions,
	sendPrompt,
	setAuthApiKey,
	setMemoryConsent,
	updateTask,
	waitAuthOAuth,
} from "./operations.ts";
import { isRpcInput, PiRpcSocket } from "./pi-rpc.ts";
import {
	type GatewayRequest,
	type GatewayResponse,
	isGatewayRequest,
	readAuthOAuthBeginParams,
	readAuthOAuthWaitParams,
	readAuthRemoveParams,
	readAuthSetApiKeyParams,
	readCronAddParams,
	readCronJobIdParams,
	readExternalMcpCallParams,
	readLinearCreateParams,
	readLinearFlushParams,
	readLinearLinkParams,
	readMemoryConsentParams,
	readMemoryForgetParams,
	readMemoryRememberParams,
	readMemorySearchParams,
	readSendParams,
	readSessionForkParams,
	readSessionSearchParams,
	readSkillAddParams,
	readSkillRemoveParams,
	readTaskAddParams,
	readTaskListParams,
	readTaskUpdateParams,
} from "./protocol.ts";
import { GatewayEventHub, gatewayEvent } from "./ws.ts";

export interface StartGatewayServerOptions extends SessionRegistryOptions {
	socketFile?: string;
	http?: Pick<HttpGatewayOptions, "hostname" | "port">;
	newHttpToken?: boolean;
	messagingAdapterFactories?: Partial<Record<"telegram" | "discord", AdapterFactory>>;
	messagingProvider?: string;
	messagingModel?: string;
}

export interface GatewayServer {
	registry: SessionRegistry;
	cron: CronScheduler;
	externalMcp: ExternalMcpManager;
	messaging: MessagingManager;
	events: GatewayEventHub;
	socketFile: string;
	closed: Promise<void>;
	http?: HttpGatewayServer;
	close(): Promise<void>;
}

export async function startGatewayServer(options: StartGatewayServerOptions = {}): Promise<GatewayServer> {
	const startedAt = Date.now();
	const registry = new SessionRegistry(options);
	await registry.start();
	const externalMcp = ExternalMcpManager.fromEnv({ cwd: options.cwd ?? process.cwd() });
	const events = new GatewayEventHub();
	const messagingEvents: MessagingManagerEvents = {
		onReceived: (event) => {
			const payload: Parameters<typeof gatewayEvent>[0] = {
				type: "messaging.received",
				platform: event.platform,
				chatId: event.chatId,
				userId: event.userId,
				sessionId: event.sessionId,
				text: event.text,
			};
			if (event.threadId !== undefined) payload.threadId = event.threadId;
			if (event.command !== undefined) payload.command = event.command;
			events.publish(gatewayEvent(payload));
		},
		onSent: (event) => {
			const payload: Parameters<typeof gatewayEvent>[0] = {
				type: "messaging.sent",
				platform: event.platform,
				chatId: event.chatId,
				sessionId: event.sessionId,
				messageIds: event.messageIds,
				chunks: event.chunks,
				floodFallback: event.floodFallback,
				durationMs: event.durationMs,
			};
			if (event.threadId !== undefined) payload.threadId = event.threadId;
			events.publish(gatewayEvent(payload));
		},
		onError: (event) => {
			const payload: Parameters<typeof gatewayEvent>[0] = {
				type: "messaging.error",
				platform: event.platform,
				chatId: event.chatId,
				error: event.error,
			};
			if (event.sessionId !== undefined) payload.sessionId = event.sessionId;
			events.publish(gatewayEvent(payload));
		},
		onPolicy: (event) => {
			const payload: Parameters<typeof gatewayEvent>[0] = {
				type: "messaging.policy",
				platform: event.platform,
				chatId: event.chatId,
				userId: event.userId,
				decision: event.decision.type,
			};
			if (event.decision.type === "ignore" || event.decision.type === "reject") payload.reason = event.decision.reason;
			events.publish(gatewayEvent(payload));
		},
	};
	const messagingConfig = loadMessagingConfigFromEnv();
	const messagingManagerOptions: ConstructorParameters<typeof MessagingManager>[0] = {
		registry,
		clankyPaths: registry.paths,
		config: messagingConfig,
		events: messagingEvents,
		memory: createMessagingMemoryWriter(registry),
		retriever: createMessagingMemoryRetriever(registry),
	};
	const adapterFactories: Partial<Record<"telegram" | "discord", AdapterFactory>> = {
		...(options.messagingAdapterFactories ?? {}),
	};
	if (adapterFactories.telegram === undefined && messagingConfig.telegram.enabled) {
		adapterFactories.telegram = createTelegramAdapterFactory({
			deps: {
				resetChatSession: async (chatId: string, threadId?: string, userId?: string) => {
					const key: MessagingResetKey = { platform: "telegram", chatId };
					if (threadId !== undefined) key.threadId = threadId;
					if (userId !== undefined) key.userId = userId;
					await messagingDeferredReset(messagingHolder, key);
				},
				abortChatSession: async (chatId: string, threadId?: string, userId?: string) => {
					const key: MessagingResetKey = { platform: "telegram", chatId };
					if (threadId !== undefined) key.threadId = threadId;
					if (userId !== undefined) key.userId = userId;
					await messagingDeferredAbort(messagingHolder, registry, key);
				},
			},
		});
	}
	if (adapterFactories.discord === undefined && messagingConfig.discord.enabled) {
		adapterFactories.discord = createDiscordAdapterFactory({
			deps: {
				resetChatSession: async (chatId: string, threadId?: string, userId?: string) => {
					const key: MessagingResetKey = { platform: "discord", chatId };
					if (threadId !== undefined) key.threadId = threadId;
					if (userId !== undefined) key.userId = userId;
					await messagingDeferredReset(messagingHolder, key);
				},
				abortChatSession: async (chatId: string, threadId?: string, userId?: string) => {
					const key: MessagingResetKey = { platform: "discord", chatId };
					if (threadId !== undefined) key.threadId = threadId;
					if (userId !== undefined) key.userId = userId;
					await messagingDeferredAbort(messagingHolder, registry, key);
				},
			},
		});
	}
	messagingManagerOptions.adapterFactories = adapterFactories;
	if (options.messagingProvider !== undefined) messagingManagerOptions.provider = options.messagingProvider;
	if (options.messagingModel !== undefined) messagingManagerOptions.model = options.messagingModel;
	const messaging = new MessagingManager(messagingManagerOptions);
	const messagingHolder: { current: MessagingManager } = { current: messaging };
	const cron = new CronScheduler({
		registry,
		onTickRun: (result) => {
			const eventInput: Parameters<typeof gatewayEvent>[0] = {
				type: "cron.ran",
				jobId: result.jobId,
				ok: result.ok,
			};
			if (result.error !== undefined) eventInput.error = result.error;
			events.publish(gatewayEvent(eventInput));
		},
	});
	registry.setAgentToolHandlers({
		scheduleCron: async (input) => await addCronJob(cron, readCronAddParams(input), events),
		externalMcpCall: async (input) => await callExternalMcpTool(externalMcp, readExternalMcpCallParams(input)),
		externalMcpStatus: async () => listExternalMcpServers(externalMcp),
		listCron: async () => await listCronJobs(cron),
	});
	const socketFile = options.socketFile ?? registry.paths.socketFile;
	await mkdir(dirname(socketFile), { recursive: true, mode: 0o700 });
	let releaseLock: (() => Promise<void>) | undefined;
	const releaseDaemonLock = async () => {
		const release = releaseLock;
		releaseLock = undefined;
		await release?.();
	};
	try {
		releaseLock = await acquireDaemonLock(registry.paths.daemonLockFile);
		await removeStaleSocket(socketFile);
		await externalMcp.start();
		await messaging.start();
	} catch (error) {
		await messaging.close();
		await externalMcp.close();
		await registry.dispose();
		await releaseDaemonLock();
		throw error;
	}

	const server = createServer((socket) => {
		handleSocket(socket, registry, cron, externalMcp, messaging, events, socketFile, startedAt, closeGateway).catch(
			(error: unknown) => {
				writeResponse(socket, {
					id: "unknown",
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				});
				socket.end();
			},
		);
	});
	const closed = new Promise<void>((resolve) => {
		server.once("close", resolve);
	});
	let http: HttpGatewayServer | undefined;
	let closedGateway = false;
	async function closeGateway(): Promise<void> {
		if (closedGateway) return;
		closedGateway = true;
		cron.stop();
		events.close();
		await messaging.close();
		await externalMcp.close();
		await registry.drainSessions();
		await http?.close();
		await closeServer(server);
		await registry.dispose();
		await unlink(socketFile).catch(() => undefined);
		await releaseDaemonLock();
	}

	try {
		await cron.start();
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketFile, () => {
				server.off("error", reject);
				resolve();
			});
		});
	} catch (error) {
		await closeGateway();
		throw error;
	}

	try {
		if (options.http) {
			const token = options.newHttpToken
				? await rotateHttpToken(registry.paths.httpTokenFile)
				: await ensureHttpToken(registry.paths.httpTokenFile);
			http = startHttpGateway(registry, cron, externalMcp, events, {
				hostname: options.http.hostname,
				port: options.http.port,
				socketFile,
				startedAt,
				token,
			});
		}
	} catch (error) {
		await closeGateway();
		throw error;
	}

	const result: GatewayServer = {
		registry,
		cron,
		externalMcp,
		messaging,
		events,
		socketFile,
		closed,
		close: closeGateway,
	};
	if (http !== undefined) result.http = http;
	return result;
}

async function handleSocket(
	socket: Socket,
	registry: SessionRegistry,
	cron: CronScheduler,
	externalMcp: ExternalMcpManager,
	messaging: MessagingManager,
	events: GatewayEventHub,
	socketFile: string,
	startedAt: number,
	closeGateway: () => Promise<void>,
): Promise<void> {
	let buffer = "";
	let rpcSocket: PiRpcSocket | undefined;
	socket.on("close", () => {
		rpcSocket?.close();
	});
	socket.on("error", () => {
		rpcSocket?.close();
	});
	socket.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		let newlineIndex = buffer.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = buffer.slice(0, newlineIndex);
			buffer = buffer.slice(newlineIndex + 1);
			if (rpcSocket !== undefined) {
				rpcSocket.handleLine(line);
			} else {
				rpcSocket = handleFirstLine(
					socket,
					registry,
					cron,
					externalMcp,
					messaging,
					events,
					socketFile,
					startedAt,
					closeGateway,
					line,
				);
			}
			newlineIndex = buffer.indexOf("\n");
		}
	});
}

function handleFirstLine(
	socket: Socket,
	registry: SessionRegistry,
	cron: CronScheduler,
	externalMcp: ExternalMcpManager,
	messaging: MessagingManager,
	events: GatewayEventHub,
	socketFile: string,
	startedAt: number,
	closeGateway: () => Promise<void>,
	line: string,
): PiRpcSocket | undefined {
	if (line.endsWith("\r")) line = line.slice(0, -1);
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		writeResponse(socket, { id: "unknown", ok: false, error: "Invalid JSON request" });
		socket.end();
		return undefined;
	}
	if (isGatewayRequest(parsed)) {
		void handleGatewayRequest(
			socket,
			registry,
			cron,
			externalMcp,
			messaging,
			events,
			socketFile,
			startedAt,
			closeGateway,
			parsed,
		);
		return undefined;
	}
	if (isRpcInput(parsed)) {
		const rpcSocket = new PiRpcSocket({ registry, socket });
		rpcSocket.handleLine(line);
		return rpcSocket;
	}
	writeResponse(socket, { id: "unknown", ok: false, error: "Invalid gateway or Pi RPC request" });
	socket.end();
	return undefined;
}

async function handleGatewayRequest(
	socket: Socket,
	registry: SessionRegistry,
	cron: CronScheduler,
	externalMcp: ExternalMcpManager,
	messaging: MessagingManager,
	events: GatewayEventHub,
	socketFile: string,
	startedAt: number,
	closeGateway: () => Promise<void>,
	request: GatewayRequest,
): Promise<void> {
	try {
		const result = await dispatch(
			request,
			registry,
			cron,
			externalMcp,
			messaging,
			events,
			socketFile,
			startedAt,
			closeGateway,
		);
		writeResponse(socket, { id: request.id, ok: true, result });
	} catch (error) {
		writeResponse(socket, { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
	}
	socket.end();
}

async function dispatch(
	request: GatewayRequest,
	registry: SessionRegistry,
	cron: CronScheduler,
	externalMcp: ExternalMcpManager,
	messaging: MessagingManager,
	events: GatewayEventHub,
	socketFile: string,
	startedAt: number,
	closeGateway: () => Promise<void>,
): Promise<unknown> {
	if (request.method === "status") {
		return await getStatus(registry, cron, externalMcp, socketFile, startedAt);
	}

	if (request.method === "auth.status") {
		return getAuthStatus(registry);
	}

	if (request.method === "auth.set_api_key") {
		return setAuthApiKey(registry, readAuthSetApiKeyParams(request.params));
	}

	if (request.method === "auth.remove") {
		return removeAuth(registry, readAuthRemoveParams(request.params));
	}

	if (request.method === "auth.oauth.begin") {
		return await beginAuthOAuth(registry, readAuthOAuthBeginParams(request.params));
	}

	if (request.method === "auth.oauth.wait") {
		return await waitAuthOAuth(registry, readAuthOAuthWaitParams(request.params));
	}

	if (request.method === "auth.oauth.cancel") {
		return cancelAuthOAuth(registry, readAuthOAuthWaitParams(request.params));
	}

	if (request.method === "memory.status") {
		return await getMemoryStatus(registry);
	}

	if (request.method === "memory.search") {
		return await searchMemory(registry, readMemorySearchParams(request.params));
	}

	if (request.method === "memory.remember") {
		return await rememberMemory(registry, readMemoryRememberParams(request.params));
	}

	if (request.method === "memory.forget") {
		return await forgetMemory(registry, readMemoryForgetParams(request.params));
	}

	if (request.method === "memory.export") {
		return await exportMemory(registry);
	}

	if (request.method === "memory.consent") {
		return await setMemoryConsent(registry, readMemoryConsentParams(request.params));
	}

	if (request.method === "messaging.status") {
		return getMessagingStatus(messaging);
	}

	if (request.method === "messaging.sessions") {
		return await listMessagingSessions(messaging, readMessagingSessionsParams(request.params));
	}

	if (request.method === "messaging.reset") {
		return await resetMessagingSession(messaging, readMessagingResetParams(request.params));
	}

	if (request.method === "shutdown") {
		setImmediate(() => {
			closeGateway().catch((error: unknown) => {
				console.error(error instanceof Error ? error.message : String(error));
			});
		});
		return { ok: true };
	}

	if (request.method === "session.list") {
		return await listSessions(registry);
	}

	if (request.method === "session.fork") {
		return await forkSession(registry, readSessionForkParams(request.params));
	}

	if (request.method === "session.search") {
		return await searchSessions(registry, readSessionSearchParams(request.params));
	}

	if (request.method === "skill.list") {
		return listSkills(registry);
	}

	if (request.method === "skill.usage") {
		return await listSkillUsage(registry);
	}

	if (request.method === "skill.add") {
		return await addSkill(registry, readSkillAddParams(request.params));
	}

	if (request.method === "skill.remove") {
		return await removeSkill(registry, readSkillRemoveParams(request.params));
	}

	if (request.method === "task.list") {
		return await listTasks(registry, readTaskListParams(request.params));
	}

	if (request.method === "task.add") {
		return await addTask(registry, readTaskAddParams(request.params));
	}

	if (request.method === "task.update") {
		return await updateTask(registry, readTaskUpdateParams(request.params));
	}

	if (request.method === "mcp.list") {
		return listExternalMcpServers(externalMcp);
	}

	if (request.method === "mcp.call") {
		return await callExternalMcpTool(externalMcp, readExternalMcpCallParams(request.params));
	}

	if (request.method === "linear.list") {
		return await listLinearLinks(registry);
	}

	if (request.method === "linear.create") {
		return await createLinearIssue(registry, readLinearCreateParams(request.params));
	}

	if (request.method === "linear.link") {
		return await linkLinearIssue(registry, readLinearLinkParams(request.params));
	}

	if (request.method === "linear.outbox") {
		return await listLinearOutbox(registry);
	}

	if (request.method === "linear.flush") {
		return await flushLinearOutbox(registry, readLinearFlushParams(request.params));
	}

	if (request.method === "cron.list") {
		return await listCronJobs(cron);
	}

	if (request.method === "cron.add") {
		return await addCronJob(cron, readCronAddParams(request.params), events);
	}

	if (request.method === "cron.remove") {
		return await removeCronJob(cron, readCronJobIdParams(request.params), events);
	}

	if (request.method === "cron.enable") {
		return await enableCronJob(cron, readCronJobIdParams(request.params), events);
	}

	if (request.method === "cron.disable") {
		return await disableCronJob(cron, readCronJobIdParams(request.params), events);
	}

	if (request.method === "cron.run_now") {
		return await runCronJobNow(cron, readCronJobIdParams(request.params), events);
	}

	const params = readSendParams(request.params);
	return await sendPrompt(registry, params, events);
}

interface MessagingResetKey {
	platform: "telegram" | "discord";
	chatId: string;
	threadId?: string;
	userId?: string;
}

function createMessagingMemoryWriter(registry: SessionRegistry): MemoryWriter {
	return {
		recordInbound: async ({ event, mapping }) => {
			if (!shouldUseMessagingMemory(event, mapping)) return;
			if (event.text.trim().length === 0) return;
			const subject = messagingSourceSubject(event, mapping);
			await registry.recordMemoryEvent({
				...subject,
				source: event.platform,
				sourceId: event.platformMessageId,
				text: event.text,
				metadata: messagingEventMetadata(event, mapping, "inbound"),
				createdAt: new Date(event.timestamp).toISOString(),
			});
		},
		recordOutbound: async ({ event, mapping, replyText, replyMessageIds, durationMs }) => {
			if (!shouldUseMessagingMemory(event, mapping)) return;
			if (replyText.trim().length === 0) return;
			const subject = messagingSourceSubject(event, mapping);
			const sourceId = replyMessageIds.length === 0 ? undefined : replyMessageIds.join(",");
			await registry.recordMemoryEvent({
				...subject,
				source: event.platform,
				text: replyText,
				metadata: {
					...messagingEventMetadata(event, mapping, "outbound"),
					replyMessageIds,
					durationMs,
				},
				...(sourceId === undefined ? {} : { sourceId }),
			});
		},
	};
}

function createMessagingMemoryRetriever(registry: SessionRegistry): MemoryRetriever {
	return {
		buildContext: async (event, mapping) => {
			if (!shouldUseMessagingMemory(event, mapping)) return undefined;
			const packet = await registry.memoryPacket({
				sessionId: mapping.sessionId,
				prompt: event.text,
				cwd: registry.paths.profileDir,
				scopes: messagingMemoryScopes(registry, event, mapping),
			});
			return packet.text;
		},
	};
}

function shouldUseMessagingMemory(event: MessageEvent, mapping: ChatSessionMapping): boolean {
	return event.chatType === "dm" || event.mentionsBot || event.command !== undefined || mapping.mode !== "mention";
}

function messagingSourceSubject(
	event: MessageEvent,
	mapping: ChatSessionMapping,
): { scope: "user" | "dm" | "channel"; subjectId: string } {
	if (event.chatType === "dm") return { scope: "user", subjectId: messagingUserSubject(event.userId, event.platform) };
	if (mapping.mode === "dm_relationship" && mapping.userId !== undefined) {
		return { scope: "user", subjectId: messagingUserSubject(mapping.userId, event.platform) };
	}
	return { scope: "channel", subjectId: messagingChatSubject(event) };
}

function messagingMemoryScopes(
	registry: SessionRegistry,
	event: MessageEvent,
	mapping: ChatSessionMapping,
): Array<{ scope: "agent" | "user" | "dm" | "channel"; subjectId: string }> {
	const scopes: Array<{ scope: "agent" | "user" | "dm" | "channel"; subjectId: string }> = [
		{ scope: "agent", subjectId: registry.paths.profile },
		{ scope: "user", subjectId: messagingUserSubject(event.userId, event.platform) },
		{ scope: "channel", subjectId: messagingChatSubject(event) },
	];
	if (mapping.userId !== undefined && mapping.userId !== event.userId) {
		scopes.push({ scope: "user", subjectId: messagingUserSubject(mapping.userId, event.platform) });
	}
	if (event.chatType === "dm") scopes.push({ scope: "dm", subjectId: messagingChatSubject(event) });
	return uniqueMessagingScopes(scopes);
}

function messagingEventMetadata(
	event: MessageEvent,
	mapping: ChatSessionMapping,
	direction: "inbound" | "outbound",
): Record<string, unknown> {
	return {
		direction,
		platform: event.platform,
		chatId: event.chatId,
		chatType: event.chatType,
		userId: event.userId,
		sessionId: mapping.sessionId,
		mentionsBot: event.mentionsBot,
		...(event.threadId === undefined ? {} : { threadId: event.threadId }),
		...(event.command === undefined ? {} : { command: event.command }),
		...(event.commandArgs === undefined ? {} : { commandArgs: event.commandArgs }),
	};
}

function messagingUserSubject(userId: string, platform: MessageEvent["platform"]): string {
	return `${platform}:user:${userId}`;
}

function messagingChatSubject(event: MessageEvent): string {
	const thread = event.threadId === undefined ? "" : `:thread:${event.threadId}`;
	return `${event.platform}:chat:${event.chatId}${thread}`;
}

function uniqueMessagingScopes<T extends { scope: string; subjectId: string }>(scopes: T[]): T[] {
	const seen = new Set<string>();
	const result: T[] = [];
	for (const scope of scopes) {
		const key = `${scope.scope}:${scope.subjectId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(scope);
	}
	return result;
}

async function messagingDeferredReset(holder: { current: MessagingManager }, key: MessagingResetKey): Promise<void> {
	try {
		await holder.current.broker.resetMapping(key);
	} catch {
		// ignore
	}
}

async function messagingDeferredAbort(
	holder: { current: MessagingManager },
	registry: SessionRegistry,
	key: MessagingResetKey,
): Promise<void> {
	const mapping = await holder.current.broker.listMappings(key.platform).catch(() => []);
	const candidate = mapping.find(
		(entry) =>
			entry.chatId === key.chatId &&
			(entry.threadId ?? undefined) === key.threadId &&
			(entry.userId ?? undefined) === key.userId,
	);
	if (candidate === undefined) return;
	const live = registry.get(candidate.sessionId);
	if (live === undefined) return;
	try {
		await live.session.abort();
	} catch {
		// ignore
	}
}

function writeResponse(socket: Socket, response: GatewayResponse): void {
	socket.write(`${JSON.stringify(response)}\n`);
}

async function removeStaleSocket(socketFile: string): Promise<void> {
	const isActive = await canConnect(socketFile);
	if (isActive) {
		throw new Error(`Clanky daemon already appears to be running at ${socketFile}`);
	}
	await unlink(socketFile).catch(() => undefined);
}

async function canConnect(socketFile: string): Promise<boolean> {
	return await new Promise<boolean>((resolve) => {
		const socket = createConnection(socketFile);
		const timeout = setTimeout(() => {
			socket.destroy();
			resolve(false);
		}, 100);
		socket.once("connect", () => {
			clearTimeout(timeout);
			socket.end();
			resolve(true);
		});
		socket.once("error", () => {
			clearTimeout(timeout);
			resolve(false);
		});
	});
}

async function closeServer(server: Server): Promise<void> {
	if (!server.listening) return;
	await new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		});
	});
}

interface DaemonLockRecord {
	pid: number;
	startedAt: number;
	bootId: string;
}

const execFileAsync = promisify(execFile);

async function acquireDaemonLock(lockFile: string): Promise<() => Promise<void>> {
	await mkdir(dirname(lockFile), { recursive: true, mode: 0o700 });
	const lockText = `${JSON.stringify({ pid: process.pid, startedAt: Date.now(), bootId: randomUUID() })}\n`;

	try {
		await writeFile(lockFile, lockText, { flag: "wx", mode: 0o600 });
		return async () => {
			await unlink(lockFile).catch(() => undefined);
		};
	} catch (error) {
		if (!isFileExistsError(error)) throw error;
	}

	const existing = await readExistingLock(lockFile);
	if (existing !== undefined && (await isLockHolderRunning(existing))) {
		throw new Error(`Clanky daemon already appears to be running with pid ${existing.pid}`);
	}

	await unlink(lockFile).catch(() => undefined);
	try {
		await writeFile(lockFile, lockText, { flag: "wx", mode: 0o600 });
	} catch (error) {
		if (!isFileExistsError(error)) throw error;
		const competing = await readExistingLock(lockFile);
		if (competing !== undefined && (await isLockHolderRunning(competing))) {
			throw new Error(`Clanky daemon already appears to be running with pid ${competing.pid}`);
		}
		throw new Error("Clanky daemon lock was claimed by another process");
	}
	return async () => {
		await unlink(lockFile).catch(() => undefined);
	};
}

async function readExistingLock(lockFile: string): Promise<DaemonLockRecord | undefined> {
	let content: string;
	try {
		content = await readFile(lockFile, "utf8");
	} catch {
		return undefined;
	}
	const trimmed = content.trim();
	if (trimmed.length === 0) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const record = parsed as Record<string, unknown>;
	const pid = record.pid;
	const startedAt = record.startedAt;
	const bootId = record.bootId;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
	if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return undefined;
	if (typeof bootId !== "string" || bootId.length === 0) return undefined;
	return { pid, startedAt, bootId };
}

const PROCESS_START_TOLERANCE_MS = 2_000;

async function isLockHolderRunning(lock: DaemonLockRecord): Promise<boolean> {
	if (!isProcessAlive(lock.pid)) return false;
	const startedAt = await readProcessStartTime(lock.pid);
	if (startedAt === undefined) return true;
	return Math.abs(startedAt - lock.startedAt) <= PROCESS_START_TOLERANCE_MS;
}

async function readProcessStartTime(pid: number): Promise<number | undefined> {
	try {
		const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)]);
		const trimmed = stdout.trim();
		if (trimmed.length === 0) return undefined;
		const parsed = Date.parse(trimmed);
		return Number.isFinite(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function isFileExistsError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
