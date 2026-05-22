import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveClankyPaths } from "@clanky/core";
import { requestGateway, type SessionListResult, startGatewayServer } from "@clanky/gateway";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";

const provider = "clanky-faux";
const model = "clanky-faux-calendar";
const noAuthProvider = "openai";
const noAuthModel = "clanky-noauth-openai";
const expected = "Faux calendar: no events found for this smoke test.";
const homeDir = await mkdtemp(join(tmpdir(), "clanky-send-"));
const paths = resolveClankyPaths({ homeDir });
const faux = registerFauxProvider({
	api: "clanky-faux-api",
	provider,
	models: [{ id: model, name: "Clanky Faux Calendar", input: ["text"] }],
	tokenSize: { min: 32, max: 32 },
});
faux.setResponses([fauxAssistantMessage(expected)]);

await mkdir(dirname(paths.modelsFile), { recursive: true, mode: 0o700 });
await writeFile(
	paths.modelsFile,
	JSON.stringify(
		{
			providers: {
				[provider]: {
					api: faux.api,
					baseUrl: "http://localhost:0",
					apiKey: "test-key",
					models: [
						{
							id: model,
							name: "Clanky Faux Calendar",
							input: ["text"],
							reasoning: false,
						},
					],
				},
				[noAuthProvider]: {
					baseUrl: "http://localhost:0",
					models: [
						{
							id: noAuthModel,
							name: "Clanky OpenAI Without Auth",
							input: ["text"],
							reasoning: false,
						},
					],
				},
			},
		},
		null,
		"\t",
	),
	{ mode: 0o600 },
);

const server = await startGatewayServer({ homeDir });

try {
	const skill = await server.registry.createSkill({
		name: "send-smoke-skill",
		description: "Used by the send smoke.",
		body: "Include this send-smoke-skill marker when expanding the skill.",
	});
	const result = await runClanky([
		"send",
		"--home",
		homeDir,
		"--skill",
		skill.name,
		"--provider",
		provider,
		"--model",
		model,
		"what's on the calendar",
	]);
	if (result.code !== 0) {
		throw new Error(`clanky send failed with ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
	}
	if (!result.stdout.includes(expected)) {
		throw new Error(`clanky send did not print the faux response\nstdout:\n${result.stdout}`);
	}

	const sessions = (await requestGateway({
		socketFile: server.socketFile,
		method: "session.list",
	})) as SessionListResult;
	const [session] = sessions.sessions;
	if (session === undefined || session.sessionFile === undefined) {
		throw new Error("Model-backed send did not persist a resumable session file");
	}
	const sessionJsonl = await readFile(session.sessionFile, "utf8");
	if (!sessionJsonl.includes("what's on the calendar") || !sessionJsonl.includes(expected)) {
		throw new Error("Model-backed send session file did not contain the prompt and response");
	}
	const sessionText = messageText(sessionJsonl);
	if (
		!sessionText.includes('<skill name="send-smoke-skill"') ||
		!sessionText.includes("send-smoke-skill marker") ||
		!sessionText.includes("</skill>\n\nwhat's on the calendar")
	) {
		throw new Error("Model-backed send did not expand the requested skill");
	}
	const usage = await server.registry.listSkillUsage();
	const skillUsage = usage.find((entry) => entry.name === skill.name);
	if (skillUsage === undefined || skillUsage.source !== "session" || skillUsage.sessionId !== session.id) {
		throw new Error(`Model-backed send did not record skill usage metadata: ${JSON.stringify(usage)}`);
	}

	const previousOpenAiKey = process.env.OPENAI_API_KEY;
	delete process.env.OPENAI_API_KEY;
	let noAuthResult: CommandResult;
	try {
		noAuthResult = await runClanky([
			"send",
			"--home",
			homeDir,
			"--provider",
			noAuthProvider,
			"--model",
			noAuthModel,
			"this should fail before calling the model",
		]);
	} finally {
		if (previousOpenAiKey === undefined) {
			delete process.env.OPENAI_API_KEY;
		} else {
			process.env.OPENAI_API_KEY = previousOpenAiKey;
		}
	}
	if (noAuthResult.code === 0) {
		throw new Error(`clanky send without model auth unexpectedly succeeded\nstdout:\n${noAuthResult.stdout}`);
	}
	if (!noAuthResult.stderr.includes("No configured Pi model is available")) {
		throw new Error(`clanky send without model auth returned unexpected stderr:\n${noAuthResult.stderr}`);
	}
	if (faux.state.callCount !== 1) {
		throw new Error(`Missing-auth send should not call the faux model, got ${faux.state.callCount} calls`);
	}

	console.log(
		JSON.stringify({
			sessionId: session.id,
			skill: skill.name,
			sessionBytes: sessionJsonl.length,
			callCount: faux.state.callCount,
		}),
	);
} finally {
	faux.unregister();
	await server.close();
	await rm(homeDir, { force: true, recursive: true });
}

interface CommandResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

async function runClanky(args: string[]): Promise<CommandResult> {
	const child = spawn(process.execPath, ["--import", "tsx", "packages/clanky-cli/src/bin.ts", ...args], {
		cwd: process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString("utf8");
	});
	const timeout = setTimeout(() => {
		child.kill("SIGTERM");
	}, 15_000);
	const code = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	clearTimeout(timeout);
	return { code, stdout, stderr };
}

function messageText(jsonl: string): string {
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
	return chunks.join("\n");
}

function property(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return (value as Record<string, unknown>)[key];
}
