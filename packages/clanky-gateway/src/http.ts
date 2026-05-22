import type { CronScheduler, SessionRegistry } from "@clanky/core";
import type { SwarmLeader } from "@clanky/swarm";
import type { ServerType } from "@hono/node-server";
import { serve, upgradeWebSocket } from "@hono/node-server";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import type { ExternalMcpManager } from "./external-mcp.ts";
import { isHttpAuthorized, isTokenAuthorized } from "./http-token.ts";
import {
	addSkill,
	addTask,
	callExternalMcpTool,
	createLinearIssue,
	exportMemory,
	flushLinearOutbox,
	forgetMemory,
	getMemoryStatus,
	getStatus,
	linkLinearIssue,
	listExternalMcpServers,
	listLinearLinks,
	listLinearOutbox,
	listSkills,
	listSkillUsage,
	listTasks,
	rememberMemory,
	removeSkill,
	searchMemory,
	setMemoryConsent,
	updateTask,
} from "./operations.ts";
import {
	readExternalMcpCallParams,
	readLinearCreateParams,
	readLinearFlushParams,
	readLinearLinkParams,
	readMemoryConsentParams,
	readMemoryForgetParams,
	readMemoryRememberParams,
	readMemorySearchParams,
	readSkillAddParams,
	readSkillRemoveParams,
	readTaskAddParams,
	readTaskListParams,
	readTaskUpdateParams,
} from "./protocol.ts";
import { registerCronRoutes } from "./routes/cron.ts";
import { registerSessionRoutes } from "./routes/sessions.ts";
import { registerSwarmRoutes } from "./routes/swarm.ts";
import type { GatewayEventHub } from "./ws.ts";

export interface HttpGatewayOptions {
	hostname: string;
	port: number;
	socketFile: string;
	startedAt: number;
	token: string;
}

export interface HttpGatewayServer {
	hostname: string;
	port: number;
	close(): Promise<void>;
}

export function startHttpGateway(
	registry: SessionRegistry,
	cron: CronScheduler,
	swarm: SwarmLeader,
	externalMcp: ExternalMcpManager,
	events: GatewayEventHub,
	options: HttpGatewayOptions,
): HttpGatewayServer {
	const app = new Hono();

	app.use("*", async (context, next) => {
		if (
			!isHttpAuthorized(context.req.raw.headers, options.token) &&
			!isTokenAuthorized(context.req.query("token"), options.token)
		) {
			return context.json({ error: "unauthorized" }, 401);
		}
		await next();
	});

	app.get("/status", async (context) =>
		context.json(await getStatus(registry, cron, swarm, externalMcp, options.socketFile, options.startedAt)),
	);

	app.get("/memory/status", async (context) => context.json(await getMemoryStatus(registry)));

	app.get("/memory", async (context) => {
		try {
			return context.json(
				await searchMemory(
					registry,
					readMemorySearchParams({
						query: context.req.query("query") ?? context.req.query("q"),
						scope: context.req.query("scope"),
						subjectId: context.req.query("subjectId") ?? context.req.query("subject_id"),
						limit: context.req.query("limit"),
					}),
				),
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return context.json({ error: message }, 400);
		}
	});

	app.post("/memory", async (context) => {
		try {
			const body = await context.req.json().catch(() => undefined);
			return context.json(await rememberMemory(registry, readMemoryRememberParams(body)));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return context.json({ error: message }, 400);
		}
	});

	app.delete("/memory/:id", async (context) => {
		try {
			return context.json(await forgetMemory(registry, readMemoryForgetParams({ id: context.req.param("id") })));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return context.json({ error: message }, 400);
		}
	});

	app.get("/memory/export", async (context) => context.json(await exportMemory(registry)));

	app.put("/memory/consent", async (context) => {
		try {
			const body = await context.req.json().catch(() => undefined);
			return context.json(await setMemoryConsent(registry, readMemoryConsentParams(body)));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return context.json({ error: message }, 400);
		}
	});

	registerSessionRoutes(app, { registry, events });

	app.get("/skills", (context) => context.json(listSkills(registry)));

	app.get("/skills/usage", async (context) => context.json(await listSkillUsage(registry)));

	app.post("/skills", async (context) => {
		try {
			const body = await context.req.json().catch(() => undefined);
			return context.json(await addSkill(registry, readSkillAddParams(body)));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return context.json({ error: message }, 400);
		}
	});

	app.delete("/skills/:name", async (context) => {
		try {
			return context.json(await removeSkill(registry, readSkillRemoveParams({ name: context.req.param("name") })));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return context.json({ error: message }, 400);
		}
	});

	app.get("/tasks", async (context) => {
		try {
			return context.json(
				await listTasks(
					registry,
					readTaskListParams({
						sessionId: context.req.query("sessionId") ?? context.req.query("session_id"),
						linearIssue: context.req.query("linearIssue") ?? context.req.query("linear_issue"),
						status: context.req.query("status"),
						priority: context.req.query("priority"),
						limit: context.req.query("limit"),
					}),
				),
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return context.json({ error: message }, 400);
		}
	});

	app.post("/tasks", async (context) => {
		try {
			const body = await context.req.json().catch(() => undefined);
			const paramsInput =
				typeof body === "object" && body !== null && !Array.isArray(body) ? { ...body, source: "http" } : body;
			return context.json(await addTask(registry, readTaskAddParams(paramsInput)));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return context.json({ error: message }, 400);
		}
	});

	app.patch("/tasks/:id", async (context) => {
		try {
			const body = await context.req.json().catch(() => undefined);
			const paramsInput =
				typeof body === "object" && body !== null && !Array.isArray(body)
					? { ...body, id: context.req.param("id") }
					: { id: context.req.param("id") };
			const result = await updateTask(registry, readTaskUpdateParams(paramsInput));
			if (result.updated) return context.json(result);
			return context.json(result, 404);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return context.json({ error: message }, 400);
		}
	});

	app.get("/mcp/servers", (context) => context.json(listExternalMcpServers(externalMcp)));

	app.post("/mcp/call", async (context) => {
		try {
			const body = await context.req.json().catch(() => undefined);
			return context.json(await callExternalMcpTool(externalMcp, readExternalMcpCallParams(body)));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return context.json({ error: message }, 400);
		}
	});

	app.get("/linear/links", async (context) => context.json(await listLinearLinks(registry)));

	app.get("/linear/outbox", async (context) => context.json(await listLinearOutbox(registry)));

	app.post("/linear/issues", async (context) => {
		try {
			const body = await context.req.json().catch(() => undefined);
			return context.json(await createLinearIssue(registry, readLinearCreateParams(body)));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return context.json({ error: message }, 400);
		}
	});

	app.post("/linear/outbox/flush", async (context) => {
		try {
			const body = await context.req.json().catch(() => undefined);
			return context.json(await flushLinearOutbox(registry, readLinearFlushParams(body)));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return context.json({ error: message }, 400);
		}
	});

	app.post("/linear/links", async (context) => {
		try {
			const body = await context.req.json().catch(() => undefined);
			return context.json(await linkLinearIssue(registry, readLinearLinkParams(body)));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return context.json({ error: message }, 400);
		}
	});

	registerSwarmRoutes(app, { registry, swarm });

	app.get(
		"/events",
		upgradeWebSocket((context) => {
			const sessionId = eventSessionId(context.req.query("sessionId") ?? context.req.query("session_id"));
			let unsubscribe = () => {};
			return {
				onOpen(_event, socket) {
					unsubscribe = events.subscribe(socket, sessionId === undefined ? {} : { sessionId });
				},
				onClose() {
					unsubscribe();
				},
				onError() {
					unsubscribe();
				},
			};
		}),
	);

	registerCronRoutes(app, { cron, events });

	const webSocketServer = new WebSocketServer({ noServer: true });
	const server = serve({
		fetch: app.fetch,
		hostname: options.hostname,
		port: options.port,
		websocket: { server: webSocketServer },
	});

	return {
		hostname: options.hostname,
		port: options.port,
		close: async () => {
			await closeWebSocketServer(webSocketServer);
			await closeHttpServer(server);
		},
	};
}

function eventSessionId(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
	for (const client of server.clients) client.close();
	await new Promise<void>((resolve, reject) => {
		server.close((error?: Error) => {
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		});
	});
}

async function closeHttpServer(server: ServerType): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.close((error?: Error) => {
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		});
	});
}
