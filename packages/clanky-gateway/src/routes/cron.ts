import type { CronScheduler } from "@clanky/core";
import type { Hono } from "hono";
import {
	addCronJob,
	disableCronJob,
	enableCronJob,
	listCronJobs,
	removeCronJob,
	runCronJobNow,
} from "../operations.ts";
import { readCronAddParams } from "../protocol.ts";
import type { GatewayEventHub } from "../ws.ts";

export interface CronRouteOptions {
	cron: CronScheduler;
	events: GatewayEventHub;
}

export function registerCronRoutes(app: Hono, options: CronRouteOptions): void {
	app.get("/cron/jobs", async (context) => context.json(await listCronJobs(options.cron)));

	app.post("/cron/jobs", async (context) => {
		try {
			const body = await context.req.json().catch(() => undefined);
			return context.json(await addCronJob(options.cron, readCronAddParams(body), options.events));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return context.json({ error: message }, 400);
		}
	});

	app.delete("/cron/jobs/:id", async (context) => {
		try {
			return context.json(await removeCronJob(options.cron, { jobId: context.req.param("id") }, options.events));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return context.json({ error: message }, 400);
		}
	});

	app.post("/cron/jobs/:id/enable", async (context) => {
		try {
			return context.json(await enableCronJob(options.cron, { jobId: context.req.param("id") }, options.events));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return context.json({ error: message }, 400);
		}
	});

	app.post("/cron/jobs/:id/disable", async (context) => {
		try {
			return context.json(await disableCronJob(options.cron, { jobId: context.req.param("id") }, options.events));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return context.json({ error: message }, 400);
		}
	});

	app.post("/cron/jobs/:id/run", async (context) => {
		try {
			return context.json(await runCronJobNow(options.cron, { jobId: context.req.param("id") }, options.events));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return context.json({ error: message }, 400);
		}
	});
}
