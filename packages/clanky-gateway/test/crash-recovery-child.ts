import { writeFile } from "node:fs/promises";
import { startGatewayServer } from "@clanky/gateway";
import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";

const homeDir = requiredEnv("CLANKY_CRASH_HOME");
const markerFile = requiredEnv("CLANKY_CRASH_MARKER");
const provider = requiredEnv("CLANKY_CRASH_PROVIDER");
const model = requiredEnv("CLANKY_CRASH_MODEL");
const api = "clanky-crash-faux-api";

const server = await startGatewayServer({
	homeDir,
	configureModelRegistry: (modelRegistry) => {
		modelRegistry.registerProvider(provider, {
			api,
			baseUrl: "http://localhost:0",
			apiKey: "test-key",
			streamSimple: (streamModel) => createSlowFauxStream(streamModel, markerFile),
			models: [
				{
					id: model,
					name: "Clanky Crash Faux",
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

console.log(JSON.stringify({ socketFile: server.socketFile }));

process.once("SIGTERM", () => {
	void server.close().then(() => process.exit(0));
});
process.once("SIGINT", () => {
	void server.close().then(() => process.exit(0));
});

await new Promise(() => undefined);

function createSlowFauxStream(streamModel: Model<Api>, marker: string) {
	const message = createAssistantMessage(streamModel, "This response should be interrupted by SIGKILL.");
	const stream = createAssistantMessageEventStream();
	queueMicrotask(async () => {
		stream.push({ type: "start", partial: message });
		stream.push({ type: "text_start", contentIndex: 0, partial: message });
		await writeFile(marker, `${process.pid}\n`, { mode: 0o600 });
		await sleep(30_000);
		stream.push({
			type: "text_delta",
			contentIndex: 0,
			delta: "This response should be interrupted by SIGKILL.",
			partial: message,
		});
		stream.push({
			type: "text_end",
			contentIndex: 0,
			content: "This response should be interrupted by SIGKILL.",
			partial: message,
		});
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (value === undefined || value.length === 0) throw new Error(`Missing ${name}`);
	return value;
}
