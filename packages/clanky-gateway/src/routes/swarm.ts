import type { SessionRegistry } from "@clanky/core";
import type { SwarmLeader } from "@clanky/swarm";
import type { Hono } from "hono";
import {
	completeSwarm,
	dispatchSwarm,
	getSwarmFileLock,
	getSwarmSnapshot,
	getSwarmStatus,
	listSwarmPeers,
	listSwarmTasks,
	messageSwarm,
} from "../operations.ts";
import {
	readSwarmCompleteParams,
	readSwarmDispatchParams,
	readSwarmFileLockParams,
	readSwarmMessageParams,
} from "../protocol.ts";

export interface SwarmRouteOptions {
	registry: SessionRegistry;
	swarm: SwarmLeader;
}

export function registerSwarmRoutes(app: Hono, options: SwarmRouteOptions): void {
	app.get("/swarm/status", (context) => context.json(getSwarmStatus(options.swarm)));

	app.get("/swarm/peers", async (context) => context.json(await listSwarmPeers(options.swarm)));

	app.get("/swarm/tasks", async (context) => context.json(await listSwarmTasks(options.swarm)));

	app.get("/swarm/snapshot", async (context) => context.json(await getSwarmSnapshot(options.swarm)));

	app.get("/swarm/file-lock", async (context) => {
		try {
			const params = readSwarmFileLockParams({
				file: context.req.query("file") ?? context.req.query("path"),
			});
			return context.json(await getSwarmFileLock(options.swarm, params.file));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return context.json({ error: message }, 400);
		}
	});

	app.post("/swarm/dispatch", async (context) => {
		try {
			const body = await context.req.json().catch(() => undefined);
			const result = await dispatchSwarm(options.swarm, readSwarmDispatchParams(body), options.registry);
			if (result.ok) return context.json(result);
			return context.json(result, 409);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return context.json({ error: message }, 400);
		}
	});

	app.post("/swarm/message", async (context) => {
		try {
			const body = await context.req.json().catch(() => undefined);
			const result = await messageSwarm(options.swarm, readSwarmMessageParams(body));
			if (result.ok) return context.json(result);
			return context.json(result, 409);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return context.json({ error: message }, 400);
		}
	});

	app.post("/swarm/complete", async (context) => {
		try {
			const body = await context.req.json().catch(() => undefined);
			const result = await completeSwarm(options.swarm, readSwarmCompleteParams(body), options.registry);
			if (result.ok) return context.json(result);
			return context.json(result, 409);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return context.json({ error: message }, 400);
		}
	});
}
