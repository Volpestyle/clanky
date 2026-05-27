import {
	type ClankyAgentToolHandlers,
	type ClankyPaths,
	callExternalMcpTool,
	type DelegateToMainWorkerToolInput,
	generateOpenAiImage,
	generateXAiImage,
	generateXAiVideo,
	getExternalMcpStatus,
	getMediaBackendStatus,
	getWebBackendStatus,
	hasLinearCredentials,
	LinearClient,
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
 * - linearCreateIssue + linearLink (gated on LINEAR_API_KEY / LINEAR_ACCESS_TOKEN)
 * - beforeProviderRequest (passthrough so the logging extension hook fires)
 *
 * Intentionally omitted (defer to a later phase):
 *
 * - scheduleCron / listCron (needs CronJobStore + scheduler)
 * - externalMcpCall / externalMcpStatus (gateway-owned external MCP launcher)
 * - taskCreate / listTasks (coupled to SessionRegistry event log)
 * - indexMessage (depends on SessionIndexStore)
 */
export function createClankyHandlers(
	paths: ClankyPaths,
	stores: ClankyStores,
	options: {
		authStorage?: AuthStorage;
		mainSessionContext?: (input: MainSessionContextToolInput) => Promise<unknown>;
		mainAgentActivity?: (input: MainAgentActivityToolInput) => Promise<unknown>;
		mainAgentCancel?: (input: MainAgentCancelToolInput) => Promise<unknown>;
		delegateToMainWorker?: (input: DelegateToMainWorkerToolInput) => Promise<unknown>;
		sendSubagentMessage?: (input: SendSubagentMessageInput) => Promise<SendSubagentMessageResult>;
	} = {},
): ClankyAgentToolHandlers {
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
		createSkill: async (input) => {
			const { createProfileSkill } = await import("@clanky/core");
			return await createProfileSkill(paths, input);
		},

		profileStatus: async () => ({
			profile: paths.profile,
			homeDir: paths.homeDir,
			profileDir: paths.profileDir,
			sessionsDir: paths.sessionsDir,
			skillsDir: paths.skillsDir,
			profileSkillsDir: paths.profileSkillsDir,
			chatMode: resolveClankyChatMode(process.env),
			chatGatewayOwner: resolveClankyChatGatewayOwner(process.env),
			agentChatGatewayEnabled: shouldStartAgentChatGateway(process.env),
		}),

		linearCreateIssue: async (input) => {
			if (!hasLinearCredentials(process.env)) {
				throw new Error("Linear credentials missing: set LINEAR_API_KEY or LINEAR_ACCESS_TOKEN to create issues.");
			}
			const client = LinearClient.fromEnv(process.env);
			return await client.createIssue(input);
		},

		linearLink: async (input) => stores.linearLinks.link(input),
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
		listSubagents: async () => stores.subagents.listSubagents(),
		externalMcpStatus: async () =>
			getExternalMcpStatus({
				cwd: process.cwd(),
				...(options.authStorage === undefined ? {} : { authStorage: options.authStorage }),
			}),
		externalMcpListTools: async (input) =>
			listExternalMcpTools(input, {
				cwd: process.cwd(),
				...(options.authStorage === undefined ? {} : { authStorage: options.authStorage }),
			}),
		externalMcpCall: async (input) =>
			callExternalMcpTool(input, {
				cwd: process.cwd(),
				...(options.authStorage === undefined ? {} : { authStorage: options.authStorage }),
			}),
	};
}
