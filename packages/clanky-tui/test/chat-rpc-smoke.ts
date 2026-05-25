import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGatewayServer } from "@clanky/gateway";

const homeDir = await mkdtemp(join(tmpdir(), "clanky-tui-chat-"));
const server = await startGatewayServer({ homeDir });

try {
	const result = await runChatAndExit(server.socketFile);
	if (result.code !== 0) {
		throw new Error(`runChat exited with ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
	}
	if (!result.stdout.includes("Clanky Chat (")) throw new Error("TUI did not print chat header");
	if (!result.stdout.includes("clanky> ")) throw new Error("TUI did not show chat prompt");

	const seeded = await server.registry.createSession({ noTools: "all" });
	seeded.session.sessionManager.appendMessage({
		role: "user",
		content: "Seeded chat session",
		timestamp: Date.now(),
	});
	seeded.session.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Seeded chat answer" }],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
	const sessionFile = await server.registry.refreshSessionFile(seeded.id);
	if (sessionFile === undefined) throw new Error("Seeded chat session did not persist");

	const sessionResult = await runChatAndExit(server.socketFile, seeded.id);
	if (sessionResult.code !== 0) {
		throw new Error(
			`runChat --session exited with ${sessionResult.code}\nstdout:\n${sessionResult.stdout}\nstderr:\n${sessionResult.stderr}`,
		);
	}
	if (!sessionResult.stdout.includes(`Clanky Chat (${seeded.id})`)) {
		throw new Error(`TUI did not switch to the requested session\nstdout:\n${sessionResult.stdout}`);
	}
	if (!sessionResult.stdout.includes("Seeded chat session") || !sessionResult.stdout.includes("Seeded chat answer")) {
		throw new Error(`TUI did not render resumed session history\nstdout:\n${sessionResult.stdout}`);
	}

	console.log(
		JSON.stringify({
			attached: true,
			sessionAttached: true,
			stdoutBytes: result.stdout.length + sessionResult.stdout.length,
		}),
	);
} finally {
	await server.close();
	await rm(homeDir, { force: true, recursive: true });
}

interface ChildRunResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

async function runChatAndExit(socketFile: string, sessionId?: string): Promise<ChildRunResult> {
	const args = ["--silent", "tsx", "packages/clanky-tui/test/run-chat-child.ts", socketFile];
	if (sessionId !== undefined) args.push(sessionId);
	const child = spawn("pnpm", args, {
		cwd: process.cwd(),
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	let sentExit = false;

	const timeout = setTimeout(() => {
		child.kill("SIGTERM");
	}, 5000);

	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString("utf8");
		if (!sentExit && stdout.includes("clanky> ")) {
			sentExit = true;
			child.stdin.write("/exit\n");
		}
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString("utf8");
	});

	const code = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	clearTimeout(timeout);
	return { code, stdout, stderr };
}
