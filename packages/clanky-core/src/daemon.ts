import { SessionRegistry, type SessionRegistryOptions } from "./session-registry.ts";

export interface StartDaemonOptions extends SessionRegistryOptions {
	prompt?: string;
}

export interface StartDaemonResult {
	registry: SessionRegistry;
	sessionId: string;
	sessionFile: string | undefined;
	promptResult?: string;
}

export async function startDaemon(options: StartDaemonOptions = {}): Promise<StartDaemonResult> {
	const registry = new SessionRegistry(options);
	await registry.start();
	const registered = await registry.createSession(options.prompt ? {} : { noTools: "all" });
	let promptResult: string | undefined;

	if (options.prompt) {
		if (!registered.hasUsableModel) {
			throw new Error(
				"No configured Pi model is available. Run `pi /login` or set provider API keys before using --prompt.",
			);
		}
		const chunks: string[] = [];
		const unsubscribe = registered.session.subscribe((event) => {
			if (event.type !== "message_update") return;
			if (event.assistantMessageEvent.type !== "text_delta") return;
			chunks.push(event.assistantMessageEvent.delta);
		});
		try {
			await registered.session.prompt(options.prompt);
			await registry.refreshSessionFile(registered.id);
		} finally {
			unsubscribe();
		}
		promptResult = chunks.join("");
	}

	const result: StartDaemonResult = {
		registry,
		sessionId: registered.id,
		sessionFile: registered.sessionFile,
	};
	if (promptResult !== undefined) result.promptResult = promptResult;
	return result;
}
