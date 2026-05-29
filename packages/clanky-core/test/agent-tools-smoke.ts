import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ClankyAgentToolHandlers,
	createClankyExtensionFactories,
	createClankyToolDefinitions,
	type DelegateToMainWorkerToolInput,
	type DiscordVoiceJoinToolInput,
	type ExternalMcpCallToolInput,
	type ExternalMcpListToolsInput,
	type MainAgentActivityToolInput,
	type MainAgentCancelToolInput,
	type MainSessionContextToolInput,
	type MemoryForgetToolInput,
	type MemoryRememberToolInput,
	type MemorySearchToolInput,
	maybeInjectWorkTrackerSkill,
	type OpenAiImageGenerateToolInput,
	recentDiscordAttachments,
	resolveClankyChatGatewayOwner,
	resolveClankyChatMode,
	runOpenAiWebSearch,
	type ScheduleCronToolInput,
	type SubagentMessageToolInput,
	saveStoredOpenAiApiKey,
	shouldStartAgentChatGateway,
	type WebSearchToolInput,
	type WorkTrackerLinkToolInput,
	type XAiImageGenerateToolInput,
	type XAiVideoGenerateToolInput,
} from "@clanky/core";
import {
	AuthStorage,
	type ExtensionCommandContext,
	type ExtensionFactory,
	type TerminalInputHandler,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

const calls: string[] = [];

const handlers: ClankyAgentToolHandlers = {
	scheduleCron: async (input) => {
		calls.push(`schedule:${input.schedule}:${input.prompt}`);
		return { scheduled: true, input };
	},
	workTrackerLink: async (input) => {
		calls.push(`tracker:${input.providerKind ?? "custom"}:${input.issueId}:${input.sessionId ?? "none"}`);
		return { ref: input };
	},
	externalMcpCall: async (input) => {
		calls.push(`mcp-call:${input.server}:${input.tool}`);
		return { result: { ok: true, input } };
	},
	externalMcpListTools: async (input) => {
		calls.push(`mcp-list:${input.server ?? "all"}`);
		return [
			{
				server: input.server ?? "faux",
				tools: [{ name: "echo", description: "Echo smoke input", inputSchema: { type: "object" } }],
			},
		];
	},
	mainSessionContext: async (input) => {
		calls.push(`main-session:${input.limit ?? "default"}`);
		return {
			sessionId: "main-session-smoke",
			branchEntries: 3,
			entries: [{ id: "entry-smoke", role: "user", text: "main context smoke" }],
		};
	},
	mainAgentActivity: async (input) => {
		calls.push(`main-activity:${input.limit ?? "default"}`);
		return {
			available: true,
			state: "busy",
			activeToolName: "Bash",
			recentAssistantMessages: [{ text: "working on it" }],
		};
	},
	mainAgentCancel: async (input) => {
		calls.push(`main-cancel:${input.reason ?? "none"}`);
		return { available: true, ok: true, cancelled: true, reason: input.reason ?? "none" };
	},
	delegateToMainWorker: async (input) => {
		calls.push(`delegate-main:${input.title}`);
		return { delegated: true, title: input.title, mode: "followUp" };
	},
	listSubagents: async () => {
		calls.push("subagent-status");
		return [
			{
				id: "discord-guild:guild-tool",
				kind: "discord-guild",
				scopeId: "guild-tool",
				scopeName: "Tool Guild",
				state: "idle",
				queueDepth: 0,
				thinkingLevel: "medium",
				activeSummary: "idle",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:01:00.000Z",
			},
		];
	},
	sendSubagentMessage: async (input) => {
		calls.push(`subagent-message:${input.id}:${input.text}`);
		return { accepted: true, mode: "followUp", sessionId: "subagent-session-smoke" };
	},
	memoryRemember: async (input) => {
		calls.push(`memory-remember:${input.claim}:${input.confirmed === true}`);
		return { saved: true, atom: stubAtom(input.claim) };
	},
	memorySearch: async (input) => {
		calls.push(`memory-search:${input.query ?? "all"}:${input.subjectId ?? "none"}`);
		return { atoms: [stubAtom("baseline")] };
	},
	memoryForget: async (input) => {
		calls.push(`memory-forget:${input.id ?? `${input.scope}:${input.subjectId}`}`);
		return { forgotten: 1 };
	},
	webSearch: async (input) => {
		calls.push(`web-search:${input.query}`);
		return { answer: "searched", input };
	},
	webBackendStatus: async () => {
		calls.push("web-status");
		return { openaiWebSearch: { available: true } };
	},
	openAiImageGenerate: async (input) => {
		calls.push(`openai-image:${input.prompt}`);
		return { provider: "openai", files: [{ path: "/tmp/openai-image.png" }] };
	},
	xaiImageGenerate: async (input) => {
		calls.push(`xai-image:${input.prompt}`);
		return { provider: "xai", files: [{ path: "/tmp/xai-image.jpg" }] };
	},
	xaiVideoGenerate: async (input) => {
		calls.push(`xai-video:${input.prompt}`);
		return { provider: "xai", requestId: "video-request", status: "done", path: "/tmp/xai-video.mp4" };
	},
	mediaBackendStatus: async () => {
		calls.push("media-status");
		return { openaiImages: { available: true }, xaiImagineImages: { available: true } };
	},
	discordVoiceStatus: async () => {
		calls.push("discord-voice-status");
		return { enabled: true, active: false };
	},
	discordVoiceJoin: async (input, options) => {
		const guildId = input.guildId ?? input.guild_id;
		const channelId = input.channelId ?? input.channel_id;
		calls.push(`discord-voice-join:${guildId}:${channelId}`);
		options?.onProgress?.({
			phase: "waiting_for_client_ready",
			message: "Waiting for Discord voice client to become ready.",
			...(guildId === undefined ? {} : { guildId }),
			...(channelId === undefined ? {} : { channelId }),
		});
		return { joined: true, input };
	},
	discordVoiceLeave: async (options) => {
		calls.push("discord-voice-leave");
		options?.onProgress?.({
			phase: "starting_voice_bridge",
			message: "Updating Discord voice bridge.",
		});
		return { joined: false };
	},
};

const tools = createClankyToolDefinitions(handlers);
const mainRuntimeTools = createClankyToolDefinitions(handlers, { includeMainWorkerDelegation: false });
assertChatModeHelpers();
await assertSubagentPanelCommand();
await assertClankyCommandCompletions();
assertWorkTrackerSkillInjection();
const expectedNames = [
	"schedule_cron",
	"mcp_list_tools",
	"mcp_call",
	"work_tracker_link",
	"main_session_context",
	"main_agent_activity",
	"main_agent_cancel",
	"delegate_to_main_worker",
	"subagent_status",
	"subagent_message",
	"memory_remember",
	"memory_search",
	"memory_forget",
	"media_backend_status",
	"openai_image_generate",
	"web_backend_status",
	"web_search",
	"xai_image_generate",
	"xai_video_generate",
	"discord_voice_status",
	"discord_voice_join",
	"discord_voice_leave",
];
assertToolNames(tools, expectedNames);
if (mainRuntimeTools.some((tool) => tool.name === "delegate_to_main_worker")) {
	throw new Error("agent-tools smoke: main runtime tools should not include delegate_to_main_worker");
}
await assertOpenAiWebSearchUsesStoredCredential();

await executeTool(tools, "schedule_cron", {
	schedule: "every 1h",
	prompt: "Summarize",
	provider: "anthropic",
	model: "claude-opus-4-5",
	timeout_seconds: 600,
	idempotency_key: "agent-tools-cron-smoke",
} satisfies ScheduleCronToolInput);

await executeTool(tools, "work_tracker_link", {
	provider_kind: "github-issues",
	issueId: "123",
	identifier: "owner/repo#123",
	sessionId: "session-smoke",
} satisfies WorkTrackerLinkToolInput);

await executeTool(tools, "mcp_call", {
	server: "faux",
	tool: "echo",
} satisfies ExternalMcpCallToolInput);

await executeTool(tools, "mcp_list_tools", {
	server: "faux",
} satisfies ExternalMcpListToolsInput);

await executeTool(tools, "main_session_context", {
	limit: 4,
} satisfies MainSessionContextToolInput);

await executeTool(tools, "main_agent_activity", {
	limit: 3,
} satisfies MainAgentActivityToolInput);

await executeTool(tools, "main_agent_cancel", {
	reason: "user asked to redirect foreground work",
} satisfies MainAgentCancelToolInput);

await executeTool(tools, "delegate_to_main_worker", {
	title: "Long Discord work",
	prompt: "Do the durable follow-up from Discord.",
	reason: "would take more than two minutes",
} satisfies DelegateToMainWorkerToolInput);

await executeTool(tools, "subagent_status", {});

await executeTool(tools, "subagent_message", {
	id: "discord-guild:guild-tool",
	text: "Please coordinate with the foreground task.",
} satisfies SubagentMessageToolInput);

await executeTool(tools, "memory_remember", {
	claim: "Project uses source-grounded memory atoms.",
	confirmed: true,
	subject_id: "smoke",
} satisfies MemoryRememberToolInput);

await executeTool(tools, "memory_search", {
	query: "memory",
	limit: 4,
} satisfies MemorySearchToolInput);

await executeTool(tools, "memory_forget", {
	id: "memory-tool",
} satisfies MemoryForgetToolInput);

await executeTool(tools, "web_search", {
	query: "Linear pricing",
	search_context_size: "low",
} satisfies WebSearchToolInput);

await executeTool(tools, "web_backend_status", {});

await executeTool(tools, "openai_image_generate", {
	prompt: "Draw a test icon",
	quality: "low",
} satisfies OpenAiImageGenerateToolInput);

await executeTool(tools, "xai_image_generate", {
	prompt: "Draw a test poster",
	aspect_ratio: "16:9",
	resolution: "1k",
} satisfies XAiImageGenerateToolInput);

await executeTool(tools, "xai_video_generate", {
	prompt: "A test animation",
	duration: 5,
	resolution: "480p",
} satisfies XAiVideoGenerateToolInput);

await executeTool(tools, "media_backend_status", {});

await executeTool(tools, "discord_voice_status", {});

const voiceJoinUpdates: string[] = [];
await executeTool(
	tools,
	"discord_voice_join",
	{
		guild_id: "guild-tool",
		channel_id: "voice-tool",
	} satisfies DiscordVoiceJoinToolInput,
	voiceJoinUpdates,
);
if (!voiceJoinUpdates.some((update) => update.includes("Waiting for Discord voice client"))) {
	throw new Error(`discord_voice_join did not emit startup progress: ${JSON.stringify(voiceJoinUpdates)}`);
}

const voiceLeaveUpdates: string[] = [];
await executeTool(tools, "discord_voice_leave", {}, voiceLeaveUpdates);
if (!voiceLeaveUpdates.some((update) => update.includes("Updating Discord voice bridge"))) {
	throw new Error(`discord_voice_leave did not emit startup progress: ${JSON.stringify(voiceLeaveUpdates)}`);
}

await assertRecentDiscordAttachmentsLoadsMediaSources();

const expectedCallPrefixes = [
	"schedule:",
	"tracker:",
	"mcp-call:",
	"mcp-list:",
	"main-session:",
	"delegate-main:",
	"subagent-status",
	"memory-remember:",
	"memory-search:",
	"memory-forget:",
	"web-search:",
	"web-status",
	"openai-image:",
	"xai-image:",
	"xai-video:",
	"media-status",
	"discord-voice-status",
	"discord-voice-join:",
	"discord-voice-leave",
];
for (const prefix of expectedCallPrefixes) {
	if (!calls.some((entry) => entry.startsWith(prefix))) {
		throw new Error(`Expected handler call with prefix ${prefix}, got ${JSON.stringify(calls)}`);
	}
}

console.log(JSON.stringify({ tools: tools.length, calls: calls.length }));

function assertChatModeHelpers(): void {
	if (resolveClankyChatMode({}) !== "agent-owned") {
		throw new Error("Expected default chat mode to be agent-owned");
	}
	if (resolveClankyChatMode({ AGENTROOM: "1" }) !== "agent-owned-in-room") {
		throw new Error("Expected AGENTROOM=1 to preserve agent-owned gateway while marking room participation");
	}
	if (!shouldStartAgentChatGateway({ AGENTROOM: "1" })) {
		throw new Error("Expected AGENTROOM=1 not to disable agent-owned chat gateway startup");
	}
	if (resolveClankyChatGatewayOwner({ CLANKY_CHAT_GATEWAY_OWNER: "room" }) !== "room") {
		throw new Error("Expected CLANKY_CHAT_GATEWAY_OWNER=room to select room-owned gateway mode");
	}
	if (shouldStartAgentChatGateway({ CLANKY_CHAT_GATEWAY_OWNER: "room" })) {
		throw new Error("Expected room-owned gateway mode to disable agent-owned gateway startup");
	}
}

function assertWorkTrackerSkillInjection(): void {
	const prompt = "Implement the tracker cleanup";
	const transformed = maybeInjectWorkTrackerSkill(prompt, { CLANKY_WORK_TRACKER: "linear" });
	if (transformed !== `/skill:clanky-work-tracker ${prompt}`) {
		throw new Error(`Expected configured work tracker prompt to inject skill, got ${transformed}`);
	}
	if (maybeInjectWorkTrackerSkill(prompt, {}) !== prompt) {
		throw new Error("Expected unconfigured work tracker prompt to remain unchanged");
	}
	if (maybeInjectWorkTrackerSkill("/profile", { CLANKY_WORK_TRACKER: "linear" }) !== "/profile") {
		throw new Error("Expected slash commands to skip work tracker skill injection");
	}
}

function stubAtom(claim: string) {
	return {
		id: "memory-tool",
		scope: "project" as const,
		subjectId: "smoke",
		type: "fact" as const,
		claim,
		sourceEventIds: ["event-tool"],
		confidence: 0.9,
		sensitivity: "public" as const,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		lexicalIndexTerms: ["project", "memory"],
	};
}

function assertToolNames(actual: readonly ToolDefinition[], expected: readonly string[]): void {
	const names = actual.map((tool) => tool.name).sort();
	const sortedExpected = [...expected].sort();
	if (names.join(",") !== sortedExpected.join(",")) {
		throw new Error(`Tool definitions mismatch. expected=${sortedExpected.join(",")} actual=${names.join(",")}`);
	}
}

async function assertOpenAiWebSearchUsesStoredCredential(): Promise<void> {
	const authStorage = AuthStorage.inMemory();
	saveStoredOpenAiApiKey(authStorage, "stored-openai-key");
	const result = await runOpenAiWebSearch(
		{ query: "stored key smoke", search_context_size: "low" },
		{
			authStorage,
			env: {},
			fetchImpl: async (_input, init) => {
				const headers = init?.headers as Record<string, string> | undefined;
				if (headers?.authorization !== "Bearer stored-openai-key") {
					throw new Error(`smoke: web_search used wrong authorization header: ${headers?.authorization}`);
				}
				return new Response(
					JSON.stringify({
						id: "resp-smoke",
						status: "completed",
						output: [
							{
								type: "message",
								content: [{ type: "output_text", text: "stored credential ok", annotations: [] }],
							},
						],
					}),
					{ status: 200 },
				);
			},
		},
	);
	if (result.answer !== "stored credential ok") {
		throw new Error(`smoke: web_search did not parse fake response: ${result.answer}`);
	}
}

async function assertRecentDiscordAttachmentsLoadsMediaSources(): Promise<void> {
	const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
		const url = String(input);
		if (url.startsWith("https://discord.com/api/v10/channels/channel-media/messages?")) {
			return new Response(JSON.stringify(discordMessagesFixture()), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		const mimeType = url.endsWith(".webp") ? "image/webp" : url.endsWith(".gif") ? "image/gif" : "image/png";
		return new Response(new Uint8Array([1, 2, 3]), {
			status: 200,
			headers: { "content-type": mimeType, "content-length": "3" },
		});
	};
	const result = await recentDiscordAttachments(
		{
			channelId: "channel-media",
			messageLimit: 3,
			mediaLimit: 3,
			load: true,
		},
		{
			env: { CLANKY_DISCORD_TOKEN: "token-smoke" },
			fetchImpl,
		},
	);
	const sources = result.media.map((entry) => `${entry.source}:${entry.kind}:${entry.url}`).join("\n");
	if (
		result.loadedImageCount !== 3 ||
		!sources.includes("attachment:image:https://cdn.example/direct.png") ||
		!sources.includes("embed:gif:https://media.tenor.com/preview.gif") ||
		!sources.includes("link:image:https://cdn.example/from-content.webp")
	) {
		throw new Error(`recentDiscordAttachments did not load expected media sources: ${JSON.stringify(result)}`);
	}
	if (result.imageContents.length !== 3 || result.loadedImages.some((entry) => entry.mimeType.length === 0)) {
		throw new Error(`recentDiscordAttachments image blocks missing: ${JSON.stringify(result.loadedImages)}`);
	}
	const exact = await recentDiscordAttachments(
		{
			channelId: "channel-media",
			messageId: "1440000000000000001",
			messageLimit: 3,
			mediaLimit: 3,
			load: false,
		},
		{
			env: { CLANKY_DISCORD_TOKEN: "token-smoke" },
			fetchImpl,
		},
	);
	if (
		exact.targetMessageFound !== true ||
		exact.scannedMessageCount !== 1 ||
		exact.media.length !== 1 ||
		exact.media[0]?.messageId !== "1440000000000000001" ||
		exact.media[0].url !== "https://cdn.example/direct.png"
	) {
		throw new Error(`recentDiscordAttachments did not pin exact message media: ${JSON.stringify(exact)}`);
	}
}

function discordMessagesFixture(): unknown[] {
	return [
		{
			id: "1440000000000000002",
			channel_id: "channel-media",
			content: "direct image link https://cdn.example/from-content.webp",
			author: { id: "user-2", username: "clunkyconk" },
			timestamp: "2026-01-01T00:02:00.000Z",
			attachments: [],
			embeds: [
				{
					type: "gifv",
					provider: { name: "Tenor" },
					title: "tenor preview",
					thumbnail: {
						url: "https://media.tenor.com/preview.gif",
						width: 320,
						height: 240,
					},
				},
			],
		},
		{
			id: "1440000000000000001",
			channel_id: "channel-media",
			content: "",
			author: { id: "user-1", username: "tester" },
			timestamp: "2026-01-01T00:01:00.000Z",
			attachments: [
				{
					id: "attachment-1",
					url: "https://cdn.example/direct.png",
					filename: "direct.png",
					content_type: "image/png",
					size: 3,
				},
			],
			embeds: [],
		},
	];
}

async function assertSubagentPanelCommand(): Promise<void> {
	const tmpRoot = await mkdtemp(join(tmpdir(), "clanky-subagent-panel-"));
	const firstSessionFile = join(tmpRoot, "first-subagent.jsonl");
	const selectedSessionFile = join(tmpRoot, "selected-subagent.jsonl");
	await writeFile(firstSessionFile, subagentSessionFixture("First User", "first discord", "first back"));
	await writeFile(
		selectedSessionFile,
		subagentSessionFixture("Smoke User", "hello discord\nsecond line", "hello back\n\nnext step done"),
	);
	try {
		await assertSubagentPanelCommandWithSession({ firstSessionFile, selectedSessionFile });
	} finally {
		await rm(tmpRoot, { recursive: true, force: true });
	}
}

function subagentSessionFixture(sender: string, userText: string, assistantText: string): string {
	const reasoningText = `checking ${sender} subagent reasoning`;
	return [
		JSON.stringify({
			type: "session",
			version: 3,
			id: `session-${sender.toLowerCase().replace(/\s+/g, "-")}`,
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: "/tmp/clanky-agent-tools-smoke",
		}),
		JSON.stringify({
			type: "message",
			id: "user-1",
			parentId: null,
			timestamp: "2026-01-01T00:01:00.000Z",
			message: {
				role: "user",
				content: [
					{
						type: "text",
						text: `Discord scope: discord-guild guild-smoke\nMessage from ${sender}:\n${userText}`,
					},
				],
			},
		}),
		JSON.stringify({
			type: "message",
			id: "assistant-1",
			parentId: "user-1",
			timestamp: "2026-01-01T00:02:00.000Z",
			message: {
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "",
						thinkingSignature: JSON.stringify({
							type: "reasoning",
							encrypted_content: "do-not-render",
							summary: [{ type: "summary_text", text: reasoningText }],
						}),
					},
					{ type: "text", text: assistantText },
				],
			},
		}),
		"",
	].join("\n");
}

async function assertClankyCommandCompletions(): Promise<void> {
	const commands = new Map<string, Parameters<Parameters<ExtensionFactory>[0]["registerCommand"]>[1]>();
	const completionHandlers: ClankyAgentToolHandlers = {
		...handlers,
		listSkills: async () => ({ skills: [] }),
		createSkill: async (input) => ({ created: input.name }),
	};
	const pi = {
		registerCommand(name: string, options: Parameters<Parameters<ExtensionFactory>[0]["registerCommand"]>[1]) {
			commands.set(name, options);
		},
		on() {
			return;
		},
	} as unknown as Parameters<ExtensionFactory>[0];
	for (const factory of createClankyExtensionFactories(completionHandlers)) await factory(pi);
	await assertCommandCompletionIncludes(commands.get("skill"), "", "add ");
	await assertCommandCompletionIncludes(commands.get("memory"), "", "remember ");
	await assertCommandCompletionIncludes(commands.get("memory"), "ref", "reflect");
	await assertCommandCompletionIncludes(commands.get("memory"), "for", "forget ");
	await assertCommandCompletionIncludes(commands.get("subagents"), "", "modal");
	await assertCommandCompletionIncludes(commands.get("subagents"), "off", "off");
}

async function assertCommandCompletionIncludes(
	command: Parameters<Parameters<ExtensionFactory>[0]["registerCommand"]>[1] | undefined,
	prefix: string,
	expectedValue: string,
): Promise<void> {
	if (command === undefined) throw new Error(`agent-tools-smoke: missing command for completion ${expectedValue}`);
	const completions = await command.getArgumentCompletions?.(prefix);
	if (!Array.isArray(completions)) {
		throw new Error(`agent-tools-smoke: command did not return completions for prefix "${prefix}"`);
	}
	const values = completions.map((completion) => completion.value);
	if (!values.includes(expectedValue)) {
		throw new Error(
			`agent-tools-smoke: completion for prefix "${prefix}" did not include "${expectedValue}"; got ${values.join(", ")}`,
		);
	}
}

async function assertSubagentPanelCommandWithSession(sessionFiles: {
	firstSessionFile: string;
	selectedSessionFile: string;
}): Promise<void> {
	const commands = new Map<string, Parameters<Parameters<ExtensionFactory>[0]["registerCommand"]>[1]>();
	const sentSubagentMessages: Array<{ id: string; text: string }> = [];
	const factories = createClankyExtensionFactories({
		listSubagents: async () => [
			{
				id: "discord-guild:guild-first",
				kind: "discord-guild",
				scopeId: "guild-first",
				scopeName: "First Guild",
				state: "running",
				queueDepth: 3,
				thinkingLevel: "high",
				activeSummary: "replying to First User in general",
				sessionFile: sessionFiles.firstSessionFile,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:01:30.000Z",
			},
			{
				id: "discord-guild:guild-smoke",
				kind: "discord-guild",
				scopeId: "guild-smoke",
				scopeName: "Smoke Guild",
				state: "running",
				queueDepth: 2,
				thinkingLevel: "medium",
				activeSummary: "replying to Smoke User in general",
				sessionFile: sessionFiles.selectedSessionFile,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:01:00.000Z",
			},
		],
		sendSubagentMessage: async (input) => {
			sentSubagentMessages.push(input);
			return { accepted: true, mode: "start", sessionId: "session-selected" };
		},
	});
	let inputHandlerRef:
		| ((event: { text: string; source: string }, ctx: unknown) => Promise<{ action?: string } | undefined>)
		| undefined;
	const pi = {
		registerCommand(name: string, options: Parameters<Parameters<ExtensionFactory>[0]["registerCommand"]>[1]) {
			commands.set(name, options);
		},
		on(event: string, handler: unknown) {
			if (event === "input") {
				inputHandlerRef = handler as typeof inputHandlerRef;
			}
		},
	} as unknown as Parameters<ExtensionFactory>[0];
	for (const factory of factories) await factory(pi);
	if (inputHandlerRef === undefined) throw new Error("smoke: input handler not registered");
	const inputHandler = inputHandlerRef;

	const widgets = new Map<string, string[] | undefined>();
	const widgetPlacements = new Map<string, string | undefined>();
	const notifications: string[] = [];
	let detailLines: string[] | undefined;
	let scrolledDetailLines: string[] | undefined;
	let terminalInput: TerminalInputHandler | undefined;
	const ctx = {
		hasUI: true,
		ui: {
			async custom(
				factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: undefined) => void) => unknown,
			) {
				let terminalRows = 12;
				const component = factory(
					{
						terminal: {
							get rows() {
								return terminalRows;
							},
						},
						requestRender() {},
					},
					{
						fg: (_color: string, text: string) => text,
						bg: (_color: string, text: string) => text,
						bold: (text: string) => text,
						italic: (text: string) => text,
					},
					{},
					() => undefined,
				) as {
					render(width: number): string[];
					handleInput?(data: string): void;
					dispose?(): void;
				};
				await new Promise((resolve) => setTimeout(resolve, 10));
				detailLines = component.render(100);
				component.handleInput?.("\u001b[1;1A");
				component.handleInput?.("\u0010");
				scrolledDetailLines = component.render(100);
				component.handleInput?.("G");
				terminalRows = 24;
				component.handleInput?.("ping from tui");
				component.handleInput?.("\r");
				await new Promise((resolve) => setTimeout(resolve, 10));
				detailLines = component.render(100);
				component.dispose?.();
			},
			onTerminalInput(handler: TerminalInputHandler) {
				terminalInput = handler;
				return () => {
					terminalInput = undefined;
				};
			},
			notify(message: string) {
				notifications.push(message);
			},
			setWidget(key: string, content: string[] | undefined, options?: { placement?: string }) {
				widgets.set(key, content);
				widgetPlacements.set(key, options?.placement);
			},
			setStatus() {
				return;
			},
			getEditorText() {
				return "";
			},
			theme: {
				fg: (_color: string, text: string) => text,
				bg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			},
		},
	} as unknown as ExtensionCommandContext;
	const subagents = commands.get("subagents");
	if (subagents === undefined) throw new Error("smoke: /subagents command was not registered");
	await subagents.handler("panel", ctx);
	const passivePanelLines = widgets.get("clanky-subagents");
	if (
		passivePanelLines === undefined ||
		!passivePanelLines.join("\n").includes("Smoke Guild") ||
		!passivePanelLines.join("\n").includes("replying to Smoke User")
	) {
		throw new Error(`smoke: /subagents did not show the passive live panel: ${JSON.stringify(passivePanelLines)}`);
	}
	if (widgetPlacements.get("clanky-subagents") !== "belowEditor") {
		throw new Error(
			`smoke: /subagents panel was not placed below the editor: ${widgetPlacements.get("clanky-subagents")}`,
		);
	}
	if (terminalInput === undefined) throw new Error("smoke: /subagents did not register passive panel input");
	const typingResult = terminalInput("x");
	if (typingResult?.consume === true) {
		throw new Error("smoke: /subagents consumed normal typing while the panel was passive");
	}
	terminalInput("\u001b[B");
	assertSelectedSubagent(widgets.get("clanky-subagents"), "main", "plain Down enters at main row");
	terminalInput("\u001b[A");
	const stillSelected = widgets.get("clanky-subagents")?.some((line) => line.startsWith("▸"));
	if (stillSelected !== false) {
		throw new Error(
			`smoke: plain Up at index 0 should deactivate selection: ${JSON.stringify(widgets.get("clanky-subagents"))}`,
		);
	}
	terminalInput("\u001b[B");
	assertSelectedSubagent(widgets.get("clanky-subagents"), "main", "plain Down re-enters at main row");
	terminalInput("\u001b[B");
	assertSelectedSubagent(widgets.get("clanky-subagents"), "First Guild", "plain Down moves to First Guild");
	terminalInput("\u001b[B");
	assertSelectedSubagent(widgets.get("clanky-subagents"), "Smoke Guild", "plain Down moves to Smoke Guild");
	terminalInput("\r");
	const afterEnter = widgets.get("clanky-subagents")?.join("\n") ?? "";
	if (afterEnter.split("\n").some((line) => line.startsWith("▸"))) {
		throw new Error(`smoke: Enter should deactivate selection: ${JSON.stringify(widgets.get("clanky-subagents"))}`);
	}
	const smokeLine = widgets.get("clanky-subagents")?.find((line) => line.includes("Smoke Guild"));
	if (smokeLine === undefined || !smokeLine.includes("●")) {
		throw new Error(
			`smoke: Enter should mark Smoke Guild as active: ${JSON.stringify(widgets.get("clanky-subagents"))}`,
		);
	}
	const mainLineAfter = widgets.get("clanky-subagents")?.find((line) => line.includes("main"));
	if (mainLineAfter === undefined || !mainLineAfter.includes("○")) {
		throw new Error(
			`smoke: main row should be hollow after Enter on Smoke: ${JSON.stringify(widgets.get("clanky-subagents"))}`,
		);
	}
	const inputEvent = await inputHandler(
		{
			text: "ping from input",
			source: "interactive",
		},
		ctx,
	);
	if (inputEvent?.action !== "handled") {
		throw new Error(`smoke: input not routed to subagent: ${JSON.stringify(inputEvent)}`);
	}
	if (sentSubagentMessages.length !== 1 || sentSubagentMessages[0]?.text !== "ping from input") {
		throw new Error(`smoke: input handler did not dispatch to subagent: ${JSON.stringify(sentSubagentMessages)}`);
	}
	const slashEvent = await inputHandler({ text: "/help", source: "interactive" }, ctx);
	if (slashEvent?.action === "handled") {
		throw new Error("smoke: slash command should not be routed to subagent");
	}
	await subagents.handler("chat", ctx);
	await new Promise((resolve) => setTimeout(resolve, 20));
	if (detailLines?.join("\n").includes("first discord")) {
		throw new Error(`smoke: /subagents chat opened the wrong transcript: ${JSON.stringify(detailLines)}`);
	}
	if (
		detailLines === undefined ||
		!detailLines.join("\n").includes("Smoke Guild") ||
		!detailLines.join("\n").includes("11 rows") ||
		!detailLines.join("\n").includes("clanky  2026-01-01 00:02") ||
		detailLines.join("\n").includes("do-not-render") ||
		!detailLines.join("\n").includes("hello back") ||
		!detailLines.join("\n").includes("next step done")
	) {
		throw new Error(`smoke: /subagents chat did not render transcript: ${JSON.stringify(detailLines)}`);
	}
	if (
		scrolledDetailLines === undefined ||
		!scrolledDetailLines.join("\n").includes("↑ 4 above") ||
		!scrolledDetailLines.join("\n").includes("↓ 2 below") ||
		!scrolledDetailLines.join("\n").includes("checking Smoke User subagent reasoning")
	) {
		throw new Error(`smoke: /subagents did not scroll with keyboard input: ${JSON.stringify(scrolledDetailLines)}`);
	}
	if (!sentSubagentMessages.some((message) => message.text === "ping from tui")) {
		throw new Error(
			`smoke: /subagents composer did not send selected message: ${JSON.stringify(sentSubagentMessages)}`,
		);
	}
	await subagents.handler("panel", ctx);
	const panelLines = widgets.get("clanky-subagents");
	if (panelLines === undefined || !panelLines.join("\n").includes("Smoke Guild")) {
		throw new Error(`smoke: /subagents show did not render live panel: ${JSON.stringify(panelLines)}`);
	}
	await subagents.handler("hide", ctx);
	if (widgets.get("clanky-subagents") !== undefined) {
		throw new Error("smoke: /subagents hide did not clear live panel");
	}
	await subagents.handler("json", ctx);
	if (!notifications.some((message) => message.includes("discord-guild:guild-smoke"))) {
		throw new Error(`smoke: /subagents json did not show raw data: ${JSON.stringify(notifications)}`);
	}
}

function assertSelectedSubagent(lines: string[] | undefined, expectedScope: string, action: string): void {
	const selectedLine = lines?.find((line) => line.startsWith("▸"));
	if (selectedLine === undefined || !selectedLine.includes(expectedScope)) {
		throw new Error(`smoke: ${action} selected wrong subagent: ${JSON.stringify(lines)}`);
	}
}

async function executeTool<T extends Record<string, unknown>>(
	tools: readonly ToolDefinition[],
	name: string,
	input: T,
	updates?: string[],
): Promise<unknown> {
	const tool = tools.find((candidate) => candidate.name === name);
	if (tool === undefined) throw new Error(`Tool ${name} is not registered`);
	const ctx = {
		sessionManager: { getSessionId: () => "session-smoke" },
		cwd: "/tmp/clanky-agent-tools-smoke",
	} as unknown as Parameters<typeof tool.execute>[4];
	const result = await tool.execute(
		"call-id",
		input,
		new AbortController().signal,
		(partial) => {
			const content = partial.content[0];
			if (content?.type === "text") updates?.push(content.text);
		},
		ctx,
	);
	if (result === undefined || typeof result !== "object" || !("details" in result)) {
		throw new Error(`Tool ${name} returned malformed result: ${JSON.stringify(result)}`);
	}
	return (result as { details: unknown }).details;
}
