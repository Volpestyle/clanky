import { readFile } from "node:fs/promises";
import {
	type AgentToolResult,
	type BeforeProviderRequestEvent,
	defineTool,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionFactory,
	parseSessionEntries,
	type SessionMessageEntry,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type {
	DiscordAddReactionInput,
	DiscordListChannelsInput,
	DiscordListEmojisInput,
	DiscordReadMessagesInput,
	DiscordRecentActivityInput,
	DiscordSendMessageInput,
} from "./discord/operator.ts";
import type { LinearCreateIssueInput } from "./linear/client.ts";
import type { CreateLinearLinkInput } from "./linear/links.ts";
import type { OpenAiImageGenerateInput, XAiImageGenerateInput, XAiVideoGenerateInput } from "./media/operator.ts";
import type {
	ForgetMemoryInput,
	MemoryExport,
	MemoryPacket,
	MemoryPacketInput,
	MemorySearchOptions,
	MemorySearchResult,
	MemoryWriteResult,
	RememberMemoryInput,
	SetMemoryConsentInput,
} from "./memory/store.ts";
import type { CreateClankySkillInput } from "./skills/loader.ts";
import { extractIndexableMessageText, type SessionIndexMessageInput } from "./state/index-db.ts";
import type { ClankySubagentState, ClankySubagentSummary } from "./subagents/store.ts";
import type { OpenAiWebSearchInput } from "./web/operator.ts";

type ClankyMessageEndEvent = {
	message: Parameters<typeof extractIndexableMessageText>[0];
};

const scheduleCronSchema = Type.Object({
	schedule: Type.String(),
	prompt: Type.String(),
	deliver: Type.Optional(Type.String()),
	skill: Type.Optional(Type.String()),
	provider: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	timeoutSeconds: Type.Optional(Type.Number()),
	timeout_seconds: Type.Optional(Type.Number()),
	workdir: Type.Optional(Type.String()),
	idempotencyKey: Type.Optional(Type.String()),
	idempotency_key: Type.Optional(Type.String()),
});

const linearLinkSchema = Type.Object({
	issueId: Type.Optional(Type.String()),
	issue_id: Type.Optional(Type.String()),
	sessionId: Type.Optional(Type.String()),
	session_id: Type.Optional(Type.String()),
	taskId: Type.Optional(Type.String()),
	task_id: Type.Optional(Type.String()),
	note: Type.Optional(Type.String()),
});

const linearCreateIssueSchema = Type.Object({
	teamId: Type.Optional(Type.String()),
	team_id: Type.Optional(Type.String()),
	title: Type.String(),
	description: Type.Optional(Type.String()),
	assigneeId: Type.Optional(Type.String()),
	assignee_id: Type.Optional(Type.String()),
	projectId: Type.Optional(Type.String()),
	project_id: Type.Optional(Type.String()),
	stateId: Type.Optional(Type.String()),
	state_id: Type.Optional(Type.String()),
	priority: Type.Optional(Type.Number()),
	labelIds: Type.Optional(Type.Array(Type.String())),
	label_ids: Type.Optional(Type.Array(Type.String())),
});

const externalMcpCallSchema = Type.Object({
	server: Type.String(),
	tool: Type.String(),
	arguments: Type.Optional(Type.Unknown()),
});

const mainSessionContextSchema = Type.Object({
	limit: Type.Optional(Type.Number()),
	maxChars: Type.Optional(Type.Number()),
	max_chars: Type.Optional(Type.Number()),
	includeToolResults: Type.Optional(Type.Boolean()),
	include_tool_results: Type.Optional(Type.Boolean()),
	includeHidden: Type.Optional(Type.Boolean()),
	include_hidden: Type.Optional(Type.Boolean()),
});

const delegateToMainWorkerSchema = Type.Object({
	title: Type.String(),
	prompt: Type.String(),
	reason: Type.Optional(Type.String()),
	source: Type.Optional(Type.String()),
});

const taskCreateSchema = Type.Object({
	title: Type.String(),
	description: Type.Optional(Type.String()),
	status: Type.Optional(
		Type.Union([Type.Literal("open"), Type.Literal("in_progress"), Type.Literal("done"), Type.Literal("cancelled")]),
	),
	priority: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("normal"), Type.Literal("high")])),
	sessionId: Type.Optional(Type.String()),
	session_id: Type.Optional(Type.String()),
	linearIssue: Type.Optional(Type.String()),
	linear_issue: Type.Optional(Type.String()),
});

const memoryScopeSchema = Type.Union([
	Type.Literal("user"),
	Type.Literal("dm"),
	Type.Literal("guild"),
	Type.Literal("channel"),
	Type.Literal("project"),
	Type.Literal("agent"),
]);

const memoryAtomTypeSchema = Type.Union([
	Type.Literal("preference"),
	Type.Literal("fact"),
	Type.Literal("decision"),
	Type.Literal("commitment"),
	Type.Literal("lesson"),
	Type.Literal("skill_hint"),
]);

const memorySensitivitySchema = Type.Union([
	Type.Literal("public"),
	Type.Literal("personal"),
	Type.Literal("sensitive"),
	Type.Literal("secret"),
]);

const memoryRememberSchema = Type.Object({
	scope: Type.Optional(memoryScopeSchema),
	subjectId: Type.Optional(Type.String()),
	subject_id: Type.Optional(Type.String()),
	type: Type.Optional(memoryAtomTypeSchema),
	claim: Type.String(),
	sourceEventIds: Type.Optional(Type.Array(Type.String())),
	source_event_ids: Type.Optional(Type.Array(Type.String())),
	sourceText: Type.Optional(Type.String()),
	source_text: Type.Optional(Type.String()),
	confidence: Type.Optional(Type.Number()),
	sensitivity: Type.Optional(memorySensitivitySchema),
	ttlDays: Type.Optional(Type.Number()),
	ttl_days: Type.Optional(Type.Number()),
	confirmed: Type.Optional(Type.Boolean()),
});

const memorySearchSchema = Type.Object({
	query: Type.Optional(Type.String()),
	q: Type.Optional(Type.String()),
	scope: Type.Optional(memoryScopeSchema),
	subjectId: Type.Optional(Type.String()),
	subject_id: Type.Optional(Type.String()),
	limit: Type.Optional(Type.Number()),
});

const memoryForgetSchema = Type.Object({
	id: Type.Optional(Type.String()),
	scope: Type.Optional(memoryScopeSchema),
	subjectId: Type.Optional(Type.String()),
	subject_id: Type.Optional(Type.String()),
});

const searchContextSizeSchema = Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]);
const returnTokenBudgetSchema = Type.Union([Type.Literal("default"), Type.Literal("unlimited")]);
const reasoningEffortSchema = Type.Union([
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
]);
const approximateUserLocationSchema = Type.Object({
	city: Type.Optional(Type.String()),
	region: Type.Optional(Type.String()),
	country: Type.Optional(Type.String()),
	timezone: Type.Optional(Type.String()),
});
const webSearchSchema = Type.Object({
	query: Type.String(),
	instructions: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	searchContextSize: Type.Optional(searchContextSizeSchema),
	search_context_size: Type.Optional(searchContextSizeSchema),
	allowedDomains: Type.Optional(Type.Array(Type.String())),
	allowed_domains: Type.Optional(Type.Array(Type.String())),
	blockedDomains: Type.Optional(Type.Array(Type.String())),
	blocked_domains: Type.Optional(Type.Array(Type.String())),
	externalWebAccess: Type.Optional(Type.Boolean()),
	external_web_access: Type.Optional(Type.Boolean()),
	returnTokenBudget: Type.Optional(returnTokenBudgetSchema),
	return_token_budget: Type.Optional(returnTokenBudgetSchema),
	reasoningEffort: Type.Optional(reasoningEffortSchema),
	reasoning_effort: Type.Optional(reasoningEffortSchema),
	userLocation: Type.Optional(approximateUserLocationSchema),
	user_location: Type.Optional(approximateUserLocationSchema),
});

const imageQualitySchema = Type.Union([
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("auto"),
]);
const imageOutputFormatSchema = Type.Union([Type.Literal("png"), Type.Literal("jpeg"), Type.Literal("webp")]);
const mediaAspectRatioSchema = Type.Union([
	Type.Literal("1:1"),
	Type.Literal("16:9"),
	Type.Literal("9:16"),
	Type.Literal("4:3"),
	Type.Literal("3:4"),
	Type.Literal("3:2"),
	Type.Literal("2:3"),
	Type.Literal("2:1"),
	Type.Literal("1:2"),
	Type.Literal("19.5:9"),
	Type.Literal("9:19.5"),
	Type.Literal("20:9"),
	Type.Literal("9:20"),
	Type.Literal("auto"),
]);
const openAiImageGenerateSchema = Type.Object({
	prompt: Type.String(),
	model: Type.Optional(Type.String()),
	n: Type.Optional(Type.Number()),
	size: Type.Optional(Type.String()),
	quality: Type.Optional(imageQualitySchema),
	background: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("opaque"), Type.Literal("transparent")])),
	outputFormat: Type.Optional(imageOutputFormatSchema),
	output_format: Type.Optional(imageOutputFormatSchema),
	outputCompression: Type.Optional(Type.Number()),
	output_compression: Type.Optional(Type.Number()),
	moderation: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("low")])),
	outputDir: Type.Optional(Type.String()),
	output_dir: Type.Optional(Type.String()),
	filenamePrefix: Type.Optional(Type.String()),
	filename_prefix: Type.Optional(Type.String()),
});
const xaiImageGenerateSchema = Type.Object({
	prompt: Type.String(),
	model: Type.Optional(Type.String()),
	n: Type.Optional(Type.Number()),
	aspectRatio: Type.Optional(mediaAspectRatioSchema),
	aspect_ratio: Type.Optional(mediaAspectRatioSchema),
	resolution: Type.Optional(Type.Union([Type.Literal("1k"), Type.Literal("2k")])),
	responseFormat: Type.Optional(Type.Union([Type.Literal("url"), Type.Literal("b64_json")])),
	response_format: Type.Optional(Type.Union([Type.Literal("url"), Type.Literal("b64_json")])),
	outputDir: Type.Optional(Type.String()),
	output_dir: Type.Optional(Type.String()),
	filenamePrefix: Type.Optional(Type.String()),
	filename_prefix: Type.Optional(Type.String()),
	download: Type.Optional(Type.Boolean()),
});
const xaiVideoGenerateSchema = Type.Object({
	prompt: Type.String(),
	model: Type.Optional(Type.String()),
	duration: Type.Optional(Type.Number()),
	aspectRatio: Type.Optional(mediaAspectRatioSchema),
	aspect_ratio: Type.Optional(mediaAspectRatioSchema),
	resolution: Type.Optional(Type.Union([Type.Literal("480p"), Type.Literal("720p")])),
	outputDir: Type.Optional(Type.String()),
	output_dir: Type.Optional(Type.String()),
	filenamePrefix: Type.Optional(Type.String()),
	filename_prefix: Type.Optional(Type.String()),
	download: Type.Optional(Type.Boolean()),
	pollIntervalMs: Type.Optional(Type.Number()),
	poll_interval_ms: Type.Optional(Type.Number()),
	timeoutMs: Type.Optional(Type.Number()),
	timeout_ms: Type.Optional(Type.Number()),
});
const discordListChannelsSchema = Type.Object({
	guildId: Type.Optional(Type.String()),
	guild_id: Type.Optional(Type.String()),
	since: Type.Optional(Type.String()),
	sinceTimestamp: Type.Optional(Type.String()),
	since_timestamp: Type.Optional(Type.String()),
});
const discordReadMessagesSchema = Type.Object({
	channelId: Type.Optional(Type.String()),
	channel_id: Type.Optional(Type.String()),
	limit: Type.Optional(Type.Number()),
	before: Type.Optional(Type.String()),
	after: Type.Optional(Type.String()),
	around: Type.Optional(Type.String()),
	since: Type.Optional(Type.String()),
	sinceTimestamp: Type.Optional(Type.String()),
	since_timestamp: Type.Optional(Type.String()),
	until: Type.Optional(Type.String()),
	untilTimestamp: Type.Optional(Type.String()),
	until_timestamp: Type.Optional(Type.String()),
});
const discordRecentActivitySchema = Type.Object({
	guildId: Type.Optional(Type.String()),
	guild_id: Type.Optional(Type.String()),
	since: Type.Optional(Type.String()),
	sinceTimestamp: Type.Optional(Type.String()),
	since_timestamp: Type.Optional(Type.String()),
	channelIds: Type.Optional(Type.Array(Type.String())),
	channel_ids: Type.Optional(Type.Array(Type.String())),
	channelNameQuery: Type.Optional(Type.String()),
	channel_name_query: Type.Optional(Type.String()),
	limitChannels: Type.Optional(Type.Number()),
	limit_channels: Type.Optional(Type.Number()),
	messageLimit: Type.Optional(Type.Number()),
	message_limit: Type.Optional(Type.Number()),
	includeMessages: Type.Optional(Type.Boolean()),
	include_messages: Type.Optional(Type.Boolean()),
});
const discordSendMessageSchema = Type.Object({
	channelId: Type.Optional(Type.String()),
	channel_id: Type.Optional(Type.String()),
	content: Type.Optional(Type.String()),
	replyToMessageId: Type.Optional(Type.String()),
	reply_to_message_id: Type.Optional(Type.String()),
	filePaths: Type.Optional(Type.Array(Type.String())),
	file_paths: Type.Optional(Type.Array(Type.String())),
});
const discordListEmojisSchema = Type.Object({
	guildId: Type.Optional(Type.String()),
	guild_id: Type.Optional(Type.String()),
});
const discordAddReactionSchema = Type.Object({
	channelId: Type.Optional(Type.String()),
	channel_id: Type.Optional(Type.String()),
	messageId: Type.Optional(Type.String()),
	message_id: Type.Optional(Type.String()),
	emoji: Type.String(),
});

export type ScheduleCronToolInput = Static<typeof scheduleCronSchema>;
export type LinearCreateIssueToolInput = Static<typeof linearCreateIssueSchema>;
export type LinearLinkToolInput = Static<typeof linearLinkSchema>;
export type ExternalMcpCallToolInput = Static<typeof externalMcpCallSchema>;
export type MainSessionContextToolInput = Static<typeof mainSessionContextSchema>;
export type DelegateToMainWorkerToolInput = Static<typeof delegateToMainWorkerSchema>;
export type TaskCreateToolInput = Static<typeof taskCreateSchema>;
export type MemoryRememberToolInput = Static<typeof memoryRememberSchema>;
export type MemorySearchToolInput = Static<typeof memorySearchSchema>;
export type MemoryForgetToolInput = Static<typeof memoryForgetSchema>;
export type WebSearchToolInput = Static<typeof webSearchSchema>;
export type OpenAiImageGenerateToolInput = Static<typeof openAiImageGenerateSchema>;
export type XAiImageGenerateToolInput = Static<typeof xaiImageGenerateSchema>;
export type XAiVideoGenerateToolInput = Static<typeof xaiVideoGenerateSchema>;
export type DiscordListChannelsToolInput = Static<typeof discordListChannelsSchema>;
export type DiscordReadMessagesToolInput = Static<typeof discordReadMessagesSchema>;
export type DiscordRecentActivityToolInput = Static<typeof discordRecentActivitySchema>;
export type DiscordSendMessageToolInput = Static<typeof discordSendMessageSchema>;
export type DiscordListEmojisToolInput = Static<typeof discordListEmojisSchema>;
export type DiscordAddReactionToolInput = Static<typeof discordAddReactionSchema>;

export interface ClankyBeforeProviderRequestInput {
	sessionId: string;
	payload: BeforeProviderRequestEvent["payload"];
}

export interface ClankyAgentToolHandlers {
	scheduleCron?: (input: ScheduleCronToolInput) => Promise<unknown>;
	linearCreateIssue?: (input: LinearCreateIssueInput) => Promise<unknown>;
	linearLink?: (input: CreateLinearLinkInput) => Promise<unknown>;
	externalMcpCall?: (input: ExternalMcpCallToolInput) => Promise<unknown>;
	mainSessionContext?: (input: MainSessionContextToolInput) => Promise<unknown>;
	delegateToMainWorker?: (input: DelegateToMainWorkerToolInput) => Promise<unknown>;
	taskCreate?: (input: TaskCreateToolInput) => Promise<unknown>;
	beforeProviderRequest?: (input: ClankyBeforeProviderRequestInput) => Promise<unknown | undefined>;
	indexMessage?: (input: SessionIndexMessageInput) => Promise<void>;
	memoryPacket?: (input: MemoryPacketInput) => Promise<MemoryPacket>;
	memoryRemember?: (input: RememberMemoryInput) => Promise<MemoryWriteResult>;
	memorySearch?: (input: MemorySearchOptions) => Promise<MemorySearchResult>;
	memoryForget?: (input: ForgetMemoryInput) => Promise<unknown>;
	memoryExport?: () => Promise<MemoryExport>;
	memoryConsent?: (input: SetMemoryConsentInput) => Promise<unknown>;
	selfMemory?: () => Promise<string>;
	listCron?: () => Promise<unknown>;
	externalMcpStatus?: () => Promise<unknown>;
	listSkills?: () => Promise<unknown>;
	createSkill?: (input: CreateClankySkillInput) => Promise<unknown>;
	profileStatus?: () => Promise<unknown>;
	webSearch?: (input: OpenAiWebSearchInput, signal?: AbortSignal) => Promise<unknown>;
	webBackendStatus?: () => Promise<unknown>;
	openAiImageGenerate?: (input: OpenAiImageGenerateInput, signal?: AbortSignal) => Promise<unknown>;
	xaiImageGenerate?: (input: XAiImageGenerateInput, signal?: AbortSignal) => Promise<unknown>;
	xaiVideoGenerate?: (input: XAiVideoGenerateInput, signal?: AbortSignal) => Promise<unknown>;
	mediaBackendStatus?: () => Promise<unknown>;
	listSubagents?: () => Promise<ClankySubagentSummary[]>;
	discordListGuilds?: () => Promise<unknown>;
	discordListChannels?: (input: DiscordListChannelsInput) => Promise<unknown>;
	discordReadMessages?: (input: DiscordReadMessagesInput) => Promise<unknown>;
	discordRecentActivity?: (input: DiscordRecentActivityInput) => Promise<unknown>;
	discordSendMessage?: (input: DiscordSendMessageInput) => Promise<unknown>;
	discordListEmojis?: (input: DiscordListEmojisInput) => Promise<unknown>;
	discordAddReaction?: (input: DiscordAddReactionInput) => Promise<unknown>;
}

const CLANKY_MEMORY_PACKET_MESSAGE = "clanky.memory_packet";
const WEB_OPERATOR_SKILL_NAME = "clanky-web-operator";
const MEDIA_OPERATOR_SKILL_NAME = "clanky-media-operator";
const SUBAGENT_PANEL_WIDGET_KEY = "clanky-subagents";
const SUBAGENT_PANEL_STATUS_KEY = "clanky-subagents";
const SUBAGENT_PANEL_REFRESH_MS = 2000;
const SUBAGENT_PANEL_MAX_ROWS = 7;
const SUBAGENT_BROWSER_REFRESH_MS = 2000;
const SUBAGENT_BROWSER_MAX_ROWS = 9;
const SUBAGENT_TRANSCRIPT_MAX_ROWS = 20;

export function createClankyExtensionFactories(handlers: ClankyAgentToolHandlers): ExtensionFactory[] {
	const indexMessage = handlers.indexMessage;
	const beforeProviderRequest = handlers.beforeProviderRequest;
	const memoryPacket = handlers.memoryPacket;
	const hasCommands =
		handlers.listCron !== undefined ||
		handlers.externalMcpStatus !== undefined ||
		handlers.listSkills !== undefined ||
		handlers.createSkill !== undefined ||
		handlers.memoryRemember !== undefined ||
		handlers.memorySearch !== undefined ||
		handlers.memoryForget !== undefined ||
		handlers.memoryExport !== undefined ||
		handlers.memoryConsent !== undefined ||
		handlers.selfMemory !== undefined ||
		handlers.profileStatus !== undefined ||
		handlers.webBackendStatus !== undefined ||
		handlers.mediaBackendStatus !== undefined ||
		handlers.listSubagents !== undefined;
	if (indexMessage === undefined && beforeProviderRequest === undefined && memoryPacket === undefined && !hasCommands) {
		return [];
	}
	return [
		(pi) => {
			const subagentPanel =
				handlers.listSubagents === undefined ? undefined : new SubagentPanelController(handlers.listSubagents);
			registerClankyCommands(pi, handlers, subagentPanel);
			subagentPanel?.registerLifecycle(pi);
			pi.on("input", async (event) => {
				const transformed = maybeInjectWebOperatorSkill(maybeInjectMediaOperatorSkill(event.text));
				if (transformed === event.text) return { action: "continue" };
				if (event.images !== undefined) return { action: "transform", text: transformed, images: event.images };
				return { action: "transform", text: transformed };
			});
			if (indexMessage !== undefined) {
				pi.on("message_end", async (event, ctx) => {
					const input = buildMessageIndexInput(event, ctx);
					if (input === undefined) return undefined;
					try {
						await indexMessage(input);
					} catch (error) {
						if (ctx.hasUI) {
							const message = error instanceof Error ? error.message : String(error);
							ctx.ui.notify(`Clanky session index failed: ${message}`, "warning");
						}
					}
					return undefined;
				});
			}
			if (beforeProviderRequest !== undefined) {
				pi.on("before_provider_request", async (event, ctx) => {
					return await beforeProviderRequest({
						sessionId: ctx.sessionManager.getSessionId(),
						payload: event.payload,
					});
				});
			}
			if (memoryPacket !== undefined) {
				pi.on("before_agent_start", async (event, ctx) => {
					const packet = await memoryPacket({
						sessionId: ctx.sessionManager.getSessionId(),
						prompt: event.prompt,
						cwd: ctx.cwd,
					});
					return {
						systemPrompt: appendMemoryToSystemPrompt(event.systemPrompt, packet),
						message: {
							customType: CLANKY_MEMORY_PACKET_MESSAGE,
							content: packet.text,
							display: false,
							details: {
								atomIds: packet.atoms.map((atom) => atom.id),
							},
						},
					};
				});
			}
		},
	];
}

class SubagentPanelController {
	private visible = false;
	private selectionActive = false;
	private summaries: ClankySubagentSummary[] = [];
	private selectedIndex = 0;
	private listScroll = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private pendingMetaEscapeTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingMetaEscape = false;
	private unsubscribeInput: (() => void) | undefined;
	private refreshRunning = false;
	private readonly listSubagents: () => Promise<ClankySubagentSummary[]>;

	constructor(listSubagents: () => Promise<ClankySubagentSummary[]>) {
		this.listSubagents = listSubagents;
	}

	registerLifecycle(pi: Parameters<ExtensionFactory>[0]): void {
		pi.on("session_start", async (_event, ctx) => {
			if (!ctx.hasUI) return;
			this.start(ctx);
			await this.refresh(ctx);
		});
		pi.on("session_shutdown", (_event, ctx) => {
			this.stop(ctx);
		});
	}

	async handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const command = args.trim().toLowerCase();
		if (command === "" || command === "toggle") {
			this.visible = !this.visible;
			if (!this.visible) {
				this.selectionActive = false;
				ctx.ui.setWidget(SUBAGENT_PANEL_WIDGET_KEY, undefined);
				await this.refresh(ctx);
				return;
			}
			this.selectionActive = false;
			this.start(ctx);
			await this.refresh(ctx);
			return;
		}
		if (command === "focus") {
			this.visible = true;
			this.selectionActive = true;
			this.start(ctx);
			await this.refresh(ctx);
			return;
		}
		if (command === "list") {
			this.visible = true;
			this.selectionActive = false;
			this.start(ctx);
			await this.refresh(ctx);
			return;
		}
		if (command === "chat" || command === "enter") {
			this.visible = true;
			this.start(ctx);
			await this.refresh(ctx);
			await this.openSelectedTranscript(ctx);
			return;
		}
		if (command === "modal" || command === "open" || command === "browse") {
			this.visible = true;
			this.start(ctx);
			await this.refresh(ctx);
			await this.openBrowser(ctx);
			return;
		}
		if (command === "json") {
			ctx.ui.notify(formatCommandResult("Subagents", await this.listSubagents()));
			return;
		}
		if (command === "status" || command === "once") {
			ctx.ui.notify(formatSubagentPanelLines(await this.listSubagents(), ctx, { includeEmpty: true }).join("\n"));
			return;
		}
		if (command === "hide" || command === "off") {
			this.visible = false;
			this.selectionActive = false;
			ctx.ui.setWidget(SUBAGENT_PANEL_WIDGET_KEY, undefined);
			await this.refresh(ctx);
			return;
		}
		if (command === "panel" || command === "show" || command === "on") {
			this.visible = true;
			this.selectionActive = false;
			this.start(ctx);
			await this.refresh(ctx);
			return;
		}
		ctx.ui.notify("Subagents\nUsage: /subagents [focus|chat|modal|panel|hide|status|json]", "warning");
	}

	private async openBrowser(ctx: ExtensionCommandContext): Promise<void> {
		const initialSummaries = await this.listSubagents();
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) =>
				new SubagentBrowserComponent({
					initialSummaries,
					listSubagents: this.listSubagents,
					theme,
					done,
					requestRender: () => tui.requestRender(),
				}),
			{
				overlay: true,
				overlayOptions: {
					width: "88%",
					minWidth: 72,
					maxHeight: "85%",
					anchor: "center",
					margin: 1,
				},
			},
		);
	}

	private async openSelectedTranscript(ctx: ExtensionContext): Promise<void> {
		const selected = this.selectedSummary();
		if (selected === undefined) return;
		await this.openTranscript(ctx, selected.id);
	}

	private async openTranscript(ctx: ExtensionContext, selectedId: string): Promise<void> {
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) =>
				new SubagentBrowserComponent({
					initialSummaries: this.summaries,
					listSubagents: this.listSubagents,
					theme,
					done,
					requestRender: () => tui.requestRender(),
					initialSelectedId: selectedId,
					initialMode: "detail",
					detailBackBehavior: "close",
				}),
			{
				overlay: true,
				overlayOptions: {
					width: "88%",
					minWidth: 72,
					maxHeight: "85%",
					anchor: "center",
					margin: 1,
				},
			},
		);
	}

	private start(ctx: ExtensionContext): void {
		if (this.timer !== undefined) return;
		this.unsubscribeInput = ctx.ui.onTerminalInput((data) => this.handleTerminalInput(data, ctx));
		this.timer = setInterval(() => {
			void this.refresh(ctx);
		}, SUBAGENT_PANEL_REFRESH_MS);
		this.timer.unref?.();
	}

	private stop(ctx: ExtensionContext): void {
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.clearPendingMetaEscape();
		this.unsubscribeInput?.();
		this.unsubscribeInput = undefined;
		ctx.ui.setWidget(SUBAGENT_PANEL_WIDGET_KEY, undefined);
		ctx.ui.setStatus(SUBAGENT_PANEL_STATUS_KEY, undefined);
	}

	private handleTerminalInput(data: string, ctx: ExtensionContext): { consume?: boolean; data?: string } | undefined {
		if (!this.visible) return undefined;
		if (isEscapeKey(data) && this.selectionActive) {
			this.selectionActive = false;
			this.clearPendingMetaEscape();
			this.renderPanel(ctx);
			return { consume: true };
		}
		const pendingMetaEscape = this.pendingMetaEscape;
		if (pendingMetaEscape) this.clearPendingMetaEscape();
		if (
			isSubagentPreviousKey(data) ||
			(pendingMetaEscape && isUpKey(data)) ||
			(this.selectionActive && (isUpKey(data) || data === "k"))
		) {
			this.selectionActive = true;
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.ensureSelectedVisible(SUBAGENT_PANEL_MAX_ROWS);
			this.renderPanel(ctx);
			return { consume: true };
		}
		if (
			isSubagentNextKey(data) ||
			(pendingMetaEscape && isDownKey(data)) ||
			(this.selectionActive && (isDownKey(data) || data === "j"))
		) {
			this.selectionActive = true;
			this.selectedIndex = Math.min(Math.max(0, this.summaries.length - 1), this.selectedIndex + 1);
			this.ensureSelectedVisible(SUBAGENT_PANEL_MAX_ROWS);
			this.renderPanel(ctx);
			return { consume: true };
		}
		if (isEnterKey(data) && this.selectionActive) {
			const selected = this.selectedSummary();
			if (selected !== undefined) void this.openTranscript(ctx, selected.id);
			return { consume: true };
		}
		if (data === "r" && this.selectionActive) {
			void this.refresh(ctx);
			return { consume: true };
		}
		if (isEscapeKey(data)) {
			this.setPendingMetaEscape();
			return undefined;
		}
		if (this.selectionActive) {
			this.selectionActive = false;
			this.renderPanel(ctx);
		}
		return undefined;
	}

	private setPendingMetaEscape(): void {
		this.clearPendingMetaEscape();
		this.pendingMetaEscape = true;
		this.pendingMetaEscapeTimer = setTimeout(() => {
			this.pendingMetaEscape = false;
			this.pendingMetaEscapeTimer = undefined;
		}, 50);
		this.pendingMetaEscapeTimer.unref?.();
	}

	private clearPendingMetaEscape(): void {
		if (this.pendingMetaEscapeTimer !== undefined) {
			clearTimeout(this.pendingMetaEscapeTimer);
			this.pendingMetaEscapeTimer = undefined;
		}
		this.pendingMetaEscape = false;
	}

	private async refresh(ctx: ExtensionContext): Promise<void> {
		if (this.refreshRunning) return;
		this.refreshRunning = true;
		try {
			const selectedId = this.selectedSummary()?.id;
			this.summaries = [...(await this.listSubagents())].sort(compareSubagentsForPanel);
			this.selectedIndex = resolveSelectedIndex(this.summaries, selectedId, this.selectedIndex);
			this.ensureSelectedVisible(SUBAGENT_PANEL_MAX_ROWS);
			ctx.ui.setStatus(SUBAGENT_PANEL_STATUS_KEY, formatSubagentFooterStatus(this.summaries, ctx));
			this.renderPanel(ctx);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.setStatus(SUBAGENT_PANEL_STATUS_KEY, ctx.ui.theme.fg("error", "subagents error"));
			if (this.visible) {
				ctx.ui.setWidget(
					SUBAGENT_PANEL_WIDGET_KEY,
					[ctx.ui.theme.bold("Subagents"), ctx.ui.theme.fg("error", `failed to refresh: ${message}`)],
					{ placement: "belowEditor" },
				);
			}
		} finally {
			this.refreshRunning = false;
		}
	}

	private renderPanel(ctx: ExtensionContext): void {
		if (!this.visible) {
			ctx.ui.setWidget(SUBAGENT_PANEL_WIDGET_KEY, undefined);
			return;
		}
		const lines = formatSubagentPanelLines(this.summaries, ctx, {
			includeEmpty: this.selectionActive,
			selectionActive: this.selectionActive,
			selectedIndex: this.selectedIndex,
			scroll: this.listScroll,
		});
		ctx.ui.setWidget(SUBAGENT_PANEL_WIDGET_KEY, lines.length === 0 ? undefined : lines, {
			placement: "belowEditor",
		});
	}

	private selectedSummary(): ClankySubagentSummary | undefined {
		return this.summaries[this.selectedIndex];
	}

	private ensureSelectedVisible(maxRows: number): void {
		if (this.summaries.length === 0) {
			this.selectedIndex = 0;
			this.listScroll = 0;
			return;
		}
		this.selectedIndex = Math.min(Math.max(0, this.selectedIndex), this.summaries.length - 1);
		const maxScroll = Math.max(0, this.summaries.length - maxRows);
		if (this.selectedIndex < this.listScroll) {
			this.listScroll = this.selectedIndex;
		} else if (this.selectedIndex >= this.listScroll + maxRows) {
			this.listScroll = this.selectedIndex - maxRows + 1;
		}
		this.listScroll = Math.min(Math.max(0, this.listScroll), maxScroll);
	}
}

interface SubagentTranscriptMessage {
	role: "user" | "assistant" | "tool" | "system";
	text: string;
	timestamp?: string;
}

interface SubagentBrowserOptions {
	initialSummaries: ClankySubagentSummary[];
	listSubagents: () => Promise<ClankySubagentSummary[]>;
	theme: ExtensionContext["ui"]["theme"];
	done: (result: undefined) => void;
	requestRender: () => void;
	initialSelectedId?: string;
	initialMode?: "list" | "detail";
	detailBackBehavior?: "list" | "close";
}

class SubagentBrowserComponent {
	private summaries: ClankySubagentSummary[];
	private selectedIndex = 0;
	private listScroll = 0;
	private mode: "list" | "detail" = "list";
	private detailSubagentId: string | undefined;
	private detailScroll = 0;
	private transcript: SubagentTranscriptMessage[] = [];
	private detailError: string | undefined;
	private refreshRunning = false;
	private readonly listSubagents: () => Promise<ClankySubagentSummary[]>;
	private readonly theme: ExtensionContext["ui"]["theme"];
	private readonly done: (result: undefined) => void;
	private readonly requestRender: () => void;
	private readonly timer: ReturnType<typeof setInterval>;
	private readonly detailBackBehavior: "list" | "close";

	constructor(options: SubagentBrowserOptions) {
		this.summaries = [...options.initialSummaries].sort(compareSubagentsForPanel);
		this.selectedIndex = resolveSelectedIndex(this.summaries, options.initialSelectedId, 0);
		this.listSubagents = options.listSubagents;
		this.theme = options.theme;
		this.done = options.done;
		this.requestRender = options.requestRender;
		this.mode = options.initialMode ?? "list";
		this.detailBackBehavior = options.detailBackBehavior ?? "list";
		if (this.mode === "detail") {
			this.detailSubagentId = this.selectedSummary()?.id;
			this.detailScroll = Number.MAX_SAFE_INTEGER;
		}
		this.ensureSelectedVisible();
		this.timer = setInterval(() => {
			void this.refresh();
		}, SUBAGENT_BROWSER_REFRESH_MS);
		this.timer.unref?.();
		void this.refresh();
	}

	dispose(): void {
		clearInterval(this.timer);
	}

	invalidate(): void {
		return;
	}

	handleInput(data: string): void {
		if (isEscapeKey(data) || data === "q") {
			if (this.mode === "detail") {
				if (this.detailBackBehavior === "close") {
					this.done(undefined);
					return;
				}
				this.mode = "list";
				this.detailError = undefined;
				this.requestRender();
				return;
			}
			this.done(undefined);
			return;
		}
		if (data === "r") {
			void this.refresh({ forceTranscript: true });
			return;
		}
		if (this.mode === "detail") {
			this.handleDetailInput(data);
			return;
		}
		this.handleListInput(data);
	}

	render(width: number): string[] {
		return this.mode === "detail" ? this.renderDetail(width) : this.renderList(width);
	}

	private handleListInput(data: string): void {
		if (isUpKey(data) || data === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.ensureSelectedVisible();
			this.requestRender();
			return;
		}
		if (isDownKey(data) || data === "j") {
			this.selectedIndex = Math.min(Math.max(0, this.summaries.length - 1), this.selectedIndex + 1);
			this.ensureSelectedVisible();
			this.requestRender();
			return;
		}
		if (isEnterKey(data)) {
			void this.openSelected();
		}
	}

	private handleDetailInput(data: string): void {
		if (isUpKey(data) || data === "k") {
			this.detailScroll = Math.max(0, this.detailScroll - 1);
			this.requestRender();
			return;
		}
		if (isDownKey(data) || data === "j") {
			this.detailScroll += 1;
			this.requestRender();
			return;
		}
		if (isPageUpKey(data)) {
			this.detailScroll = Math.max(0, this.detailScroll - 8);
			this.requestRender();
			return;
		}
		if (isPageDownKey(data)) {
			this.detailScroll += 8;
			this.requestRender();
			return;
		}
		if (data === "g") {
			this.detailScroll = 0;
			this.requestRender();
			return;
		}
		if (data === "G") {
			this.detailScroll = Number.MAX_SAFE_INTEGER;
			this.requestRender();
			return;
		}
		if (isBackspaceKey(data)) {
			if (this.detailBackBehavior === "close") {
				this.done(undefined);
				return;
			}
			this.mode = "list";
			this.requestRender();
		}
	}

	private async refresh(options: { forceTranscript?: boolean } = {}): Promise<void> {
		if (this.refreshRunning) return;
		this.refreshRunning = true;
		try {
			const selectedId = this.selectedSummary()?.id;
			this.summaries = [...(await this.listSubagents())].sort(compareSubagentsForPanel);
			this.selectedIndex = resolveSelectedIndex(this.summaries, selectedId, this.selectedIndex);
			this.ensureSelectedVisible();
			if (this.mode === "detail" && (options.forceTranscript === true || this.detailSubagentId !== undefined)) {
				await this.loadSelectedTranscript();
			}
		} finally {
			this.refreshRunning = false;
			this.requestRender();
		}
	}

	private async openSelected(): Promise<void> {
		const selected = this.selectedSummary();
		if (selected === undefined) return;
		this.mode = "detail";
		this.detailSubagentId = selected.id;
		this.detailScroll = Number.MAX_SAFE_INTEGER;
		await this.loadSelectedTranscript();
		this.requestRender();
	}

	private async loadSelectedTranscript(): Promise<void> {
		const selected = this.selectedSummary();
		if (selected === undefined || selected.sessionFile === undefined) {
			this.transcript = [];
			this.detailError = "No session file recorded yet.";
			return;
		}
		try {
			this.transcript = await loadSubagentTranscript(selected.sessionFile);
			this.detailError = undefined;
		} catch (error) {
			this.transcript = [];
			this.detailError = error instanceof Error ? error.message : String(error);
		}
	}

	private selectedSummary(): ClankySubagentSummary | undefined {
		if (this.mode === "detail" && this.detailSubagentId !== undefined) {
			return (
				this.summaries.find((summary) => summary.id === this.detailSubagentId) ?? this.summaries[this.selectedIndex]
			);
		}
		return this.summaries[this.selectedIndex];
	}

	private ensureSelectedVisible(): void {
		if (this.summaries.length === 0) {
			this.selectedIndex = 0;
			this.listScroll = 0;
			return;
		}
		this.selectedIndex = Math.min(Math.max(0, this.selectedIndex), this.summaries.length - 1);
		const maxScroll = Math.max(0, this.summaries.length - SUBAGENT_BROWSER_MAX_ROWS);
		if (this.selectedIndex < this.listScroll) {
			this.listScroll = this.selectedIndex;
		} else if (this.selectedIndex >= this.listScroll + SUBAGENT_BROWSER_MAX_ROWS) {
			this.listScroll = this.selectedIndex - SUBAGENT_BROWSER_MAX_ROWS + 1;
		}
		this.listScroll = Math.min(Math.max(0, this.listScroll), maxScroll);
	}

	private renderList(width: number): string[] {
		const contentWidth = Math.max(20, width - 4);
		const counts = subagentCounts(this.summaries);
		this.ensureSelectedVisible();
		const lines = [
			`Subagents  ${counts.running} running  ${counts.queued} queued  ${counts.failed} failed`,
			"Up/Down select  Enter open chat  r refresh  Esc/q close",
			"",
		];
		if (this.summaries.length === 0) {
			lines.push("No Discord subagents yet.");
		} else {
			lines.push("  state     queue  scope / active work");
			const visibleSummaries = this.summaries.slice(this.listScroll, this.listScroll + SUBAGENT_BROWSER_MAX_ROWS);
			for (const [visibleIndex, summary] of visibleSummaries.entries()) {
				const index = this.listScroll + visibleIndex;
				const selected = index === this.selectedIndex;
				const row = formatSubagentBrowserRow(summary, contentWidth - 2);
				lines.push(`${selected ? ">" : " "} ${row}`);
			}
			if (this.summaries.length > SUBAGENT_BROWSER_MAX_ROWS) {
				const end = Math.min(this.summaries.length, this.listScroll + SUBAGENT_BROWSER_MAX_ROWS);
				lines.push(`  showing ${this.listScroll + 1}-${end} of ${this.summaries.length}`);
			}
		}
		return renderPlainBox(lines, width, this.theme);
	}

	private renderDetail(width: number): string[] {
		const selected = this.selectedSummary();
		const contentWidth = Math.max(20, width - 4);
		const title = selected === undefined ? "Subagent" : `Subagent ${selected.scopeName ?? selected.scopeId}`;
		const lines = [truncatePlain(title, contentWidth), "Up/Down scroll  PgUp/PgDn page  r refresh  Esc/q back", ""];
		if (selected !== undefined) {
			lines.push(formatSubagentBrowserRow(selected, contentWidth));
			lines.push("");
		}
		if (this.detailError !== undefined) {
			lines.push(`No transcript: ${this.detailError}`);
		} else if (this.transcript.length === 0) {
			lines.push("No transcript messages yet.");
		} else {
			const rendered = renderTranscriptRows(this.transcript, contentWidth);
			const maxScroll = Math.max(0, rendered.length - SUBAGENT_TRANSCRIPT_MAX_ROWS);
			this.detailScroll = Math.min(Math.max(0, this.detailScroll), maxScroll);
			lines.push(...rendered.slice(this.detailScroll, this.detailScroll + SUBAGENT_TRANSCRIPT_MAX_ROWS));
			if (rendered.length > SUBAGENT_TRANSCRIPT_MAX_ROWS) {
				lines.push("");
				lines.push(
					`${this.detailScroll + 1}-${Math.min(rendered.length, this.detailScroll + SUBAGENT_TRANSCRIPT_MAX_ROWS)} of ${rendered.length}`,
				);
			}
		}
		return renderPlainBox(lines, width, this.theme);
	}
}

function registerClankyCommands(
	pi: Parameters<ExtensionFactory>[0],
	handlers: ClankyAgentToolHandlers,
	subagentPanel: SubagentPanelController | undefined,
): void {
	if (handlers.listCron !== undefined) {
		pi.registerCommand("cron", {
			description: "Show Clanky cron jobs",
			handler: async (_args, ctx) => {
				ctx.ui.notify(formatCommandResult("Cron", await handlers.listCron?.()));
			},
		});
	}
	if (handlers.listSkills !== undefined) {
		pi.registerCommand("skills", {
			description: "Show Clanky skills",
			handler: async (_args, ctx) => {
				ctx.ui.notify(formatCommandResult("Skills", await handlers.listSkills?.()));
			},
		});
	}
	if (handlers.listSkills !== undefined || handlers.createSkill !== undefined) {
		pi.registerCommand("skill", {
			description: "List or create Clanky skills",
			handler: async (args, ctx) => {
				const trimmed = args.trim();
				if (trimmed === "" || trimmed === "list") {
					if (handlers.listSkills === undefined) {
						ctx.ui.notify("Skill\nNo skill list handler is configured.");
						return;
					}
					ctx.ui.notify(formatCommandResult("Skill", await handlers.listSkills()));
					return;
				}
				if (trimmed.startsWith("add ")) {
					if (handlers.createSkill === undefined) {
						ctx.ui.notify("Skill\nNo skill create handler is configured.");
						return;
					}
					const [name] = trimmed.slice("add ".length).trim().split(/\s+/, 1);
					if (name === undefined || name.length === 0) {
						ctx.ui.notify("Skill\nUsage: /skill add <name>");
						return;
					}
					const skill = await handlers.createSkill({ name });
					await ctx.reload();
					ctx.ui.notify(formatCommandResult("Skill", { created: skill, invoke: `/skill:${name}` }));
					return;
				}
				ctx.ui.notify("Skill\nUsage: /skill list | /skill add <name>\nInvoke loaded skills with /skill:<name>.");
			},
		});
	}
	if (
		handlers.memorySearch !== undefined ||
		handlers.memoryRemember !== undefined ||
		handlers.memoryForget !== undefined ||
		handlers.memoryExport !== undefined ||
		handlers.memoryConsent !== undefined ||
		handlers.selfMemory !== undefined
	) {
		registerMemoryCommands(pi, handlers);
	}
	if (handlers.externalMcpStatus !== undefined) {
		pi.registerCommand("mcp", {
			description: "Show configured external Clanky MCP servers",
			handler: async (_args, ctx) => {
				ctx.ui.notify(formatCommandResult("MCP", await handlers.externalMcpStatus?.()));
			},
		});
	}
	if (handlers.profileStatus !== undefined) {
		pi.registerCommand("profile", {
			description: "Show Clanky profile paths",
			handler: async (_args, ctx) => {
				ctx.ui.notify(formatCommandResult("Profile", await handlers.profileStatus?.()));
			},
		});
	}
	if (handlers.webBackendStatus !== undefined) {
		pi.registerCommand("web", {
			description: "Show Clanky web operator backend status",
			handler: async (_args, ctx) => {
				ctx.ui.notify(formatCommandResult("Web Operator", await handlers.webBackendStatus?.()));
			},
		});
	}
	if (handlers.mediaBackendStatus !== undefined) {
		pi.registerCommand("media", {
			description: "Show Clanky media generation backend status",
			handler: async (_args, ctx) => {
				ctx.ui.notify(formatCommandResult("Media Operator", await handlers.mediaBackendStatus?.()));
			},
		});
	}
	if (handlers.listSubagents !== undefined) {
		pi.registerCommand("subagents", {
			description: "Toggle the live Clanky subagent panel",
			handler: async (args, ctx) => {
				await subagentPanel?.handleCommand(args, ctx);
			},
		});
	}
}

function formatSubagentFooterStatus(
	summaries: readonly ClankySubagentSummary[],
	ctx: ExtensionContext,
): string | undefined {
	if (summaries.length === 0) return undefined;
	const counts = subagentCounts(summaries);
	if (counts.running === 0 && counts.queued === 0 && counts.failed === 0) {
		return ctx.ui.theme.fg("dim", `subagents ${summaries.length} idle`);
	}
	const parts = [
		counts.running > 0 ? ctx.ui.theme.fg("accent", `${counts.running} running`) : undefined,
		counts.queued > 0 ? ctx.ui.theme.fg("warning", `${counts.queued} queued`) : undefined,
		counts.failed > 0 ? ctx.ui.theme.fg("error", `${counts.failed} failed`) : undefined,
	].filter((part): part is string => part !== undefined);
	return `subagents ${parts.join(" ")}`;
}

function formatSubagentPanelLines(
	summaries: readonly ClankySubagentSummary[],
	ctx: ExtensionContext,
	options: { includeEmpty?: boolean; selectionActive?: boolean; selectedIndex?: number; scroll?: number } = {},
): string[] {
	if (summaries.length === 0) {
		return options.includeEmpty === true
			? [
					ctx.ui.theme.bold(options.selectionActive === true ? "Subagents selecting" : "Subagents"),
					ctx.ui.theme.fg(
						"dim",
						options.selectionActive === true
							? "No Discord subagents yet. Esc releases selection."
							: "No Discord subagents yet.",
					),
				]
			: [];
	}
	const counts = subagentCounts(summaries);
	const ordered = [...summaries].sort(compareSubagentsForPanel);
	const lines = [
		[
			ctx.ui.theme.bold("Subagents"),
			counts.running > 0 ? ctx.ui.theme.fg("accent", `${counts.running} running`) : ctx.ui.theme.fg("dim", "0 running"),
			counts.queued > 0 ? ctx.ui.theme.fg("warning", `${counts.queued} queued`) : ctx.ui.theme.fg("dim", "0 queued"),
			counts.failed > 0 ? ctx.ui.theme.fg("error", `${counts.failed} failed`) : undefined,
		]
			.filter((part): part is string => part !== undefined)
			.join("  "),
		ctx.ui.theme.fg(
			"dim",
			options.selectionActive === true
				? "Up/Down select  Enter modal  Esc release"
				: "/subagents focus selects  /subagents hides  /subagents modal opens browser",
		),
		ctx.ui.theme.fg("dim", "state     queue  scope / active work"),
	];
	const scroll = Math.min(Math.max(0, options.scroll ?? 0), Math.max(0, ordered.length - SUBAGENT_PANEL_MAX_ROWS));
	const selectedIndex = options.selectedIndex ?? -1;
	const visible = ordered.slice(scroll, scroll + SUBAGENT_PANEL_MAX_ROWS);
	for (const [visibleIndex, subagent] of visible.entries()) {
		lines.push(
			formatSubagentPanelRow(subagent, ctx, scroll + visibleIndex === selectedIndex, options.selectionActive === true),
		);
	}
	if (ordered.length > SUBAGENT_PANEL_MAX_ROWS) {
		const end = Math.min(ordered.length, scroll + SUBAGENT_PANEL_MAX_ROWS);
		lines.push(ctx.ui.theme.fg("dim", `showing ${scroll + 1}-${end} of ${ordered.length}`));
	}
	return lines;
}

function formatSubagentPanelRow(
	subagent: ClankySubagentSummary,
	ctx: ExtensionContext,
	selected = false,
	focused = false,
): string {
	const marker = selected && focused ? ">" : subagent.state === "running" ? "*" : " ";
	const state = formatSubagentState(subagent.state, ctx);
	const queue = subagent.queueDepth > 0 ? String(subagent.queueDepth).padStart(5) : ctx.ui.theme.fg("dim", "    -");
	const scope = truncatePlain(subagent.scopeName ?? subagent.scopeId, 28);
	const summary = truncatePlain(subagent.activeSummary ?? "idle", 44);
	const age = ctx.ui.theme.fg("dim", formatRelativeAge(subagent.updatedAt));
	return `${marker} ${state} ${queue}  ${scope} - ${summary} ${age}`;
}

function formatSubagentBrowserRow(subagent: ClankySubagentSummary, width: number): string {
	const queue = subagent.queueDepth > 0 ? String(subagent.queueDepth).padStart(5) : "    -";
	const scope = truncatePlain(subagent.scopeName ?? subagent.scopeId, 24);
	const summary = truncatePlain(subagent.activeSummary ?? "idle", Math.max(12, width - 45));
	const line = `${subagent.state.padEnd(8)} ${queue}  ${scope.padEnd(24)}  ${summary}  ${formatRelativeAge(subagent.updatedAt)}`;
	return truncatePlain(line, width);
}

function formatSubagentState(state: ClankySubagentState, ctx: ExtensionContext): string {
	const label = state.padEnd(8);
	if (state === "running") return ctx.ui.theme.fg("accent", label);
	if (state === "queued") return ctx.ui.theme.fg("warning", label);
	if (state === "failed") return ctx.ui.theme.fg("error", label);
	return ctx.ui.theme.fg("dim", label);
}

function compareSubagentsForPanel(a: ClankySubagentSummary, b: ClankySubagentSummary): number {
	const priorityDelta = subagentStatePriority(b.state) - subagentStatePriority(a.state);
	if (priorityDelta !== 0) return priorityDelta;
	const queueDelta = b.queueDepth - a.queueDepth;
	if (queueDelta !== 0) return queueDelta;
	return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}

function subagentStatePriority(state: ClankySubagentState): number {
	if (state === "running") return 5;
	if (state === "queued") return 4;
	if (state === "failed") return 3;
	if (state === "stale") return 2;
	return 1;
}

function subagentCounts(summaries: readonly ClankySubagentSummary[]): {
	running: number;
	queued: number;
	failed: number;
} {
	let running = 0;
	let queued = 0;
	let failed = 0;
	for (const summary of summaries) {
		if (summary.state === "running") running += 1;
		else if (summary.state === "queued") queued += 1;
		else if (summary.state === "failed") failed += 1;
	}
	return { running, queued, failed };
}

function formatRelativeAge(timestamp: string): string {
	const ageMs = Math.max(0, Date.now() - Date.parse(timestamp));
	const seconds = Math.floor(ageMs / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

function truncatePlain(value: string, maxLength: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) return normalized;
	if (maxLength <= 3) return normalized.slice(0, maxLength);
	return `${normalized.slice(0, maxLength - 3)}...`;
}

function renderPlainBox(lines: readonly string[], width: number, theme: ExtensionContext["ui"]["theme"]): string[] {
	const boxWidth = Math.max(24, width);
	const contentWidth = Math.max(1, boxWidth - 4);
	const top = theme.fg("borderMuted", `+${"-".repeat(boxWidth - 2)}+`);
	const bottom = theme.fg("borderMuted", `+${"-".repeat(boxWidth - 2)}+`);
	const body = lines.map((line, index) => {
		const plain = truncatePlain(line, contentWidth);
		const padded = `${plain}${" ".repeat(Math.max(0, contentWidth - plain.length))}`;
		const rendered = `| ${padded} |`;
		if (index === 0) return theme.bold(rendered);
		if (index === 1) return theme.fg("dim", rendered);
		return rendered;
	});
	return [top, ...body, bottom];
}

function resolveSelectedIndex(
	summaries: readonly ClankySubagentSummary[],
	selectedId: string | undefined,
	previousIndex: number,
): number {
	if (summaries.length === 0) return 0;
	if (selectedId !== undefined) {
		const index = summaries.findIndex((summary) => summary.id === selectedId);
		if (index >= 0) return index;
	}
	return Math.min(Math.max(0, previousIndex), summaries.length - 1);
}

async function loadSubagentTranscript(sessionFile: string): Promise<SubagentTranscriptMessage[]> {
	const content = await readFile(sessionFile, "utf8");
	const entries = parseSessionEntries(content);
	return entries.flatMap((entry) => {
		if (entry.type !== "message") return [];
		return renderSessionMessageEntry(entry);
	});
}

function renderSessionMessageEntry(entry: SessionMessageEntry): SubagentTranscriptMessage[] {
	const role = entry.message.role;
	if (role === "user") {
		return [
			{
				role: "user",
				text: extractDiscordMessageFromPrompt(messageContentText(entry.message.content)),
				timestamp: entry.timestamp,
			},
		];
	}
	if (role === "assistant") {
		const messages = assistantContentMessages(entry.message.content);
		return messages.map((message) => ({ ...message, timestamp: entry.timestamp }));
	}
	return [
		{
			role: "system",
			text: messageContentText((entry.message as unknown as Record<string, unknown>).content),
			timestamp: entry.timestamp,
		},
	];
}

function assistantContentMessages(content: unknown): Array<Omit<SubagentTranscriptMessage, "timestamp">> {
	if (!Array.isArray(content)) {
		const text = messageContentText(content);
		return text.length === 0 ? [] : [{ role: "assistant", text }];
	}
	const messages: Array<Omit<SubagentTranscriptMessage, "timestamp">> = [];
	const assistantText = content
		.flatMap((part) => {
			if (!isRecord(part)) return [];
			if (part.type === "text" && typeof part.text === "string") return [part.text];
			return [];
		})
		.join("\n")
		.trim();
	if (assistantText.length > 0) messages.push({ role: "assistant", text: assistantText });
	for (const part of content) {
		if (!isRecord(part)) continue;
		if (part.type === "toolCall" && typeof part.name === "string") {
			messages.push({ role: "tool", text: `tool call: ${part.name}` });
		}
	}
	return messages;
}

function extractDiscordMessageFromPrompt(text: string): string {
	const normalized = text.trim();
	const marker = "\nMessage from ";
	const markerIndex = normalized.lastIndexOf(marker);
	const candidate = markerIndex >= 0 ? normalized.slice(markerIndex + 1) : normalized;
	const match = /^Message from ([^:\n]+):\n([\s\S]*)$/u.exec(candidate.trim());
	if (match === null) return truncatePlain(normalized, 1000);
	const sender = match[1]?.trim() ?? "unknown";
	const message = match[2]?.trim() || "(no text)";
	return `${sender}: ${message}`;
}

function messageContentText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			if (!isRecord(part)) return [];
			if (part.type === "text" && typeof part.text === "string") return [part.text];
			if (part.type === "toolCall" && typeof part.name === "string") return [`tool call: ${part.name}`];
			return [];
		})
		.join("\n")
		.trim();
}

function renderTranscriptRows(messages: readonly SubagentTranscriptMessage[], width: number): string[] {
	const rows: string[] = [];
	for (const message of messages) {
		const label = message.role === "assistant" ? "clanky" : message.role;
		const prefix = `${label}: `;
		const wrapped = wrapPlain(message.text, Math.max(10, width - prefix.length));
		if (wrapped.length === 0) rows.push(prefix);
		else {
			rows.push(`${prefix}${wrapped[0]}`);
			for (const line of wrapped.slice(1)) rows.push(`${" ".repeat(prefix.length)}${line}`);
		}
	}
	return rows;
}

function wrapPlain(text: string, width: number): string[] {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length === 0) return [];
	const words = normalized.split(" ");
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		if (current.length === 0) {
			current = word;
		} else if (current.length + 1 + word.length <= width) {
			current = `${current} ${word}`;
		} else {
			lines.push(truncatePlain(current, width));
			current = word;
		}
		while (current.length > width) {
			lines.push(current.slice(0, width));
			current = current.slice(width);
		}
	}
	if (current.length > 0) lines.push(current);
	return lines;
}

function isUpKey(data: string): boolean {
	return data === "\u001b[A";
}

function isDownKey(data: string): boolean {
	return data === "\u001b[B";
}

function isSubagentPreviousKey(data: string): boolean {
	return (
		data === "\u001b\u001b[A" ||
		data === "\u001bp" ||
		data === "\u001bOa" ||
		isModifiedArrowKey(data, "A") ||
		isModifiedKittyArrowKey(data, "57419")
	);
}

function isSubagentNextKey(data: string): boolean {
	return (
		data === "\u001b\u001b[B" ||
		data === "\u001bn" ||
		data === "\u001bOb" ||
		isModifiedArrowKey(data, "B") ||
		isModifiedKittyArrowKey(data, "57420")
	);
}

function isModifiedArrowKey(data: string, arrowCode: "A" | "B"): boolean {
	return new RegExp(`^\\u001b\\[1;(?:3|5)(?::[123])?${arrowCode}$`).test(data);
}

function isModifiedKittyArrowKey(data: string, codepoint: "57419" | "57420"): boolean {
	return new RegExp(`^\\u001b\\[${codepoint};(?:3|5)(?::[123])?u$`).test(data);
}

function isPageUpKey(data: string): boolean {
	return data === "\u001b[5~";
}

function isPageDownKey(data: string): boolean {
	return data === "\u001b[6~";
}

function isEnterKey(data: string): boolean {
	return data === "\r" || data === "\n";
}

function isEscapeKey(data: string): boolean {
	return data === "\u001b";
}

function isBackspaceKey(data: string): boolean {
	return data === "\u007f" || data === "\b";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function registerMemoryCommands(pi: Parameters<ExtensionFactory>[0], handlers: ClankyAgentToolHandlers): void {
	if (handlers.selfMemory !== undefined) {
		pi.registerCommand("who_are_you", {
			description: "Show Clanky's self memory",
			handler: async (_args, ctx) => {
				ctx.ui.notify(`Self Memory\n${await handlers.selfMemory?.()}`);
			},
		});
		pi.registerCommand("privacy", {
			description: "Show Clanky's memory privacy policy",
			handler: async (_args, ctx) => {
				ctx.ui.notify(
					"Privacy\nClanky stores source-grounded memories only when consent or explicit confirmation allows it. Personal memories require confirmation; sensitive data and secrets are rejected.",
				);
			},
		});
		pi.registerCommand("why_did_you_say_that", {
			description: "Show the latest memory packet used for a response",
			handler: async (_args, ctx) => {
				ctx.ui.notify(latestMemoryExplanation(ctx));
			},
		});
	}
	if (handlers.memorySearch !== undefined) {
		pi.registerCommand("what_do_you_remember", {
			description: "Search Clanky memory",
			handler: async (args, ctx) => {
				ctx.ui.notify(formatCommandResult("Memory", await handlers.memorySearch?.(memoryCommandSearch(args, ctx.cwd))));
			},
		});
	}
	if (handlers.memoryForget !== undefined) {
		pi.registerCommand("forget_me", {
			description: "Forget local user-scoped memories",
			handler: async (_args, ctx) => {
				ctx.ui.notify(
					formatCommandResult("Forget Me", await handlers.memoryForget?.({ scope: "user", subjectId: "local" })),
				);
			},
		});
		pi.registerCommand("forget_this_channel", {
			description: "Forget memories for a channel subject id",
			handler: async (args, ctx) => {
				const subjectId = args.trim();
				if (subjectId.length === 0) {
					ctx.ui.notify("Forget Channel\nUsage: /forget_this_channel <channel-id>");
					return;
				}
				ctx.ui.notify(
					formatCommandResult("Forget Channel", await handlers.memoryForget?.({ scope: "channel", subjectId })),
				);
			},
		});
	}
	pi.registerCommand("memory", {
		description: "View, remember, forget, export, or configure Clanky memory",
		handler: async (args, ctx) => {
			ctx.ui.notify(await runMemoryCommand(args, ctx, handlers));
		},
	});
	if (handlers.memoryExport !== undefined) {
		pi.registerCommand("memory_export", {
			description: "Export Clanky memory",
			handler: async (_args, ctx) => {
				ctx.ui.notify(formatCommandResult("Memory Export", await handlers.memoryExport?.()));
			},
		});
	}
	if (handlers.memoryConsent !== undefined) {
		pi.registerCommand("memory_off", {
			description: "Disable local user memory",
			handler: async (_args, ctx) => {
				ctx.ui.notify(
					formatCommandResult(
						"Memory Off",
						await handlers.memoryConsent?.({ scope: "user", subjectId: "local", enabled: false }),
					),
				);
			},
		});
	}
}

async function runMemoryCommand(
	args: string,
	ctx: ExtensionCommandContext,
	handlers: ClankyAgentToolHandlers,
): Promise<string> {
	const trimmed = args.trim();
	if (trimmed === "" || trimmed === "view") {
		if (handlers.memorySearch === undefined) return "Memory\nNo memory search handler is configured.";
		return formatCommandResult("Memory", await handlers.memorySearch(memoryCommandSearch("", ctx.cwd)));
	}
	if (trimmed.startsWith("view ")) {
		if (handlers.memorySearch === undefined) return "Memory\nNo memory search handler is configured.";
		return formatCommandResult("Memory", await handlers.memorySearch(memoryCommandSearch(trimmed.slice(5), ctx.cwd)));
	}
	if (trimmed.startsWith("remember ")) {
		if (handlers.memoryRemember === undefined) return "Memory\nNo memory remember handler is configured.";
		const claim = trimmed.slice("remember ".length).trim();
		if (claim.length === 0) return "Memory\nUsage: /memory remember <claim>";
		return formatCommandResult(
			"Memory",
			await handlers.memoryRemember({
				scope: "project",
				subjectId: ctx.cwd,
				type: "fact",
				claim,
				confirmed: true,
				source: {
					scope: "project",
					subjectId: ctx.cwd,
					source: "manual",
					text: claim,
				},
			}),
		);
	}
	if (trimmed.startsWith("forget ")) {
		if (handlers.memoryForget === undefined) return "Memory\nNo memory forget handler is configured.";
		const id = trimmed.slice("forget ".length).trim();
		if (id.length === 0) return "Memory\nUsage: /memory forget <memory-id>";
		return formatCommandResult("Memory", await handlers.memoryForget({ id }));
	}
	if (trimmed === "export") {
		if (handlers.memoryExport === undefined) return "Memory\nNo memory export handler is configured.";
		return formatCommandResult("Memory Export", await handlers.memoryExport());
	}
	if (trimmed === "off") {
		if (handlers.memoryConsent === undefined) return "Memory\nNo memory consent handler is configured.";
		return formatCommandResult(
			"Memory",
			await handlers.memoryConsent({ scope: "user", subjectId: "local", enabled: false }),
		);
	}
	if (trimmed === "on") {
		if (handlers.memoryConsent === undefined) return "Memory\nNo memory consent handler is configured.";
		return formatCommandResult(
			"Memory",
			await handlers.memoryConsent({ scope: "user", subjectId: "local", enabled: true, mode: "dm" }),
		);
	}
	return "Memory\nUsage: /memory view [query] | remember <claim> | forget <id> | export | on | off";
}

function buildMessageIndexInput(
	event: ClankyMessageEndEvent,
	ctx: ExtensionContext,
): SessionIndexMessageInput | undefined {
	const extracted = extractIndexableMessageText(event.message);
	if (extracted === undefined) return undefined;
	const entry = ctx.sessionManager.getLeafEntry();
	const input: SessionIndexMessageInput = {
		sessionId: ctx.sessionManager.getSessionId(),
		role: extracted.role,
		text: extracted.text,
		cwd: ctx.cwd,
		createdAt: entry?.type === "message" ? entry.timestamp : messageTimestamp(event.message),
	};
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (sessionFile !== undefined) input.sessionFile = sessionFile;
	if (entry?.type === "message") input.messageKey = `${input.sessionId}:${entry.id}`;
	return input;
}

function messageTimestamp(message: ClankyMessageEndEvent["message"]): string {
	if (typeof message === "object" && message !== null && "timestamp" in message) {
		const timestamp = message.timestamp;
		if (typeof timestamp === "number" && Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
	}
	return new Date().toISOString();
}

export function createClankyToolDefinitions(handlers: ClankyAgentToolHandlers): ToolDefinition[] {
	const tools: ToolDefinition[] = [];
	const scheduleCron = handlers.scheduleCron;
	if (scheduleCron !== undefined) {
		tools.push(
			defineTool({
				name: "schedule_cron",
				label: "Schedule Cron",
				description: "Create a Clanky cron job for a prompt that should run later or on a schedule.",
				promptSnippet: "schedule_cron: schedule a prompt to run later or repeatedly through the Clanky daemon.",
				promptGuidelines: [
					"Set provider/model only when the user asks for a specific model for the scheduled cron prompt.",
				],
				parameters: scheduleCronSchema,
				async execute(_toolCallId, params) {
					return toolResult(await scheduleCron(normalizeScheduleCronToolInput(params)));
				},
			}),
		);
	}
	const linearLink = handlers.linearLink;
	const linearCreateIssue = handlers.linearCreateIssue;
	const externalMcpCall = handlers.externalMcpCall;
	if (externalMcpCall !== undefined) {
		tools.push(
			defineTool({
				name: "mcp_call",
				label: "MCP Call",
				description: "Call a tool on an external MCP server configured in the Clanky daemon.",
				promptSnippet: "mcp_call: call a configured external MCP server tool by server and tool name.",
				promptGuidelines: [
					"Use mcp_call only for MCP servers listed in Clanky status or the /mcp command.",
					"Pass arguments as a JSON object matching the target tool schema.",
				],
				parameters: externalMcpCallSchema,
				async execute(_toolCallId, params) {
					return toolResult(await externalMcpCall(params));
				},
			}),
		);
	}
	if (linearCreateIssue !== undefined) {
		tools.push(
			defineTool({
				name: "linear_create_issue",
				label: "Linear Create Issue",
				description: "Create a Linear issue in a known team using configured Linear credentials.",
				promptSnippet: "linear_create_issue: create a Linear issue when new tracked work needs to be filed.",
				promptGuidelines: [
					"Use linear_link after creating an issue if the current Clanky session should stay bound to it.",
				],
				parameters: linearCreateIssueSchema,
				async execute(_toolCallId, params) {
					return toolResult(await linearCreateIssue(normalizeLinearCreateIssueToolInput(params)));
				},
			}),
		);
	}
	if (linearLink !== undefined) {
		tools.push(
			defineTool({
				name: "linear_link",
				label: "Linear Link",
				description: "Persist a link between a Linear issue and a Clanky session or task.",
				promptSnippet: "linear_link: bind a Linear issue to the current session or a task.",
				parameters: linearLinkSchema,
				async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
					const input = normalizeLinearLinkToolInput(params, ctx.sessionManager.getSessionId());
					return toolResult(await linearLink(input));
				},
			}),
		);
	}
	const taskCreate = handlers.taskCreate;
	if (taskCreate !== undefined) {
		tools.push(
			defineTool({
				name: "task_create",
				label: "Task Create",
				description: "Create a lightweight Clanky task record tied to the current session and optional Linear issue.",
				promptSnippet: "task_create: record a local Clanky task for follow-up or lightweight work tracking.",
				parameters: taskCreateSchema,
				async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
					const input = normalizeTaskCreateToolInput(params, ctx.sessionManager.getSessionId());
					return toolResult(await taskCreate(input));
				},
			}),
		);
	}
	const mainSessionContext = handlers.mainSessionContext;
	if (mainSessionContext !== undefined) {
		tools.push(
			defineTool({
				name: "main_session_context",
				label: "Main Session Context",
				description:
					"Read bounded recent history from the main Clanky session so a Discord subagent can understand what the foreground agent has been doing.",
				promptSnippet:
					"main_session_context: read the main Clanky session history when the Discord subagent needs more than the startup status snapshot.",
				promptGuidelines: [
					"Use when the user asks what the main agent has been doing or when the Discord answer depends on deeper main-session context.",
					"Do not reveal unrelated private main-session details into Discord; use the context to stay accurate and concise.",
					"Increase limit or include_tool_results only when the first result is not enough.",
				],
				parameters: mainSessionContextSchema,
				async execute(_toolCallId, params) {
					return toolResult(await mainSessionContext(params));
				},
			}),
		);
	}
	const delegateToMainWorker = handlers.delegateToMainWorker;
	if (delegateToMainWorker !== undefined) {
		tools.push(
			defineTool({
				name: "delegate_to_main_worker",
				label: "Delegate To Main Worker",
				description:
					"Hand off durable or long-running work from a Discord subagent to the main Clanky worker without blocking the Discord reply loop.",
				promptSnippet:
					"delegate_to_main_worker: hand off work likely to take more than a minute or two, then reply briefly in Discord.",
				promptGuidelines: [
					"Use when a Discord request needs coding, deep research, multi-step operations, or other work likely to take more than 1-2 minutes.",
					"Include enough context in prompt for the main worker to proceed without rereading the Discord conversation.",
					"After delegating, tell the Discord user that the main worker has picked it up; do not also do the long task yourself.",
				],
				parameters: delegateToMainWorkerSchema,
				async execute(_toolCallId, params) {
					return toolResult(await delegateToMainWorker(params));
				},
			}),
		);
	}
	const listSubagents = handlers.listSubagents;
	if (listSubagents !== undefined) {
		tools.push(
			defineTool({
				name: "subagent_status",
				label: "Subagent Status",
				description:
					"Inspect Clanky's Discord subagent workers, including queue depth, active work, session files, and errors.",
				promptSnippet:
					"subagent_status: check Clanky's Discord subagent workers before reading sqlite files or shelling out.",
				promptGuidelines: [
					"Use when the user asks what a subagent is doing, whether Discord workers are healthy, or if a queue is stuck.",
					"Summarize state, queue depth, active work, age, and lastError if present.",
				],
				parameters: Type.Object({}),
				async execute() {
					return toolResult(await listSubagents());
				},
			}),
		);
	}
	const memoryRemember = handlers.memoryRemember;
	if (memoryRemember !== undefined) {
		tools.push(
			defineTool({
				name: "memory_remember",
				label: "Memory Remember",
				description: "Store a source-grounded Clanky memory atom when policy and user confirmation allow it.",
				promptSnippet:
					"memory_remember: save an explicit preference, fact, decision, commitment, lesson, or skill hint.",
				promptGuidelines: [
					"Use only when the user explicitly asks you to remember something or confirms a proposed memory.",
					"Do not store secrets, credentials, sensitive traits, relationship inferences, or unsupported guesses.",
					"Set confirmed=true only when the user explicitly asked for the memory to be saved.",
				],
				parameters: memoryRememberSchema,
				async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
					return toolResult(await memoryRemember(normalizeMemoryRememberToolInput(params, ctx.cwd)));
				},
			}),
		);
	}
	const memorySearch = handlers.memorySearch;
	if (memorySearch !== undefined) {
		tools.push(
			defineTool({
				name: "memory_search",
				label: "Memory Search",
				description: "Search source-grounded Clanky memory atoms for the current profile.",
				promptSnippet: "memory_search: retrieve relevant memories before claiming recall.",
				parameters: memorySearchSchema,
				async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
					return toolResult(await memorySearch(normalizeMemorySearchToolInput(params, ctx.cwd)));
				},
			}),
		);
	}
	const memoryForget = handlers.memoryForget;
	if (memoryForget !== undefined) {
		tools.push(
			defineTool({
				name: "memory_forget",
				label: "Memory Forget",
				description: "Delete a Clanky memory atom by id or clear a subject scope.",
				promptSnippet: "memory_forget: remove memories when the user asks to forget or correct them.",
				parameters: memoryForgetSchema,
				async execute(_toolCallId, params) {
					return toolResult(await memoryForget(normalizeMemoryForgetToolInput(params)));
				},
			}),
		);
	}
	const webSearch = handlers.webSearch;
	if (webSearch !== undefined) {
		tools.push(
			defineTool({
				name: "web_search",
				label: "Web Search",
				description:
					"Use OpenAI hosted web search for current public information, prices, recent facts, documentation, and source-backed lookup answers.",
				promptSnippet:
					"web_search: use OpenAI hosted web search for current facts, pricing, documentation lookup, and source-backed answers.",
				promptGuidelines: [
					"When a user asks to look up, search, verify, price, or get current public information, call web_search instead of hand-rolling search scraping.",
					"Use allowed_domains or blocked_domains when the user asks for specific sources or domains.",
					"For visual layout, login, screenshots, or interaction, use the web operator skill and browser CLIs instead of forcing web_search.",
				],
				parameters: webSearchSchema,
				async execute(_toolCallId, params, signal) {
					return toolResult(await webSearch(params, signal));
				},
			}),
		);
	}
	const webBackendStatus = handlers.webBackendStatus;
	if (webBackendStatus !== undefined) {
		tools.push(
			defineTool({
				name: "web_backend_status",
				label: "Web Backend Status",
				description:
					"Inspect which Clanky web operator backends are available: OpenAI web search, agent-browser, Playwright CLI, Chrome CDP, and Node fetch.",
				promptSnippet:
					"web_backend_status: check available web operator backends before choosing agent-browser, Playwright, Chrome CDP, or OpenAI web search.",
				parameters: Type.Object({}),
				async execute() {
					return toolResult(await webBackendStatus());
				},
			}),
		);
	}
	const openAiImageGenerate = handlers.openAiImageGenerate;
	if (openAiImageGenerate !== undefined) {
		tools.push(
			defineTool({
				name: "openai_image_generate",
				label: "OpenAI Image",
				description: "Generate still images through the OpenAI Images API and save returned images to local files.",
				promptSnippet:
					"openai_image_generate: create images with OpenAI gpt-image models when the user asks for generated still images or assets.",
				promptGuidelines: [
					"Use for single-prompt still image creation with OpenAI models such as gpt-image-2.",
					"Use output_dir or filename_prefix when the user cares where the generated asset lands.",
					"For xAI Grok Imagine images, use xai_image_generate instead.",
				],
				parameters: openAiImageGenerateSchema,
				async execute(_toolCallId, params, signal) {
					return toolResult(await openAiImageGenerate(params, signal));
				},
			}),
		);
	}
	const xaiImageGenerate = handlers.xaiImageGenerate;
	if (xaiImageGenerate !== undefined) {
		tools.push(
			defineTool({
				name: "xai_image_generate",
				label: "xAI Image",
				description:
					"Generate still images through xAI Grok Imagine image models and save returned images or downloaded URLs to local files.",
				promptSnippet:
					"xai_image_generate: create images with xAI Grok Imagine when the user asks for Grok/xAI/Imagine images.",
				promptGuidelines: [
					"Use for Grok Imagine still image requests, especially when aspect_ratio or 1k/2k resolution controls are requested.",
					"Default response_format is b64_json so temporary xAI URLs are not lost.",
				],
				parameters: xaiImageGenerateSchema,
				async execute(_toolCallId, params, signal) {
					return toolResult(await xaiImageGenerate(params, signal));
				},
			}),
		);
	}
	const xaiVideoGenerate = handlers.xaiVideoGenerate;
	if (xaiVideoGenerate !== undefined) {
		tools.push(
			defineTool({
				name: "xai_video_generate",
				label: "xAI Video",
				description:
					"Generate videos through xAI Grok Imagine video models, poll until complete, and optionally download the video.",
				promptSnippet:
					"xai_video_generate: create videos with xAI Grok Imagine when the user asks for generated video, animation, or text-to-video.",
				promptGuidelines: [
					"Use for Grok Imagine video requests. Duration must be 1-15 seconds.",
					"Use 480p for faster drafts and 720p when the user wants HD output.",
					"Tell the user if generation returns failed, expired, or times out.",
				],
				parameters: xaiVideoGenerateSchema,
				async execute(_toolCallId, params, signal) {
					return toolResult(await xaiVideoGenerate(params, signal));
				},
			}),
		);
	}
	const mediaBackendStatus = handlers.mediaBackendStatus;
	if (mediaBackendStatus !== undefined) {
		tools.push(
			defineTool({
				name: "media_backend_status",
				label: "Media Backend Status",
				description:
					"Inspect which media generation backends are configured: OpenAI Images, xAI Grok Imagine images, and xAI Grok Imagine videos.",
				promptSnippet: "media_backend_status: check OpenAI/xAI media generation credentials and default models.",
				parameters: Type.Object({}),
				async execute() {
					return toolResult(await mediaBackendStatus());
				},
			}),
		);
	}
	const discordListGuilds = handlers.discordListGuilds;
	if (discordListGuilds !== undefined) {
		tools.push(
			defineTool({
				name: "discord_list_guilds",
				label: "Discord Guilds",
				description: "List Discord guilds/servers visible to Clanky's agent-owned Discord credential.",
				promptSnippet: "discord_list_guilds: inspect available Discord servers before reading or sending to a channel.",
				parameters: Type.Object({}),
				async execute() {
					return toolResult(await discordListGuilds());
				},
			}),
		);
	}
	const discordListChannels = handlers.discordListChannels;
	if (discordListChannels !== undefined) {
		tools.push(
			defineTool({
				name: "discord_list_channels",
				label: "Discord Channels",
				description:
					"List channels in a Discord guild/server by guild id, including last-message metadata when available.",
				promptSnippet:
					"discord_list_channels: find channel ids and lastMessageAt metadata before reading, sending, uploading, or reacting.",
				parameters: discordListChannelsSchema,
				async execute(_toolCallId, params) {
					return toolResult(await discordListChannels(params));
				},
			}),
		);
	}
	const discordReadMessages = handlers.discordReadMessages;
	if (discordReadMessages !== undefined) {
		tools.push(
			defineTool({
				name: "discord_read_messages",
				label: "Discord Read",
				description:
					"Read recent messages from a Discord channel visible to Clanky's agent-owned Discord credential, optionally filtered by time window.",
				promptSnippet:
					"discord_read_messages: read a bounded set of recent Discord messages from a channel, optionally using since/until for time-window questions.",
				parameters: discordReadMessagesSchema,
				async execute(_toolCallId, params) {
					return toolResult(await discordReadMessages(params));
				},
			}),
		);
	}
	const discordRecentActivity = handlers.discordRecentActivity;
	if (discordRecentActivity !== undefined) {
		tools.push(
			defineTool({
				name: "discord_recent_activity",
				label: "Discord Recent Activity",
				description:
					"Summarize active Discord channels in a guild within a recent time window, including recent messages and top participants.",
				promptSnippet:
					"discord_recent_activity: answer questions like what happened recently, what's active, or give me a guild/channel digest.",
				promptGuidelines: [
					"Use when the user asks what happened recently in a Discord server or wants a digest instead of raw channel IDs.",
					"Default since to a recent window such as 24h or 7d when the user says recently and does not specify a range.",
					"Prefer this over manually reading many channels when you only need active channels and recent context.",
				],
				parameters: discordRecentActivitySchema,
				async execute(_toolCallId, params) {
					return toolResult(await discordRecentActivity(params));
				},
			}),
		);
	}
	const discordSendMessage = handlers.discordSendMessage;
	if (discordSendMessage !== undefined) {
		tools.push(
			defineTool({
				name: "discord_send_message",
				label: "Discord Send",
				description: "Send a Discord message and optionally upload local file attachments to a channel.",
				promptSnippet: "discord_send_message: send user-approved messages or upload generated local files to Discord.",
				promptGuidelines: [
					"Use Clanky's agent-owned Discord credential only; never use AgentRoom room connector tokens.",
					"Confirm before sending sensitive files, high-impact messages, or messages to ambiguous channels.",
				],
				parameters: discordSendMessageSchema,
				async execute(_toolCallId, params) {
					return toolResult(await discordSendMessage(params));
				},
			}),
		);
	}
	const discordListEmojis = handlers.discordListEmojis;
	if (discordListEmojis !== undefined) {
		tools.push(
			defineTool({
				name: "discord_list_emojis",
				label: "Discord Emojis",
				description: "List custom reaction emojis available in a Discord guild/server.",
				promptSnippet: "discord_list_emojis: discover server emoji reaction strings such as name:id before reacting.",
				parameters: discordListEmojisSchema,
				async execute(_toolCallId, params) {
					return toolResult(await discordListEmojis(params));
				},
			}),
		);
	}
	const discordAddReaction = handlers.discordAddReaction;
	if (discordAddReaction !== undefined) {
		tools.push(
			defineTool({
				name: "discord_add_reaction",
				label: "Discord React",
				description: "Add a Unicode or server custom emoji reaction to a Discord message.",
				promptSnippet:
					"discord_add_reaction: react to a Discord message; use discord_list_emojis first for server custom emojis.",
				parameters: discordAddReactionSchema,
				async execute(_toolCallId, params) {
					return toolResult(await discordAddReaction(params));
				},
			}),
		);
	}
	return tools;
}

export function maybeInjectWebOperatorSkill(text: string, env: NodeJS.ProcessEnv = process.env): string {
	if (env.CLANKY_WEB_OPERATOR_AUTO_SKILL === "0" || env.CLANKY_WEB_OPERATOR_AUTO_SKILL === "false") return text;
	const trimmed = text.trimStart();
	if (trimmed.length === 0) return text;
	if (trimmed.startsWith("/")) return text;
	if (trimmed.includes(`<skill name="${WEB_OPERATOR_SKILL_NAME}"`)) return text;
	if (!shouldUseWebOperatorSkill(trimmed)) return text;
	return `/skill:${WEB_OPERATOR_SKILL_NAME} ${text}`;
}

export function maybeInjectMediaOperatorSkill(text: string, env: NodeJS.ProcessEnv = process.env): string {
	if (env.CLANKY_MEDIA_OPERATOR_AUTO_SKILL === "0" || env.CLANKY_MEDIA_OPERATOR_AUTO_SKILL === "false") return text;
	const trimmed = text.trimStart();
	if (trimmed.length === 0) return text;
	if (trimmed.startsWith("/")) return text;
	if (trimmed.includes(`<skill name="${MEDIA_OPERATOR_SKILL_NAME}"`)) return text;
	if (!shouldUseMediaOperatorSkill(trimmed)) return text;
	return `/skill:${MEDIA_OPERATOR_SKILL_NAME} ${text}`;
}

export function shouldUseWebOperatorSkill(text: string): boolean {
	const normalized = text.toLowerCase();
	if (/\bhttps?:\/\/|\bwww\./i.test(text)) return true;
	if (/\b(look\s*up|lookup|google|browse|navigate|visit|screenshot|screen\s*shot)\b/i.test(text)) return true;
	if (/\b(open|inspect|read|extract)\b.{0,40}\b(site|page|website|webpage|url)\b/i.test(text)) return true;
	if (
		/\b(search|find)\b.{0,30}\b(web|internet|online|site|page|price|pricing|cost|subscription|docs?|documentation)\b/i.test(
			text,
		)
	) {
		return true;
	}
	if (/\b(latest|current|up[- ]to[- ]date|today|recent|newest|pricing|price|cost|subscription)\b/i.test(text)) {
		return true;
	}
	if (normalized.includes("what does") && /\b(cost|price)\b/i.test(text)) return true;
	return false;
}

export function shouldUseMediaOperatorSkill(text: string): boolean {
	if (/\b(grok\s+imagine|xai\s+imagine|openai\s+image|gpt-image)\b/i.test(text)) return true;
	if (
		/\b(text[- ]to[- ]video|image[- ]to[- ]video|generate\s+a\s+video|make\s+a\s+video|create\s+a\s+video)\b/i.test(
			text,
		)
	) {
		return true;
	}
	if (
		/\b(generate|create|make|draw|render|design|imagine)\b.{0,50}\b(image|picture|photo|illustration|art|logo|icon|banner|thumbnail|poster|video|animation|clip)\b/i.test(
			text,
		)
	) {
		return true;
	}
	if (
		/\b(image|picture|photo|illustration|logo|icon|banner|thumbnail|poster)\b.{0,30}\b(generate|create|make|draw|render|design)\b/i.test(
			text,
		)
	) {
		return true;
	}
	return false;
}

function appendMemoryToSystemPrompt(systemPrompt: string, packet: MemoryPacket): string {
	const sections = [
		systemPrompt,
		"<clanky_self_memory>",
		packet.self.trim(),
		"</clanky_self_memory>",
		"<clanky_retrieved_memory>",
		packet.text,
		"</clanky_retrieved_memory>",
	];
	return sections.filter((section) => section.trim().length > 0).join("\n\n");
}

function memoryCommandSearch(args: string, cwd: string): MemorySearchOptions {
	const query = args.trim();
	const options: MemorySearchOptions = {
		scope: "project",
		subjectId: cwd,
		limit: 12,
	};
	if (query.length > 0) options.query = query;
	return options;
}

function formatCommandResult(title: string, details: unknown): string {
	return `${title}\n${JSON.stringify(details ?? null, null, "\t")}`;
}

function latestMemoryExplanation(ctx: ExtensionCommandContext): string {
	const entries = ctx.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom_message" || entry.customType !== CLANKY_MEMORY_PACKET_MESSAGE) continue;
		return [
			"Why",
			"I answered from the active system prompt, the current conversation, tool results, and this retrieved memory packet. Memories are source-grounded claims, not instructions.",
			"",
			typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content, null, "\t"),
		].join("\n");
	}
	return "Why\nNo retrieved memory packet is recorded for the current session yet.";
}

function normalizeScheduleCronToolInput(input: ScheduleCronToolInput): ScheduleCronToolInput {
	const output: ScheduleCronToolInput = { ...input };
	if (output.timeoutSeconds === undefined && input.timeout_seconds !== undefined) {
		output.timeoutSeconds = input.timeout_seconds;
	}
	if (output.idempotencyKey === undefined && input.idempotency_key !== undefined) {
		output.idempotencyKey = input.idempotency_key;
	}
	return output;
}

function normalizeLinearCreateIssueToolInput(input: LinearCreateIssueToolInput): LinearCreateIssueInput {
	const teamId = input.teamId ?? input.team_id;
	if (teamId === undefined || teamId.trim().length === 0) {
		throw new Error("linear_create_issue requires teamId or team_id");
	}
	const output: LinearCreateIssueInput = { teamId, title: input.title };
	if (input.description !== undefined) output.description = input.description;
	const assigneeId = input.assigneeId ?? input.assignee_id;
	if (assigneeId !== undefined) output.assigneeId = assigneeId;
	const projectId = input.projectId ?? input.project_id;
	if (projectId !== undefined) output.projectId = projectId;
	const stateId = input.stateId ?? input.state_id;
	if (stateId !== undefined) output.stateId = stateId;
	if (input.priority !== undefined) output.priority = input.priority;
	const labelIds = input.labelIds ?? input.label_ids;
	if (labelIds !== undefined) output.labelIds = labelIds;
	return output;
}

function normalizeLinearLinkToolInput(input: LinearLinkToolInput, defaultSessionId: string): CreateLinearLinkInput {
	const issueId = input.issueId ?? input.issue_id;
	if (issueId === undefined || issueId.trim().length === 0) {
		throw new Error("linear_link requires issueId or issue_id");
	}
	const output: CreateLinearLinkInput = { issueId };
	const sessionId = input.sessionId ?? input.session_id;
	const taskId = input.taskId ?? input.task_id;
	if (sessionId !== undefined) output.sessionId = sessionId;
	if (taskId !== undefined) output.taskId = taskId;
	if (output.sessionId === undefined && output.taskId === undefined) output.sessionId = defaultSessionId;
	if (input.note !== undefined) output.note = input.note;
	return output;
}

function normalizeTaskCreateToolInput(input: TaskCreateToolInput, defaultSessionId: string): TaskCreateToolInput {
	const output: TaskCreateToolInput = { ...input };
	if (output.sessionId === undefined) output.sessionId = input.session_id ?? defaultSessionId;
	if (output.linearIssue === undefined && input.linear_issue !== undefined) output.linearIssue = input.linear_issue;
	return output;
}

function normalizeMemoryRememberToolInput(input: MemoryRememberToolInput, cwd: string): RememberMemoryInput {
	const subjectId = input.subjectId ?? input.subject_id ?? cwd;
	const output: RememberMemoryInput = {
		scope: input.scope ?? "project",
		subjectId,
		type: input.type ?? "fact",
		claim: input.claim,
	};
	if (input.confirmed !== undefined) output.confirmed = input.confirmed;
	const sourceEventIds = input.sourceEventIds ?? input.source_event_ids;
	if (sourceEventIds !== undefined) output.sourceEventIds = sourceEventIds;
	const sourceText = input.sourceText ?? input.source_text ?? input.claim;
	if (sourceText !== undefined) {
		output.source = {
			scope: output.scope ?? "project",
			subjectId,
			source: "agent",
			text: sourceText,
		};
	}
	if (input.confidence !== undefined) output.confidence = input.confidence;
	if (input.sensitivity !== undefined) output.sensitivity = input.sensitivity;
	const ttlDays = input.ttlDays ?? input.ttl_days;
	if (ttlDays !== undefined) output.ttlDays = ttlDays;
	return output;
}

function normalizeMemorySearchToolInput(input: MemorySearchToolInput, cwd: string): MemorySearchOptions {
	const output: MemorySearchOptions = {
		scope: input.scope ?? "project",
		subjectId: input.subjectId ?? input.subject_id ?? cwd,
	};
	const query = input.query ?? input.q;
	if (query !== undefined) output.query = query;
	if (input.limit !== undefined) output.limit = input.limit;
	return output;
}

function normalizeMemoryForgetToolInput(input: MemoryForgetToolInput): ForgetMemoryInput {
	const output: ForgetMemoryInput = {};
	if (input.id !== undefined) output.id = input.id;
	if (input.scope !== undefined) output.scope = input.scope;
	const subjectId = input.subjectId ?? input.subject_id;
	if (subjectId !== undefined) output.subjectId = subjectId;
	return output;
}

function toolResult(details: unknown): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: JSON.stringify(details ?? null, null, "\t") }],
		details,
	};
}
