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
	normalizeWorkTrackerProviderKind,
	resolveClankyChatGatewayOwner,
	resolveClankyChatMode,
	runOpenAiWebSearch,
	type SendSubagentMessageInput,
	type SendSubagentMessageResult,
	shouldStartAgentChatGateway,
	type WorkTrackerCreateIssueInput,
	type WorkTrackerIssueRef,
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
 * - workTrackerCreateIssue + workTrackerLink with Linear as the built-in provider
 * - beforeProviderRequest (passthrough so the logging extension hook fires)
 *
 * Intentionally omitted (defer to a later phase):
 *
 * - scheduleCron / listCron (deferred optional scheduler surface)
 * - externalMcpCall / externalMcpStatus (gateway-owned external MCP launcher)
 * - taskCreate / listTasks (coupled to SessionRegistry event log)
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
			chatMode: resolveClankyChatMode(env),
			chatGatewayOwner: resolveClankyChatGatewayOwner(env),
			agentChatGatewayEnabled: shouldStartAgentChatGateway(env),
			workTracker: env.CLANKY_WORK_TRACKER,
			workTrackerProviderKind: env.CLANKY_WORK_TRACKER_PROVIDER_KIND,
		}),

		workTrackerCreateIssue: async (input) => createWorkTrackerIssue(input, env),
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

async function createWorkTrackerIssue(
	input: WorkTrackerCreateIssueInput,
	env: NodeJS.ProcessEnv = process.env,
): Promise<WorkTrackerIssueRef> {
	const providerKind =
		input.providerKind ??
		normalizeWorkTrackerProviderKind(input.providerId) ??
		normalizeWorkTrackerProviderKind(env.CLANKY_WORK_TRACKER_PROVIDER_KIND) ??
		normalizeWorkTrackerProviderKind(env.CLANKY_WORK_TRACKER) ??
		(hasLinearCredentials(env) ? "linear" : undefined);
	const providerId = input.providerId?.trim() || env.CLANKY_WORK_TRACKER?.trim() || providerKind;
	if (providerKind === undefined || providerId === undefined) {
		throw new Error(
			"tracker_update_skipped: no external work tracker provider configured; use task_create for native Clanky tasks or configure a provider bridge",
		);
	}
	if (providerKind !== "linear") {
		throw new Error(
			`tracker_update_skipped: ${providerKind} work tracker provider is not configured in Clanky; use that provider's MCP/CLI/skill or a provider bridge`,
		);
	}
	if (!hasLinearCredentials(env)) {
		throw new Error("tracker_update_skipped: Linear credentials missing; set LINEAR_API_KEY or LINEAR_ACCESS_TOKEN.");
	}
	const teamId = input.teamId?.trim() || env.CLANKY_LINEAR_TEAM_ID?.trim() || env.LINEAR_TEAM_ID?.trim();
	if (teamId === undefined || teamId.length === 0) {
		throw new Error("work_tracker_create_issue for Linear requires teamId, team_id, or CLANKY_LINEAR_TEAM_ID");
	}
	const client = LinearClient.fromEnv(env);
	const issue = await client.createIssue({
		teamId,
		title: input.title,
		...(input.description === undefined ? {} : { description: input.description }),
		...(input.assigneeId === undefined ? {} : { assigneeId: input.assigneeId }),
		...(input.projectId === undefined ? {} : { projectId: input.projectId }),
		...(input.stateId === undefined ? {} : { stateId: input.stateId }),
		...(input.priority === undefined ? {} : { priority: input.priority }),
		...(input.labelIds === undefined ? {} : { labelIds: input.labelIds }),
	});
	return {
		providerId,
		providerKind,
		issueId: issue.issueId,
		identifier: issue.identifier,
		title: issue.title,
		...(issue.url === undefined ? {} : { url: issue.url }),
		metadata: {
			...(input.metadata ?? {}),
			...(issue.teamId === undefined ? {} : { teamId: issue.teamId }),
		},
	};
}
