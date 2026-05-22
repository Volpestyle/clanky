import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { RpcChatClient, sessionFileForId } from "./rpc-client.ts";

export interface RunChatOptions {
	socketFile: string;
	sessionId?: string;
	eventStreamUrl?: string;
}

export async function runChat(options: RunChatOptions): Promise<void> {
	const rpc = await RpcChatClient.connect(options.socketFile);
	if (options.sessionId !== undefined) {
		await rpc.switchSession(await sessionFileForId(options.socketFile, options.sessionId));
	}
	let sessionId = (await rpc.getState()).sessionId;
	const reader = createInterface({ input, output });
	output.write(`Clanky Chat (${sessionId})\n`);
	output.write("Type /exit to leave.\n\n");
	try {
		while (true) {
			const promptInput = await readPrompt(reader);
			if (promptInput === undefined) return;
			const prompt = promptInput.trim();
			if (prompt.length === 0) continue;
			if (prompt === "/exit" || prompt === "/quit" || prompt === ":q") return;
			let printedDelta = false;
			try {
				const text = await rpc.prompt(prompt, (delta) => {
					printedDelta = true;
					output.write(delta);
				});
				sessionId = (await rpc.getState()).sessionId;
				if (printedDelta) {
					output.write("\n\n");
				} else if (text.length > 0) {
					output.write(`${text}\n\n`);
				} else {
					output.write(`session: ${sessionId}\n\n`);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				output.write(`error: ${message}\n\n`);
			}
		}
	} finally {
		rpc.close();
		reader.close();
	}
}

async function readPrompt(reader: ReturnType<typeof createInterface>): Promise<string | undefined> {
	try {
		return await reader.question("clanky> ");
	} catch {
		return undefined;
	}
}
