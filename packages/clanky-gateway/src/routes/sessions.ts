import type { SessionRegistry } from "@clanky/core";
import type { Hono } from "hono";
import { forkSession, listSessions, searchSessions, sendPrompt } from "../operations.ts";
import { readSendParams, readSessionForkParams, readSessionSearchParams } from "../protocol.ts";
import type { GatewayEventHub } from "../ws.ts";

export interface SessionRouteOptions {
	registry: SessionRegistry;
	events: GatewayEventHub;
}

export function registerSessionRoutes(app: Hono, options: SessionRouteOptions): void {
	app.get("/sessions", async (context) => context.json(await listSessions(options.registry)));

	app.get("/sessions/search", async (context) => {
		try {
			return context.json(
				await searchSessions(
					options.registry,
					readSessionSearchParams({
						query: context.req.query("q") ?? context.req.query("query"),
						limit: context.req.query("limit"),
					}),
				),
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return context.json({ error: message }, 400);
		}
	});

	app.post("/sessions/:id/fork", async (context) => {
		try {
			const id = context.req.param("id");
			const body = await context.req.json().catch(() => undefined);
			const paramsInput =
				typeof body === "object" && body !== null ? { ...body, sourceSessionId: id } : { sourceSessionId: id };
			return context.json(await forkSession(options.registry, readSessionForkParams(paramsInput)));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return context.json({ error: message }, 400);
		}
	});

	app.post("/sessions/:id/messages", async (context) => {
		const id = context.req.param("id");
		try {
			const body = await context.req.json().catch(() => undefined);
			const paramsInput: Record<string, unknown> =
				typeof body === "object" && body !== null && !Array.isArray(body) ? { ...body } : {};
			if (id !== "new") paramsInput.sessionId = id;
			const result = await sendPrompt(options.registry, readSendParams(paramsInput), options.events);
			return context.json(result);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return context.json({ error: message }, 400);
		}
	});
}
