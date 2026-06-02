import {
	browserBack,
	browserClick,
	browserCloseTab,
	browserDoubleClick,
	browserDrag,
	browserEval,
	browserFill,
	browserForward,
	browserHover,
	browserKey,
	browserListTabs,
	browserNavigate,
	browserOpenTab,
	browserQuery,
	browserReadText,
	browserReload,
	browserScreenshot,
	browserScroll,
	browserType,
	browserWait,
	browserWaitFor,
} from "@clanky/browser-bridge";
import {
	type ClankyAgentToolHandlers,
	type ClankyPaths,
	callExternalMcpTool,
	createProfileSkill,
	type DelegateToMainWorkerToolInput,
	generateOpenAiImage,
	generateXAiImage,
	generateXAiVideo,
	getExternalMcpStatus,
	getMediaBackendStatus,
	getWebBackendStatus,
	listExternalMcpTools,
	loadClankySkills,
	type MainAgentActivityToolInput,
	type MainAgentCancelToolInput,
	type MainSessionContextToolInput,
	resolveClankyChatGatewayOwner,
	resolveClankyChatMode,
	runOpenAiWebSearch,
	type SendSubagentMessageInput,
	type SendSubagentMessageResult,
	sendDiscordMessage,
	shouldStartAgentChatGateway,
} from "@clanky/core";
import type { AuthStorage } from "@earendil-works/pi-coding-agent";
import type { ClankyStores } from "./stores.ts";

/**
 * Build the agent-tool handlers wired against standalone clanky stores.
 *
 * Phase 1: only the gateway-uncoupled handlers are wired up:
 *
 * - memory.* (packet, remember, search, forget, export, consent, self)
 * - profileStatus
 * - listSkills + createSkill
 * - workTrackerLink for provider-neutral refs after tracker MCP/CLI/skill use
 * - beforeProviderRequest (passthrough so the logging extension hook fires)
 *
 * Intentionally omitted (defer to a later phase):
 *
 * - externalMcpCall / externalMcpStatus (gateway-owned external MCP launcher)
 * - indexMessage (depends on SessionIndexStore)
 */
export function createClankyHandlers(
	paths: ClankyPaths,
	stores: ClankyStores,
	options: {
		env?: NodeJS.ProcessEnv;
		authStorage?: AuthStorage;
		mainSessionContext?: (input: MainSessionContextToolInput) => Promise<unknown>;
		mainAgentActivity?: (input: MainAgentActivityToolInput) => Promise<unknown>;
		mainAgentCancel?: (input: MainAgentCancelToolInput) => Promise<unknown>;
		delegateToMainWorker?: (input: DelegateToMainWorkerToolInput) => Promise<unknown>;
		sendSubagentMessage?: (input: SendSubagentMessageInput) => Promise<SendSubagentMessageResult>;
	} = {},
): ClankyAgentToolHandlers {
	const env = options.env ?? process.env;
	return {
		beforeProviderRequest: async (input) => input.payload,

		memoryPacket: (input) => stores.memory.packet(input),
		memoryRemember: (input) => stores.memory.remember(input, { scope: "project", subjectId: process.cwd() }),
		memorySearch: (input) => stores.memory.search(input),
		memoryForget: (input) => stores.memory.forget(input),
		memoryExport: () => stores.memory.export(),
		memoryConsent: (input) => stores.memory.setConsent(input),
		selfMemory: () => stores.memory.readSelfMemory(),

		listSkills: async () => loadClankySkills({ paths }),
		createSkill: async (input) => await createProfileSkill(paths, input),

		profileStatus: async () => ({
			profile: paths.profile,
			homeDir: paths.homeDir,
			profileDir: paths.profileDir,
			sessionsDir: paths.sessionsDir,
			skillsDir: paths.skillsDir,
			profileSkillsDir: paths.profileSkillsDir,
			chatMode: resolveClankyChatMode(env),
			chatGatewayOwner: resolveClankyChatGatewayOwner(env),
			agentChatGatewayEnabled: shouldStartAgentChatGateway(env),
			workTracker: env.CLANKY_WORK_TRACKER,
			workTrackerProviderKind: env.CLANKY_WORK_TRACKER_PROVIDER_KIND,
		}),

		workTrackerLink: async (input) => stores.workTrackerRefs.link(input),
		...(options.mainSessionContext === undefined ? {} : { mainSessionContext: options.mainSessionContext }),
		...(options.mainAgentActivity === undefined ? {} : { mainAgentActivity: options.mainAgentActivity }),
		...(options.mainAgentCancel === undefined ? {} : { mainAgentCancel: options.mainAgentCancel }),
		...(options.delegateToMainWorker === undefined ? {} : { delegateToMainWorker: options.delegateToMainWorker }),
		...(options.sendSubagentMessage === undefined ? {} : { sendSubagentMessage: options.sendSubagentMessage }),
		webSearch: async (input, signal) =>
			runOpenAiWebSearch(input, {
				...(options.authStorage === undefined ? {} : { authStorage: options.authStorage }),
				...(signal === undefined ? {} : { signal }),
			}),
		webBackendStatus: async () =>
			getWebBackendStatus({
				...(options.authStorage === undefined ? {} : { authStorage: options.authStorage }),
				cwd: process.cwd(),
			}),
		browserOpenTab: async (input) =>
			browserOpenTab(input, {
				homeDir: paths.homeDir,
			}),
		browserScreenshot: async (input) =>
			browserScreenshot(input, {
				homeDir: paths.homeDir,
			}),
		browserListTabs: async (input) =>
			browserListTabs(input, {
				homeDir: paths.homeDir,
			}),
		browserNavigate: async (input) =>
			browserNavigate(input, {
				homeDir: paths.homeDir,
			}),
		browserCloseTab: async (input) =>
			browserCloseTab(input, {
				homeDir: paths.homeDir,
			}),
		browserClick: async (input) =>
			browserClick(input, {
				homeDir: paths.homeDir,
			}),
		browserDoubleClick: async (input) =>
			browserDoubleClick(input, {
				homeDir: paths.homeDir,
			}),
		browserType: async (input) =>
			browserType(input, {
				homeDir: paths.homeDir,
			}),
		browserKey: async (input) =>
			browserKey(input, {
				homeDir: paths.homeDir,
			}),
		browserScroll: async (input) =>
			browserScroll(input, {
				homeDir: paths.homeDir,
			}),
		browserDrag: async (input) =>
			browserDrag(input, {
				homeDir: paths.homeDir,
			}),
		browserHover: async (input) =>
			browserHover(input, {
				homeDir: paths.homeDir,
			}),
		browserWait: async (input) =>
			browserWait(input, {
				homeDir: paths.homeDir,
			}),
		browserReadText: async (input) =>
			browserReadText(input, {
				homeDir: paths.homeDir,
			}),
		browserEval: async (input) =>
			browserEval(input, {
				homeDir: paths.homeDir,
			}),
		browserQuery: async (input) =>
			browserQuery(input, {
				homeDir: paths.homeDir,
			}),
		browserFill: async (input) =>
			browserFill(input, {
				homeDir: paths.homeDir,
			}),
		browserWaitFor: async (input) =>
			browserWaitFor(input, {
				homeDir: paths.homeDir,
			}),
		browserBack: async (input) =>
			browserBack(input, {
				homeDir: paths.homeDir,
			}),
		browserForward: async (input) =>
			browserForward(input, {
				homeDir: paths.homeDir,
			}),
		browserReload: async (input) =>
			browserReload(input, {
				homeDir: paths.homeDir,
			}),
		openAiImageGenerate: async (input, signal) =>
			generateOpenAiImage(input, {
				...(options.authStorage === undefined ? {} : { authStorage: options.authStorage }),
				...(signal === undefined ? {} : { signal }),
			}),
		xaiImageGenerate: async (input, signal) =>
			generateXAiImage(input, {
				...(options.authStorage === undefined ? {} : { authStorage: options.authStorage }),
				...(signal === undefined ? {} : { signal }),
			}),
		xaiVideoGenerate: async (input, signal) =>
			generateXAiVideo(input, {
				...(options.authStorage === undefined ? {} : { authStorage: options.authStorage }),
				...(signal === undefined ? {} : { signal }),
			}),
		mediaBackendStatus: async () =>
			getMediaBackendStatus({
				...(options.authStorage === undefined ? {} : { authStorage: options.authStorage }),
			}),
		discordSendMessage: async (input) =>
			sendDiscordMessage(input, {
				env,
				...(options.authStorage === undefined ? {} : { authStorage: options.authStorage }),
			}),
		listSubagents: async () => stores.subagents.listSubagents(),
		externalMcpStatus: async () =>
			getExternalMcpStatus({
				cwd: process.cwd(),
				paths,
				...(options.authStorage === undefined ? {} : { authStorage: options.authStorage }),
			}),
		externalMcpListTools: async (input) =>
			listExternalMcpTools(input, {
				cwd: process.cwd(),
				paths,
				...(options.authStorage === undefined ? {} : { authStorage: options.authStorage }),
			}),
		externalMcpCall: async (input) =>
			callExternalMcpTool(input, {
				cwd: process.cwd(),
				paths,
				...(options.authStorage === undefined ? {} : { authStorage: options.authStorage }),
			}),
	};
}
