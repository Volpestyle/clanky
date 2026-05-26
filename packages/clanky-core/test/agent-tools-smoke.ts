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
	type LinearCreateIssueToolInput,
	type LinearLinkToolInput,
	type MainSessionContextToolInput,
	type MemoryForgetToolInput,
	type MemoryRememberToolInput,
	type MemorySearchToolInput,
	type OpenAiImageGenerateToolInput,
	recentDiscordAttachments,
	resolveClankyChatGatewayOwner,
	resolveClankyChatMode,
	runOpenAiWebSearch,
	type ScheduleCronToolInput,
	saveStoredOpenAiApiKey,
	shouldStartAgentChatGateway,
	type TaskCreateToolInput,
	type WebSearchToolInput,
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
	linearLink: async (input) => {
		calls.push(`linear:${input.issueId}:${input.sessionId ?? input.taskId ?? "none"}`);
		return { link: input };
	},
	linearCreateIssue: async (input) => {
		calls.push(`linear-create:${input.teamId}:${input.title}`);
		return { issue: { issueId: "issue-tool", identifier: "PROJ-100", ...input } };
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
	taskCreate: async (input) => {
		calls.push(`task:${input.title}:${input.sessionId ?? "none"}`);
		return { task: { id: "task-created", ...input } };
	},
	mainSessionContext: async (input) => {
		calls.push(`main-session:${input.limit ?? "default"}`);
		return {
			sessionId: "main-session-smoke",
			branchEntries: 3,
			entries: [{ id: "entry-smoke", role: "user", text: "main context smoke" }],
		};
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
				activeSummary: "idle",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:01:00.000Z",
			},
		];
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
	discordVoiceJoin: async (input) => {
		calls.push(`discord-voice-join:${input.guildId ?? input.guild_id}:${input.channelId ?? input.channel_id}`);
		return { joined: true, input };
	},
	discordVoiceLeave: async () => {
		calls.push("discord-voice-leave");
		return { joined: false };
	},
};

const tools = createClankyToolDefinitions(handlers);
assertChatModeHelpers();
await assertSubagentPanelCommand();
const expectedNames = [
	"schedule_cron",
	"mcp_list_tools",
	"mcp_call",
	"linear_create_issue",
	"linear_link",
	"task_create",
	"main_session_context",
	"delegate_to_main_worker",
	"subagent_status",
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
await assertOpenAiWebSearchUsesStoredCredential();

await executeTool(tools, "schedule_cron", {
	schedule: "every 1h",
	prompt: "Summarize",
	provider: "anthropic",
	model: "claude-opus-4-5",
	timeout_seconds: 600,
	idempotency_key: "agent-tools-cron-smoke",
} satisfies ScheduleCronToolInput);

await executeTool(tools, "linear_create_issue", {
	team_id: "team-1",
	title: "Linear smoke",
	description: "Linear create smoke description",
} satisfies LinearCreateIssueToolInput);

await executeTool(tools, "linear_link", {
	issueId: "PROJ-1",
	sessionId: "session-smoke",
} satisfies LinearLinkToolInput);

await executeTool(tools, "mcp_call", {
	server: "faux",
	tool: "echo",
} satisfies ExternalMcpCallToolInput);

await executeTool(tools, "mcp_list_tools", {
	server: "faux",
} satisfies ExternalMcpListToolsInput);

await executeTool(tools, "task_create", {
	title: "Task smoke",
	priority: "high",
} satisfies TaskCreateToolInput);

await executeTool(tools, "main_session_context", {
	limit: 4,
} satisfies MainSessionContextToolInput);

await executeTool(tools, "delegate_to_main_worker", {
	title: "Long Discord work",
	prompt: "Do the durable follow-up from Discord.",
	reason: "would take more than two minutes",
} satisfies DelegateToMainWorkerToolInput);

await executeTool(tools, "subagent_status", {});

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

await executeTool(tools, "discord_voice_join", {
	guild_id: "guild-tool",
	channel_id: "voice-tool",
} satisfies DiscordVoiceJoinToolInput);

await executeTool(tools, "discord_voice_leave", {});

await assertRecentDiscordAttachmentsLoadsMediaSources();

const expectedCallPrefixes = [
	"schedule:",
	"linear-create:",
	"linear:",
	"mcp-call:",
	"mcp-list:",
	"task:",
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
				content: [{ type: "text", text: assistantText }],
			},
		}),
		"",
	].join("\n");
}

async function assertSubagentPanelCommandWithSession(sessionFiles: {
	firstSessionFile: string;
	selectedSessionFile: string;
}): Promise<void> {
	const commands = new Map<string, Parameters<Parameters<ExtensionFactory>[0]["registerCommand"]>[1]>();
	const factories = createClankyExtensionFactories({
		listSubagents: async () => [
			{
				id: "discord-guild:guild-first",
				kind: "discord-guild",
				scopeId: "guild-first",
				scopeName: "First Guild",
				state: "running",
				queueDepth: 3,
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
				activeSummary: "replying to Smoke User in general",
				sessionFile: sessionFiles.selectedSessionFile,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:01:00.000Z",
			},
		],
	});
	const pi = {
		registerCommand(name: string, options: Parameters<Parameters<ExtensionFactory>[0]["registerCommand"]>[1]) {
			commands.set(name, options);
		},
		on() {
			return;
		},
	} as unknown as Parameters<ExtensionFactory>[0];
	for (const factory of factories) await factory(pi);

	const widgets = new Map<string, string[] | undefined>();
	const widgetPlacements = new Map<string, string | undefined>();
	const notifications: string[] = [];
	let detailLines: string[] | undefined;
	let terminalInput: TerminalInputHandler | undefined;
	const ctx = {
		hasUI: true,
		ui: {
			async custom(
				factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: undefined) => void) => unknown,
			) {
				const component = factory(
					{ requestRender() {} },
					{
						fg: (_color: string, text: string) => text,
						bold: (text: string) => text,
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
			theme: {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			},
		},
	} as unknown as ExtensionCommandContext;
	const subagents = commands.get("subagents");
	if (subagents === undefined) throw new Error("smoke: /subagents command was not registered");
	await subagents.handler("", ctx);
	const passivePanelLines = widgets.get("clanky-subagents");
	if (
		passivePanelLines === undefined ||
		!passivePanelLines.join("\n").includes("Smoke Guild") ||
		!passivePanelLines.join("\n").includes("/subagents focus selects")
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
	await subagents.handler("", ctx);
	if (widgets.get("clanky-subagents") !== undefined) {
		throw new Error("smoke: /subagents did not toggle the live panel off");
	}
	await subagents.handler("", ctx);
	const pendingMetaResult = terminalInput("\u001b");
	if (pendingMetaResult?.consume === true) {
		throw new Error("smoke: /subagents consumed standalone escape while waiting for split Option+Down");
	}
	terminalInput("\u001b[B");
	assertSelectedSubagent(widgets.get("clanky-subagents"), "Smoke Guild", "split Option+Down");
	terminalInput("\u001b[1;3:1A");
	assertSelectedSubagent(widgets.get("clanky-subagents"), "First Guild", "event-typed Option+Up");
	terminalInput("\u001b[1;3:1B");
	assertSelectedSubagent(widgets.get("clanky-subagents"), "Smoke Guild", "event-typed Option+Down");
	terminalInput("\r");
	await new Promise((resolve) => setTimeout(resolve, 20));
	if (detailLines?.join("\n").includes("first discord")) {
		throw new Error(`smoke: /subagents enter opened the wrong transcript: ${JSON.stringify(detailLines)}`);
	}
	if (
		detailLines === undefined ||
		!detailLines.join("\n").includes("Conversation history (2 messages)") ||
		!detailLines.join("\n").includes("[2026-01-01 00:01] user / Smoke User") ||
		!detailLines.join("\n").includes("[2026-01-01 00:02] clanky") ||
		!detailLines.join("\n").includes("hello discord") ||
		!detailLines.join("\n").includes("second line") ||
		!detailLines.join("\n").includes("hello back") ||
		!detailLines.join("\n").includes("next step done")
	) {
		throw new Error(`smoke: /subagents enter did not render transcript: ${JSON.stringify(detailLines)}`);
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
	const selectedLine = lines?.find((line) => line.startsWith(">"));
	if (selectedLine === undefined || !selectedLine.includes(expectedScope)) {
		throw new Error(`smoke: ${action} selected wrong subagent: ${JSON.stringify(lines)}`);
	}
}

async function executeTool<T extends Record<string, unknown>>(
	tools: readonly ToolDefinition[],
	name: string,
	input: T,
): Promise<unknown> {
	const tool = tools.find((candidate) => candidate.name === name);
	if (tool === undefined) throw new Error(`Tool ${name} is not registered`);
	const ctx = {
		sessionManager: { getSessionId: () => "session-smoke" },
		cwd: "/tmp/clanky-agent-tools-smoke",
	} as unknown as Parameters<typeof tool.execute>[4];
	const result = await tool.execute("call-id", input, new AbortController().signal, () => undefined, ctx);
	if (result === undefined || typeof result !== "object" || !("details" in result)) {
		throw new Error(`Tool ${name} returned malformed result: ${JSON.stringify(result)}`);
	}
	return (result as { details: unknown }).details;
}
