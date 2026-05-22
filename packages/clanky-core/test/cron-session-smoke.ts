import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronJobStore, CronScheduler, formatSkillPrompt, SessionRegistry } from "@clanky/core";
import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { parseSkillBlock } from "@earendil-works/pi-coding-agent";

const provider = "clanky-cron-session-faux";
const model = "clanky-cron-session-faux-model";
const api = "clanky-cron-session-faux-api";
const cronOutput = "Cron output for session delivery.";
const deliveryAcknowledgement = "Session delivery acknowledged.";
const noSkillCronOutput = "Cron output without skill activation.";
const homeDir = await mkdtemp(join(tmpdir(), "clanky-cron-session-"));
const fauxState = {
	callCount: 0,
	responses: [cronOutput, deliveryAcknowledgement, noSkillCronOutput],
};

const registry = new SessionRegistry({
	homeDir,
	configureModelRegistry: (modelRegistry) => {
		modelRegistry.registerProvider(provider, {
			api,
			baseUrl: "http://localhost:0",
			apiKey: "test-key",
			streamSimple: (streamModel) => createFauxStream(streamModel, fauxState),
			models: [
				{
					id: model,
					name: "Clanky Cron Session Faux Model",
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
const store = new CronJobStore(registry.paths);
const scheduler = new CronScheduler({ registry, store });

try {
	await registry.start();
	const skill = await registry.createSkill({
		name: "cron-session-skill",
		description: "Used by the cron session delivery smoke.",
		body: "Include this cron-session-skill marker when expanding the skill.",
	});
	const cronPrompt = "Create output for a session delivery smoke.";
	const formattedCronPrompt = formatSkillPrompt({ skill: skill.name, prompt: cronPrompt });
	const expectedSkillPrefix = `/skill:${skill.name} \n\n`;
	if (formattedCronPrompt !== `${expectedSkillPrefix}${cronPrompt}`) {
		throw new Error(`Cron skill prompt did not use Pi's space-delimited colon form: ${formattedCronPrompt}`);
	}
	if (formattedCronPrompt.startsWith(`/skill:${skill.name}\n\n`)) {
		throw new Error("Cron skill prompt regressed to the bare-newline form that Pi parses as part of the skill name");
	}
	if (parseSkillBlock(formattedCronPrompt) !== null) {
		throw new Error("Pi parseSkillBlock should parse expanded skill blocks, not raw /skill:<name> commands");
	}
	const target = await registry.createSession({ provider, model });
	if (!target.hasUsableModel) throw new Error("Target session did not get the configured faux model");

	const job = await store.add(
		{
			schedule: "2026-01-01T00:00:01.000Z",
			prompt: cronPrompt,
			deliver: `session:${target.id}`,
			skill: skill.name,
			provider,
			model,
		},
		new Date("2026-01-01T00:00:00.000Z"),
	);
	const tick = await scheduler.tick(new Date("2026-01-01T00:00:02.000Z"));
	const run = tick.ran[0];
	if (tick.skipped || tick.ran.length !== 1 || run === undefined || !run.ok) {
		throw new Error(`Expected one cron session delivery job to run: ${JSON.stringify(tick)}`);
	}
	if (run.deliveredTo !== `session:${target.id}` || run.text !== cronOutput || run.outputFile === undefined) {
		throw new Error(`Cron session delivery returned unexpected result: ${JSON.stringify(run)}`);
	}
	if ((await readFile(run.outputFile, "utf8")) !== cronOutput) {
		throw new Error("Cron session delivery output file did not contain the cron model response");
	}
	if (run.sessionFile === undefined) throw new Error("Cron session delivery did not persist the cron run session file");
	const cronJsonl = await readFile(run.sessionFile, "utf8");
	const cronMessages = messageTexts(cronJsonl);
	const cronText = cronMessages.join("\n");
	if (
		!cronText.includes('<skill name="cron-session-skill"') ||
		!cronText.includes("cron-session-skill marker") ||
		!cronText.includes("</skill>\n\nCreate output for a session delivery smoke.")
	) {
		throw new Error("Cron run session JSONL did not contain the expanded cron skill block");
	}
	const expandedSkillText = cronMessages.find((text) => text.includes('<skill name="cron-session-skill"'));
	const parsedSkillBlock = expandedSkillText === undefined ? null : parseSkillBlock(expandedSkillText);
	if (
		parsedSkillBlock === null ||
		parsedSkillBlock.name !== skill.name ||
		parsedSkillBlock.userMessage !== cronPrompt
	) {
		throw new Error(`Pi parseSkillBlock did not parse the expanded cron skill block: ${expandedSkillText}`);
	}
	if (fauxState.callCount !== 2) {
		throw new Error(`Expected cron prompt and session delivery prompt, got ${fauxState.callCount} model calls`);
	}
	const liveSessionIds = registry.list().map((session) => session.id);
	if (run.sessionId === undefined || liveSessionIds.includes(run.sessionId)) {
		throw new Error(`Cron run session should be transient, live sessions: ${JSON.stringify(liveSessionIds)}`);
	}
	if (!liveSessionIds.includes(target.id)) {
		throw new Error(`Session delivery target should remain live, live sessions: ${JSON.stringify(liveSessionIds)}`);
	}
	const usage = await registry.listSkillUsage();
	const skillUsage = usage.find((entry) => entry.name === skill.name);
	if (skillUsage === undefined || skillUsage.source !== "cron" || skillUsage.jobId !== job.id) {
		throw new Error(`Cron job did not record skill usage metadata: ${JSON.stringify(usage)}`);
	}

	const targetSessionFile = await registry.refreshSessionFile(target.id);
	if (targetSessionFile === undefined) throw new Error("Session delivery did not persist the target session file");
	const targetJsonl = await readFile(targetSessionFile, "utf8");
	if (
		!targetJsonl.includes(`Cron job ${job.id} completed`) ||
		!targetJsonl.includes(cronOutput) ||
		!targetJsonl.includes(deliveryAcknowledgement)
	) {
		throw new Error("Target session JSONL did not contain the delivered cron output and acknowledgement");
	}

	const [updatedJob] = await store.list();
	if (updatedJob?.id !== job.id || updatedJob.enabled || updatedJob.lastStatus !== "ok") {
		throw new Error("Cron session delivery one-shot job was not advanced cleanly after successful run");
	}

	const noSkillPrompt = "Create output without activating a skill.";
	const formattedNoSkillPrompt = formatSkillPrompt({ prompt: noSkillPrompt });
	if (formattedNoSkillPrompt !== noSkillPrompt) {
		throw new Error(`Cron prompt without explicit skill should remain unchanged: ${formattedNoSkillPrompt}`);
	}
	if (parseSkillBlock(formattedNoSkillPrompt) !== null) {
		throw new Error("Pi parseSkillBlock should not parse a cron prompt without explicit skill activation");
	}
	const noSkillJob = await store.add(
		{
			schedule: "2026-01-01T00:00:03.000Z",
			prompt: noSkillPrompt,
			provider,
			model,
		},
		new Date("2026-01-01T00:00:02.000Z"),
	);
	const noSkillTick = await scheduler.tick(new Date("2026-01-01T00:00:04.000Z"));
	const noSkillRun = noSkillTick.ran[0];
	if (noSkillTick.skipped || noSkillTick.ran.length !== 1 || noSkillRun === undefined || !noSkillRun.ok) {
		throw new Error(`Expected one no-skill cron job to run: ${JSON.stringify(noSkillTick)}`);
	}
	if (noSkillRun.text !== noSkillCronOutput || noSkillRun.sessionFile === undefined) {
		throw new Error(`No-skill cron run returned unexpected result: ${JSON.stringify(noSkillRun)}`);
	}
	const noSkillJsonl = await readFile(noSkillRun.sessionFile, "utf8");
	const noSkillText = messageTexts(noSkillJsonl).join("\n");
	if (!noSkillText.includes(noSkillPrompt)) {
		throw new Error("No-skill cron run session JSONL did not contain the raw prompt");
	}
	if (noSkillText.includes("<skill ") || noSkillText.includes("cron-session-skill marker")) {
		throw new Error("No-skill cron run unexpectedly injected a skill block");
	}
	const usageAfterNoSkill = await registry.listSkillUsage();
	if (usageAfterNoSkill.length !== usage.length) {
		throw new Error(`No-skill cron job should not record skill usage: ${JSON.stringify(usageAfterNoSkill)}`);
	}
	const updatedNoSkillJob = (await store.list()).find((candidate) => candidate.id === noSkillJob.id);
	if (updatedNoSkillJob?.id !== noSkillJob.id || updatedNoSkillJob.enabled || updatedNoSkillJob.lastStatus !== "ok") {
		throw new Error("No-skill one-shot cron job was not advanced cleanly after successful run");
	}
	if (Number(fauxState.callCount) !== 3) {
		throw new Error(`Expected cron, delivery, and no-skill cron prompts, got ${fauxState.callCount} model calls`);
	}

	console.log(
		JSON.stringify({
			jobId: job.id,
			noSkillJobId: noSkillJob.id,
			targetSessionId: target.id,
			skill: skill.name,
			callCount: fauxState.callCount,
			targetBytes: targetJsonl.length,
		}),
	);
} finally {
	await registry.dispose();
	await rm(homeDir, { force: true, recursive: true });
}

function createFauxStream(streamModel: Model<Api>, state: { callCount: number; responses: string[] }) {
	const text = state.responses[state.callCount] ?? "Unexpected extra faux response.";
	state.callCount += 1;
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

function messageTexts(jsonl: string): string[] {
	const chunks: string[] = [];
	for (const line of jsonl.split("\n")) {
		if (line.trim().length === 0) continue;
		const parsed = JSON.parse(line) as unknown;
		const message = property(parsed, "message");
		const content = property(message, "content");
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			const text = property(block, "text");
			if (typeof text === "string") chunks.push(text);
		}
	}
	return chunks;
}

function property(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return (value as Record<string, unknown>)[key];
}
