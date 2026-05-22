import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveClankyPaths } from "@clanky/core";
import {
	requestGateway,
	type SendResult,
	type SessionListResult,
	type SessionSearchGatewayResult,
	startGatewayServer,
} from "@clanky/gateway";
import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";

const homeDir = await mkdtemp(join(tmpdir(), "clanky-crash-recovery-"));
const paths = resolveClankyPaths({ homeDir });
const markerFile = join(homeDir, "in-flight.marker");
const provider = "clanky-crash-faux";
const model = "clanky-crash-faux-model";
const recoveryText = "Recovered cleanly after daemon crash.";

const child = spawnCrashDaemon({ homeDir, markerFile, provider, model });
const stderrChunks: string[] = [];
child.stderr?.on("data", (chunk) => {
	stderrChunks.push(String(chunk));
});

try {
	await waitForSocket(paths.socketFile);
	const sendAttempt = requestGateway({
		socketFile: paths.socketFile,
		method: "send",
		params: {
			prompt: "crash recovery prompt",
			provider,
			model,
		},
		timeoutMs: 1_000,
	}).then(
		() => {
			throw new Error("In-flight send unexpectedly completed before crash");
		},
		(error: unknown) => error,
	);
	await waitForFile(markerFile);
	child.kill("SIGKILL");
	await waitForClose(child);
	const sendError = await sendAttempt;
	if (!(sendError instanceof Error)) {
		throw new Error(`Expected send to fail after SIGKILL, got ${String(sendError)}`);
	}
	await rm(paths.indexDbFile, { force: true });
	await rm(`${paths.indexDbFile}-wal`, { force: true });
	await rm(`${paths.indexDbFile}-shm`, { force: true });

	const restarted = await startGatewayServer({
		homeDir,
		configureModelRegistry: (modelRegistry) => {
			modelRegistry.registerProvider(provider, {
				api: "clanky-crash-recovery-api",
				baseUrl: "http://localhost:0",
				apiKey: "test-key",
				streamSimple: (streamModel) => createFauxStream(streamModel, recoveryText),
				models: [
					{
						id: model,
						name: "Clanky Crash Recovery Faux",
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
	try {
		const sessions = (await requestGateway({
			socketFile: restarted.socketFile,
			method: "session.list",
		})) as SessionListResult;
		const [session] = sessions.sessions;
		if (session === undefined || session.sessionFile === undefined) {
			throw new Error(`Restarted daemon did not recover the interrupted session: ${JSON.stringify(sessions)}`);
		}
		const interruptedJsonl = await readFile(session.sessionFile, "utf8");
		parseSessionEntries(interruptedJsonl);
		if (!interruptedJsonl.includes("crash recovery prompt")) {
			throw new Error("Interrupted session JSONL did not retain the user prompt");
		}

		const resumed = (await requestGateway({
			socketFile: restarted.socketFile,
			method: "send",
			params: {
				sessionId: session.id,
				prompt: "resume after crash",
				provider,
				model,
			},
			timeoutMs: 60_000,
		})) as SendResult;
		if (resumed.text !== recoveryText) {
			throw new Error(`Restarted daemon did not resume the recovered session: ${JSON.stringify(resumed)}`);
		}
		const resumedJsonl = await readFile(session.sessionFile, "utf8");
		parseSessionEntries(resumedJsonl);
		if (!resumedJsonl.includes("resume after crash") || !resumedJsonl.includes(recoveryText)) {
			throw new Error("Resumed session JSONL did not contain the follow-up prompt and response");
		}
		const search = (await requestGateway({
			socketFile: restarted.socketFile,
			method: "session.search",
			params: { query: "resume crash", limit: 5 },
		})) as SessionSearchGatewayResult;
		if (!search.results.some((result) => result.sessionId === session.id)) {
			throw new Error(`Restarted daemon could not index/search resumed JSONL: ${JSON.stringify(search)}`);
		}
		const rebuiltIndexStat = await stat(paths.indexDbFile).catch(() => undefined);
		if (rebuiltIndexStat === undefined || !rebuiltIndexStat.isFile()) {
			throw new Error("Restarted daemon did not rebuild the SQLite index from recovered JSONL");
		}

		console.log(
			JSON.stringify({
				sessionId: session.id,
				interruptedBytes: interruptedJsonl.length,
				resumedBytes: resumedJsonl.length,
				searchResults: search.results.length,
				rebuiltIndexBytes: rebuiltIndexStat.size,
			}),
		);
	} finally {
		await restarted.close();
	}
} catch (error) {
	if (stderrChunks.length > 0) console.error(stderrChunks.join(""));
	throw error;
} finally {
	if (child.exitCode === null && child.signalCode === null) {
		child.kill("SIGKILL");
		await waitForClose(child).catch(() => undefined);
	}
	await rm(homeDir, { force: true, recursive: true });
}

function spawnCrashDaemon(options: {
	homeDir: string;
	markerFile: string;
	provider: string;
	model: string;
}): ChildProcess {
	return spawn(process.execPath, ["--import", "tsx", "packages/clanky-gateway/test/crash-recovery-child.ts"], {
		cwd: process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			CLANKY_CRASH_HOME: options.homeDir,
			CLANKY_CRASH_MARKER: options.markerFile,
			CLANKY_CRASH_PROVIDER: options.provider,
			CLANKY_CRASH_MODEL: options.model,
		},
	});
}

async function waitForSocket(socketFile: string): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (await canConnect(socketFile)) return;
		await sleep(50);
	}
	throw new Error(`Timed out waiting for daemon socket ${socketFile}`);
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

async function waitForFile(file: string): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (
			await stat(file).then(
				() => true,
				() => false,
			)
		)
			return;
		await sleep(50);
	}
	throw new Error(`Timed out waiting for ${file}`);
}

async function waitForClose(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolve) => child.once("close", () => resolve()));
}

function createFauxStream(streamModel: Model<Api>, text: string) {
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
