import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { CronScheduler, SessionRegistry, type SessionRegistryOptions } from "@clanky/core";
import { SwarmLeader, type SwarmLeaderEvent } from "@clanky/swarm";
import { ExternalMcpManager } from "./external-mcp.ts";
import { type HttpGatewayOptions, type HttpGatewayServer, startHttpGateway } from "./http.ts";
import { ensureHttpToken, rotateHttpToken } from "./http-token.ts";
import {
	addCronJob,
	addSkill,
	addTask,
	callExternalMcpTool,
	completeSwarm,
	createLinearIssue,
	disableCronJob,
	dispatchSwarm,
	enableCronJob,
	flushLinearOutbox,
	forkSession,
	getStatus,
	getSwarmFileLock,
	getSwarmSnapshot,
	getSwarmStatus,
	linkLinearIssue,
	listCronJobs,
	listExternalMcpServers,
	listLinearLinks,
	listLinearOutbox,
	listSessions,
	listSkills,
	listSkillUsage,
	listSwarmPeers,
	listSwarmTasks,
	listTasks,
	messageSwarm,
	mirrorSwarmActivityToLinear,
	removeCronJob,
	removeSkill,
	runCronJobNow,
	searchSessions,
	sendPrompt,
	updateTask,
} from "./operations.ts";
import { isRpcInput, PiRpcSocket } from "./pi-rpc.ts";
import {
	type GatewayRequest,
	type GatewayResponse,
	isGatewayRequest,
	readCronAddParams,
	readCronJobIdParams,
	readExternalMcpCallParams,
	readLinearCreateParams,
	readLinearFlushParams,
	readLinearLinkParams,
	readSendParams,
	readSessionForkParams,
	readSessionSearchParams,
	readSkillAddParams,
	readSkillRemoveParams,
	readSwarmCompleteParams,
	readSwarmDispatchParams,
	readSwarmFileLockParams,
	readSwarmMessageParams,
	readTaskAddParams,
	readTaskListParams,
	readTaskUpdateParams,
} from "./protocol.ts";
import { GatewayEventHub, gatewayEvent } from "./ws.ts";

export interface StartGatewayServerOptions extends SessionRegistryOptions {
	socketFile?: string;
	http?: Pick<HttpGatewayOptions, "hostname" | "port">;
	newHttpToken?: boolean;
}

export interface GatewayServer {
	registry: SessionRegistry;
	cron: CronScheduler;
	swarm: SwarmLeader;
	externalMcp: ExternalMcpManager;
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
	const swarm = new SwarmLeader(swarmLeaderOptions(registry, options));
	const externalMcp = ExternalMcpManager.fromEnv({ cwd: options.cwd ?? process.cwd() });
	const events = new GatewayEventHub();
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
		swarmDelivery: async (input) => {
			const result = await swarm.deliverCronOutput(input.target, input.message);
			if (!result.ok) throw new Error(result.message);
			return { deliveredTo: `swarm:${input.target}`, response: result };
		},
	});
	registry.setAgentToolHandlers({
		scheduleCron: async (input) => await addCronJob(cron, readCronAddParams(input), events),
		swarmDispatch: async (input) => await dispatchSwarm(swarm, input, registry),
		swarmFileLock: async (input) => await swarm.getFileLock(input.path),
		swarmMessage: async (input) => await messageSwarm(swarm, input),
		swarmComplete: async (input) => await completeSwarm(swarm, input, registry),
		swarmSnapshotForPrompt: async () => await getSwarmSnapshot(swarm),
		externalMcpCall: async (input) => await callExternalMcpTool(externalMcp, readExternalMcpCallParams(input)),
		externalMcpStatus: async () => listExternalMcpServers(externalMcp),
		listCron: async () => await listCronJobs(cron),
		checkSwarmFileLock: async (input) => {
			const result = await swarm.getFileLock(input.path);
			if (result.reason === undefined) return { blocked: result.blocked };
			return { blocked: result.blocked, reason: result.reason };
		},
		swarmStatus: async () => getSwarmStatus(swarm),
	});
	const unsubscribeSwarmEvents = swarm.subscribe((event) => {
		publishSwarmEvent(events, event);
		void mirrorSwarmActivityToLinear(registry, event).catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			events.publish(gatewayEvent({ type: "swarm.error", error: message }));
			console.error(message);
		});
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
		await swarm.start();
		await externalMcp.start();
	} catch (error) {
		unsubscribeSwarmEvents();
		await swarm.close();
		await externalMcp.close();
		await registry.dispose();
		await releaseDaemonLock();
		throw error;
	}

	const server = createServer((socket) => {
		handleSocket(socket, registry, cron, swarm, externalMcp, events, socketFile, startedAt, closeGateway).catch(
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
		unsubscribeSwarmEvents();
		await swarm.close();
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
			http = startHttpGateway(registry, cron, swarm, externalMcp, events, {
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
		swarm,
		externalMcp,
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
	swarm: SwarmLeader,
	externalMcp: ExternalMcpManager,
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
					swarm,
					externalMcp,
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
	swarm: SwarmLeader,
	externalMcp: ExternalMcpManager,
	events: GatewayEventHub,
	socketFile: string,
	startedAt: number,
	closeGateway: () => Promise<void>,
	line: string,
): PiRpcSocket | undefined {
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
			swarm,
			externalMcp,
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
	swarm: SwarmLeader,
	externalMcp: ExternalMcpManager,
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
			swarm,
			externalMcp,
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
	swarm: SwarmLeader,
	externalMcp: ExternalMcpManager,
	events: GatewayEventHub,
	socketFile: string,
	startedAt: number,
	closeGateway: () => Promise<void>,
): Promise<unknown> {
	if (request.method === "status") {
		return await getStatus(registry, cron, swarm, externalMcp, socketFile, startedAt);
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

	if (request.method === "swarm.status") {
		return getSwarmStatus(swarm);
	}

	if (request.method === "swarm.dispatch") {
		return await dispatchSwarm(swarm, readSwarmDispatchParams(request.params), registry);
	}

	if (request.method === "swarm.peers") {
		return await listSwarmPeers(swarm);
	}

	if (request.method === "swarm.tasks") {
		return await listSwarmTasks(swarm);
	}

	if (request.method === "swarm.snapshot") {
		return await getSwarmSnapshot(swarm);
	}

	if (request.method === "swarm.file_lock") {
		return await getSwarmFileLock(swarm, readSwarmFileLockParams(request.params).file);
	}

	if (request.method === "swarm.message") {
		return await messageSwarm(swarm, readSwarmMessageParams(request.params));
	}

	if (request.method === "swarm.complete") {
		return await completeSwarm(swarm, readSwarmCompleteParams(request.params), registry);
	}

	const params = readSendParams(request.params);
	return await sendPrompt(registry, params, events);
}

function swarmLeaderOptions(
	registry: SessionRegistry,
	options: StartGatewayServerOptions,
): ConstructorParameters<typeof SwarmLeader>[0] {
	const result: ConstructorParameters<typeof SwarmLeader>[0] = {
		profile: registry.paths.profile,
		profileDir: registry.paths.profileDir,
	};
	if (options.cwd !== undefined) result.cwd = options.cwd;
	return result;
}

function publishSwarmEvent(events: GatewayEventHub, event: SwarmLeaderEvent): void {
	events.publish(gatewayEvent(event));
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

async function acquireDaemonLock(lockFile: string): Promise<() => Promise<void>> {
	await mkdir(dirname(lockFile), { recursive: true, mode: 0o700 });
	const pidText = `${process.pid}\n`;

	try {
		await writeFile(lockFile, pidText, { flag: "wx", mode: 0o600 });
		return async () => {
			await unlink(lockFile).catch(() => undefined);
		};
	} catch (error) {
		if (!isFileExistsError(error)) throw error;
	}

	const existingPid = await readExistingPid(lockFile);
	if (existingPid !== undefined && isProcessAlive(existingPid)) {
		throw new Error(`Clanky daemon already appears to be running with pid ${existingPid}`);
	}

	await unlink(lockFile).catch(() => undefined);
	try {
		await writeFile(lockFile, pidText, { flag: "wx", mode: 0o600 });
	} catch (error) {
		if (!isFileExistsError(error)) throw error;
		const competingPid = await readExistingPid(lockFile);
		if (competingPid !== undefined && isProcessAlive(competingPid)) {
			throw new Error(`Clanky daemon already appears to be running with pid ${competingPid}`);
		}
		throw new Error("Clanky daemon lock was claimed by another process");
	}
	return async () => {
		await unlink(lockFile).catch(() => undefined);
	};
}

async function readExistingPid(lockFile: string): Promise<number | undefined> {
	try {
		const content = await readFile(lockFile, "utf8");
		const pid = Number.parseInt(content.trim(), 10);
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
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
