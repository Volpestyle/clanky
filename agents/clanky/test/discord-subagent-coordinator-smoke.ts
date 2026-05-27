import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ClankySubagentStore, resolveClankyPaths } from "@clanky/core";
import type {
	AgentSessionEvent,
	AgentSessionRuntime,
	CreateAgentSessionRuntimeFactory,
	CreateAgentSessionRuntimeResult,
} from "@earendil-works/pi-coding-agent";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import type { DiscordInboundConversation, DiscordInboundMessage } from "../src/agentDiscordGateway.ts";
import { DiscordSubagentCoordinator } from "../src/discordSubagentCoordinator.ts";

interface SentDiscordMessage {
	conversation: DiscordInboundConversation;
	replyToExternalMessageId: string;
	text: string;
	externalMessageId: string;
}

const tmpRoot = await mkdtemp(join(tmpdir(), "clanky-discord-subagent-coordinator-"));
const paths = resolveClankyPaths({ homeDir: join(tmpRoot, "home") });
const store = new ClankySubagentStore(paths);
let coordinator: DiscordSubagentCoordinator | undefined;

try {
	const sentMessages: SentDiscordMessage[] = [];
	const typingConversationIds: string[] = [];
	const prompts: string[] = [];
	const replies = ["first reply", "second reply", "[SKIP]"];
	let runtimeCreateCount = 0;
	let disposedSessionCount = 0;
	const openedSessionFiles: (string | undefined)[] = [];
	const cwd = join(tmpRoot, "work");
	const agentDir = join(tmpRoot, "agent");
	const bridgeLogPath = join(tmpRoot, "bridge.log");
	const resumedSessionFile = join(paths.subagentSessionsDir, "resumed-discord-guild.jsonl");
	await mkdir(cwd, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await mkdir(paths.subagentSessionsDir, { recursive: true });
	await writeFile(
		resumedSessionFile,
		`${JSON.stringify({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "resumed-discord-guild",
			timestamp: new Date(0).toISOString(),
			cwd,
		})}\n`,
	);
	await store.upsertSubagent({
		id: "discord-guild:guild-1",
		kind: "discord-guild",
		scopeId: "guild-1",
		scopeName: "guild-1",
		state: "idle",
		sessionFile: resumedSessionFile,
	});
	const provider = {
		async sendMessage(input: {
			conversation: DiscordInboundConversation;
			replyToExternalMessageId: string;
			text: string;
		}): Promise<{ externalMessageId: string }> {
			const externalMessageId = `reply-${sentMessages.length + 1}`;
			sentMessages.push({ ...input, externalMessageId });
			return { externalMessageId };
		},
		async sendTyping(input: { conversation: DiscordInboundConversation }): Promise<void> {
			typingConversationIds.push(input.conversation.threadId ?? input.conversation.id);
		},
	};
	const createRuntime: CreateAgentSessionRuntimeFactory = async (options): Promise<CreateAgentSessionRuntimeResult> => {
		runtimeCreateCount += 1;
		openedSessionFiles.push(options.sessionManager.getSessionFile());
		const listeners = new Set<(event: AgentSessionEvent) => void>();
		const fakeSession = {
			isStreaming: false,
			sessionId: options.sessionManager.getSessionId(),
			sessionFile: options.sessionManager.getSessionFile(),
			sessionManager: options.sessionManager,
			extensionRunner: {
				hasHandlers: () => false,
				emit: async () => undefined,
			},
			subscribe(listener: (event: AgentSessionEvent) => void): () => void {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			async prompt(promptText: string): Promise<void> {
				prompts.push(promptText);
				const text = replies.shift() ?? "fallback reply";
				const event = {
					type: "message_end",
					message: {
						role: "assistant",
						stopReason: "end_turn",
						content: [{ type: "text", text }],
					},
				} as unknown as AgentSessionEvent;
				for (const listener of listeners) listener(event);
			},
			dispose(): void {
				disposedSessionCount += 1;
			},
		};
		return {
			session: fakeSession as unknown as CreateAgentSessionRuntimeResult["session"],
			extensionsResult: {
				extensions: [],
				errors: [],
				runtime: {},
			} as unknown as CreateAgentSessionRuntimeResult["extensionsResult"],
			services: {
				cwd: options.cwd,
				agentDir: options.agentDir,
			} as unknown as CreateAgentSessionRuntimeResult["services"],
			diagnostics: [],
		};
	};
	const mainRuntime = {
		cwd,
		session: {
			isStreaming: false,
			sessionId: "main-session",
			sessionFile: undefined,
			sessionManager: { getLeafEntry: () => undefined },
		},
	} as unknown as AgentSessionRuntime;

	coordinator = new DiscordSubagentCoordinator({
		provider,
		store,
		mainRuntime,
		createRuntime,
		agentDir,
		cwd,
		sessionDir: paths.subagentSessionsDir,
		bridgeLogPath,
	});

	let injectedWakeup = false;
	const originalSetSubagentState = store.setSubagentState.bind(store);
	store.setSubagentState = async (...args: Parameters<ClankySubagentStore["setSubagentState"]>): Promise<void> => {
		if (args[1] === "idle" && !injectedWakeup) {
			injectedWakeup = true;
			await coordinator?.enqueue(makeMessage("message-2", "second message"), "platform_mention");
		}
		return originalSetSubagentState(...args);
	};

	await coordinator.start();
	await coordinator.enqueue(makeMessage("message-1", "first message"), "platform_mention");
	await waitFor(() => sentMessages.length === 2, "coordinator to process wakeup message");

	if (runtimeCreateCount !== 1) {
		throw new Error(`coordinator smoke: expected one runtime, created ${runtimeCreateCount}`);
	}
	if (openedSessionFiles[0] !== resumedSessionFile) {
		throw new Error(`coordinator smoke: did not resume stored session file ${JSON.stringify(openedSessionFiles)}`);
	}
	const second = sentMessages[1];
	if (
		second?.conversation.kind !== "thread" ||
		second.conversation.id !== "channel-1" ||
		second.conversation.threadId !== "thread-1" ||
		second.conversation.parentId !== "channel-1"
	) {
		throw new Error(`coordinator smoke: thread conversation was not restored ${JSON.stringify(second)}`);
	}

	await coordinator.enqueue(makeMessage("message-3", "skip me"), "platform_mention");
	await waitFor(() => prompts.length === 3, "coordinator to process skip message");
	if (sentMessages.length !== 2) {
		throw new Error(`coordinator smoke: [SKIP] should not send a Discord reply ${JSON.stringify(sentMessages)}`);
	}
	if (!prompts.every((prompt) => prompt.startsWith("/skill:clanky-discord-operator "))) {
		throw new Error(`coordinator smoke: Discord operator skill was not activated ${JSON.stringify(prompts)}`);
	}
	if (typingConversationIds.length < 3 || !typingConversationIds.every((id) => id === "thread-1")) {
		throw new Error(
			`coordinator smoke: expected typing indicators for each Discord turn ${JSON.stringify(typingConversationIds)}`,
		);
	}

	await coordinator.stop();
	if (disposedSessionCount !== 1) {
		throw new Error(`coordinator smoke: expected one disposed runtime, got ${disposedSessionCount}`);
	}

	console.log(JSON.stringify({ sent: sentMessages.length, prompts: prompts.length, runtimeCreateCount }));
} catch (error) {
	const bridgeLog = await readFile(join(tmpRoot, "bridge.log"), "utf8").catch(() => "");
	if (bridgeLog.length > 0) {
		throw new Error(`${error instanceof Error ? error.message : String(error)}\nbridge log:\n${bridgeLog}`);
	}
	throw error;
} finally {
	await coordinator?.stop();
	store.close();
	await rm(tmpRoot, { recursive: true, force: true });
}

function makeMessage(externalMessageId: string, text: string): DiscordInboundMessage {
	return {
		externalMessageId,
		conversation: {
			id: "channel-1",
			kind: "thread",
			threadId: "thread-1",
			parentId: "channel-1",
			serverId: "guild-1",
			displayName: "thread-one",
		},
		sender: { id: "user-1", username: "user-one" },
		text,
		attachments: [],
		mentionsSelf: true,
	};
}

async function waitFor(condition: () => boolean | Promise<boolean>, label: string): Promise<void> {
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		if (await condition()) return;
		await delay(10);
	}
	throw new Error(`Timed out waiting for ${label}`);
}
