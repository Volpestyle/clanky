import {
	type ClankyAgentToolHandlers,
	createClankyToolDefinitions,
	type ExternalMcpCallToolInput,
	type LinearCreateIssueToolInput,
	type LinearLinkToolInput,
	type MemoryForgetToolInput,
	type MemoryRememberToolInput,
	type MemorySearchToolInput,
	type OpenAiImageGenerateToolInput,
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
import { AuthStorage, type ToolDefinition } from "@earendil-works/pi-coding-agent";

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
	taskCreate: async (input) => {
		calls.push(`task:${input.title}:${input.sessionId ?? "none"}`);
		return { task: { id: "task-created", ...input } };
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
};

const tools = createClankyToolDefinitions(handlers);
assertChatModeHelpers();
const expectedNames = [
	"schedule_cron",
	"mcp_call",
	"linear_create_issue",
	"linear_link",
	"task_create",
	"memory_remember",
	"memory_search",
	"memory_forget",
	"media_backend_status",
	"openai_image_generate",
	"web_backend_status",
	"web_search",
	"xai_image_generate",
	"xai_video_generate",
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

await executeTool(tools, "task_create", {
	title: "Task smoke",
	priority: "high",
} satisfies TaskCreateToolInput);

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

const expectedCallPrefixes = [
	"schedule:",
	"linear-create:",
	"linear:",
	"mcp-call:",
	"task:",
	"memory-remember:",
	"memory-search:",
	"memory-forget:",
	"web-search:",
	"web-status",
	"openai-image:",
	"xai-image:",
	"xai-video:",
	"media-status",
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
