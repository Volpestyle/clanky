import { hasLinearCredentials } from "../linear/client.ts";
import type { SessionRegistry } from "../session-registry.ts";
import type { CronJob, CronJobStore } from "./jobs.ts";

export interface CronDeliveryResult {
	deliveredTo: string;
	outputFile: string;
	linearOutboxId?: string;
}

export interface DeliverCronOutputOptions {
	registry: SessionRegistry;
	store: CronJobStore;
	job: CronJob;
	output: string;
	finishedAt: Date;
}

export async function deliverCronOutput(options: DeliverCronOutputOptions): Promise<CronDeliveryResult> {
	const outputFile = await options.store.writeOutput(options.job, options.output, options.finishedAt);
	if (options.job.deliver === "stdout") {
		console.log(options.output);
		return { deliveredTo: "stdout", outputFile };
	}
	if (options.job.deliver === "file") {
		return { deliveredTo: outputFile, outputFile };
	}
	if (options.job.deliver.startsWith("session:")) {
		const sessionId = options.job.deliver.slice("session:".length);
		if (!sessionId) throw new Error("Cron session delivery requires a session id");
		const registered = await options.registry.getOrOpen(sessionId);
		if (!registered.hasUsableModel) {
			throw new Error("Cron session delivery requires a configured Pi model");
		}
		await registered.session.prompt(`Cron job ${options.job.id} completed:\n\n${options.output}`);
		return { deliveredTo: options.job.deliver, outputFile };
	}
	if (options.job.deliver.startsWith("linear:")) {
		const issueId = options.job.deliver.slice("linear:".length);
		if (!issueId) throw new Error("Cron Linear delivery requires an issue id");
		const entry = await options.registry.addLinearOutboxEntry({
			issueId,
			kind: "cron_output",
			body: `Cron job ${options.job.id} completed:\n\n${options.output}`,
			outputFile,
			jobId: options.job.id,
			note: `scheduled at ${options.finishedAt.toISOString()}`,
		});
		if (hasLinearCredentials()) await options.registry.flushLinearOutbox({ entryIds: [entry.id] });
		return { deliveredTo: options.job.deliver, outputFile, linearOutboxId: entry.id };
	}
	throw new Error(`Unsupported cron delivery target: ${options.job.deliver}`);
}
