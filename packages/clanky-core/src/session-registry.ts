import { access, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	type AgentSession,
	AuthStorage,
	CURRENT_SESSION_VERSION,
	createAgentSession,
	DefaultResourceLoader,
	type LoadSkillsResult,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import {
	type ClankyAgentToolHandlers,
	createClankyExtensionFactories,
	createClankyToolDefinitions,
} from "./agent-tools.ts";
import {
	LinearClient,
	type LinearClientOptions,
	type LinearCreateIssueInput,
	type LinearCreateIssueResult,
} from "./linear/client.ts";
import { type CreateLinearLinkInput, type LinearLink, LinearLinkStore } from "./linear/links.ts";
import { type CreateLinearOutboxEntryInput, type LinearOutboxEntry, LinearOutboxStore } from "./linear/outbox.ts";
import {
	type ForgetMemoryInput,
	type MemoryConsent,
	type MemoryEvent,
	type MemoryEventInput,
	type MemoryExport,
	type MemoryForgetResult,
	type MemoryPacket,
	type MemoryPacketInput,
	type MemorySearchOptions,
	type MemorySearchResult,
	type MemoryStatus,
	MemoryStore,
	type MemoryWriteResult,
	type RememberMemoryInput,
	type SetMemoryConsentInput,
} from "./memory/store.ts";
import {
	ANTHROPIC_OAUTH_PROVIDER,
	type AuthProviderInfo,
	GITHUB_COPILOT_OAUTH_PROVIDER,
	listAuthProviderInfos,
	type ModelOAuthBeginResult,
	type ModelOAuthCredentialResult,
	OPENAI_CODEX_OAUTH_PROVIDER,
	startProviderOAuthLogin,
} from "./model-oauth.ts";
import {
	getModelAuthStatus,
	type ModelAuthMutationResult,
	type ModelAuthStatus,
	removeStoredModelAuth,
	setStoredModelApiKey,
} from "./model-status.ts";
import { type ClankyPaths, resolveClankyPaths } from "./paths.ts";
import {
	type ClankySkillMutationResult,
	type CreateClankySkillInput,
	createProfileSkill,
	type LoadClankySkillsOptions,
	loadClankySkills,
	removeProfileSkill,
} from "./skills/loader.ts";
import { type SkillUsageRecord, type SkillUsageRecordInput, SkillUsageStore } from "./skills/usage.ts";
import { ClankySkillWatcher } from "./skills/watcher.ts";
import {
	type ClankyTask,
	type CreateClankyTaskInput,
	type ListClankyTasksOptions,
	type SessionIndexMessageInput,
	SessionIndexStore,
	type SessionSearchOptions,
	type SessionSearchResult,
	type UpdateClankyTaskInput,
} from "./state/index-db.ts";

export interface SessionRegistryOptions {
	homeDir?: string;
	profile?: string;
	cwd?: string;
	idleTtlMs?: number;
	maxLiveSessions?: number;
	bundledSkillsDir?: string;
	watchSkills?: boolean;
	agentToolHandlers?: ClankyAgentToolHandlers;
	configureModelRegistry?: (modelRegistry: ModelRegistry) => void | Promise<void>;
}

export interface CreateRegisteredSessionOptions {
	cwd?: string;
	parentSession?: string;
	provider?: string;
	model?: string;
	tools?: string[];
	noTools?: "all" | "builtin";
}

export interface ForkRegisteredSessionOptions extends CreateRegisteredSessionOptions {
	sourceSessionId: string;
}

export type ForkLiveRegisteredSessionPosition = "before" | "at";

export interface ForkLiveRegisteredSessionOptions {
	sourceSessionId: string;
	entryId: string;
	position: ForkLiveRegisteredSessionPosition;
}

export interface RegisteredSession {
	id: string;
	session: AgentSession;
	sessionFile: string | undefined;
	cwd: string;
	hasUsableModel: boolean;
	createdAt: Date;
	lastUsedAt: Date;
}

export interface SessionSummary {
	id: string;
	cwd: string;
	sessionFile: string | undefined;
	live: boolean;
	createdAt?: Date;
	lastUsedAt?: Date;
	messageCount?: number;
	firstMessage?: string;
	name?: string;
}

export interface ForkRegisteredSessionResult {
	sourceSessionId: string;
	sourceSessionFile: string;
	sessionId: string;
	sessionFile: string | undefined;
	cwd: string;
}

export type ForkLiveRegisteredSessionResult =
	| {
			cancelled: true;
			sourceSessionId: string;
	  }
	| {
			cancelled: false;
			sourceSessionId: string;
			session: RegisteredSession;
			selectedText?: string;
	  };

export interface FlushLinearOutboxOptions extends LinearClientOptions {
	limit?: number;
	entryIds?: string[];
}

export interface FlushLinearOutboxResult {
	posted: LinearOutboxEntry[];
	failed: LinearOutboxEntry[];
}

export interface DrainSessionsOptions {
	timeoutMs?: number;
	pollIntervalMs?: number;
}

export interface DrainSessionsResult {
	drained: string[];
	stillRunning: string[];
}

export interface PendingPromptCheckpointInput {
	sessionId: string;
	sessionFile?: string;
	cwd: string;
	source: "send" | "cron";
	prompt: string;
	skill?: string;
	jobId?: string;
}

export type ModelOAuthLoginResult = ModelAuthMutationResult;

interface MutableRegisteredSession extends RegisteredSession {
	lastUsedAt: Date;
}

interface PendingPromptCheckpoint extends PendingPromptCheckpointInput {
	createdAt: string;
}

interface PendingModelOAuthLogin {
	cancel(): void;
	completion: Promise<ModelOAuthLoginResult>;
	provider: string;
}

export const DEFAULT_SESSION_IDLE_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_MAX_LIVE_SESSIONS = 128;
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
const DEFAULT_DRAIN_POLL_INTERVAL_MS = 50;

export class SessionRegistry {
	readonly paths: ClankyPaths;

	private readonly cwd: string;
	private readonly idleTtlMs: number;
	private readonly maxLiveSessions: number;
	private readonly bundledSkillsDir: string | undefined;
	private readonly watchSkills: boolean;
	private readonly configureModelRegistry: ((modelRegistry: ModelRegistry) => void | Promise<void>) | undefined;
	private readonly linearLinks: LinearLinkStore;
	private readonly linearOutbox: LinearOutboxStore;
	private readonly sessionIndex: SessionIndexStore;
	private readonly skillUsage: SkillUsageStore;
	private readonly memoryStore: MemoryStore;
	private readonly sessions = new Map<string, MutableRegisteredSession>();
	private readonly modelOAuthLogins = new Map<string, PendingModelOAuthLogin>();
	private agentToolHandlers: ClankyAgentToolHandlers;
	private skillWatcher: ClankySkillWatcher | undefined;
	private started = false;

	constructor(options: SessionRegistryOptions = {}) {
		this.paths = resolveClankyPaths(options);
		this.cwd = options.cwd ?? process.cwd();
		this.idleTtlMs = options.idleTtlMs ?? DEFAULT_SESSION_IDLE_TTL_MS;
		this.maxLiveSessions = options.maxLiveSessions ?? DEFAULT_MAX_LIVE_SESSIONS;
		this.bundledSkillsDir = options.bundledSkillsDir;
		this.watchSkills = options.watchSkills ?? true;
		this.configureModelRegistry = options.configureModelRegistry;
		this.linearLinks = new LinearLinkStore(this.paths);
		this.linearOutbox = new LinearOutboxStore(this.paths);
		this.sessionIndex = new SessionIndexStore(this.paths);
		this.skillUsage = new SkillUsageStore(this.paths);
		this.memoryStore = new MemoryStore(this.paths);
		this.agentToolHandlers = this.withDefaultAgentToolHandlers(options.agentToolHandlers);
	}

	async start(): Promise<void> {
		if (this.started) return;
		await mkdir(this.paths.sessionsDir, { recursive: true, mode: 0o700 });
		await this.memoryStore.ensure();
		await this.recoverPendingPrompts();
		this.started = true;
		if (this.watchSkills) await this.startSkillWatcher();
	}

	async createSession(options: CreateRegisteredSessionOptions = {}): Promise<RegisteredSession> {
		await this.start();
		this.evictIdleSessions();
		this.evictOverflowSessions();

		const cwd = options.cwd ?? this.cwd;
		const sessionManager = SessionManager.create(cwd, this.paths.sessionsDir);
		if (options.parentSession !== undefined) sessionManager.newSession({ parentSession: options.parentSession });
		const registered = await this.createRegisteredSession(sessionManager, options);
		this.sessions.set(registered.id, registered);
		return registered;
	}

	async forkSession(options: ForkRegisteredSessionOptions): Promise<ForkRegisteredSessionResult> {
		await this.start();
		this.evictIdleSessions();
		this.evictOverflowSessions();

		const source = await this.getOrOpen(options.sourceSessionId);
		if (source.sessionFile === undefined) {
			throw new Error(`Session ${options.sourceSessionId} is not persisted and cannot be forked`);
		}
		const sourceFileExists = await access(source.sessionFile)
			.then(() => true)
			.catch(() => false);
		if (!sourceFileExists) {
			throw new Error(`Session ${source.id} has not been written to disk yet and cannot be forked`);
		}

		const cwd = options.cwd ?? source.cwd;
		const forkedSessionManager = SessionManager.forkFrom(source.sessionFile, cwd, this.paths.sessionsDir);
		const registered = await this.createRegisteredSession(forkedSessionManager, options);
		this.sessions.set(registered.id, registered);

		return {
			sourceSessionId: source.id,
			sourceSessionFile: source.sessionFile,
			sessionId: registered.id,
			sessionFile: registered.sessionFile,
			cwd: registered.cwd,
		};
	}

	async forkLiveSession(options: ForkLiveRegisteredSessionOptions): Promise<ForkLiveRegisteredSessionResult> {
		await this.start();
		const source = await this.getOrOpen(options.sourceSessionId);
		if (await forkCancelledByExtension(source, options.entryId, options.position)) {
			return { cancelled: true, sourceSessionId: source.id };
		}
		const target = forkTarget(source, options.entryId, options.position);
		const sessionManager = await this.createForkSessionManager(source, target.targetLeafId);
		const registered = await this.createRegisteredSession(sessionManager);
		this.sessions.set(registered.id, registered);
		const result: ForkLiveRegisteredSessionResult = {
			cancelled: false,
			sourceSessionId: source.id,
			session: registered,
		};
		if (target.selectedText !== undefined) result.selectedText = target.selectedText;
		return result;
	}

	async applyModelOverride(
		sessionId: string,
		provider: string | undefined,
		model: string | undefined,
	): Promise<RegisteredSession> {
		const registered = await this.getOrOpen(sessionId);
		const requestedModel = resolveRequestedModel(registered.session.modelRegistry, provider, model);
		if (requestedModel === undefined) return registered;
		await registered.session.setModel(requestedModel);
		registered.hasUsableModel = true;
		return registered;
	}

	async getOrOpen(sessionId: string): Promise<RegisteredSession> {
		const live = this.get(sessionId);
		if (live) return live;

		await this.start();
		this.evictIdleSessions();
		this.evictOverflowSessions();

		const sessionFile = await this.findSessionFile(sessionId);
		if (!sessionFile) {
			throw new Error(`Unknown session: ${sessionId}`);
		}

		const sessionManager = SessionManager.open(sessionFile, this.paths.sessionsDir);
		const registered = await this.createRegisteredSession(sessionManager);
		this.sessions.set(registered.id, registered);
		return registered;
	}

	async listSummaries(): Promise<SessionSummary[]> {
		const live = new Map(
			this.list().map((session): [string, SessionSummary] => [
				session.id,
				{
					id: session.id,
					cwd: session.cwd,
					sessionFile: session.sessionFile,
					live: true,
					createdAt: session.createdAt,
					lastUsedAt: session.lastUsedAt,
				},
			]),
		);
		const persisted = await SessionManager.list(this.cwd, this.paths.sessionsDir);
		for (const session of persisted) {
			if (live.has(session.id)) continue;
			const summary: SessionSummary = {
				id: session.id,
				cwd: session.cwd,
				sessionFile: session.path,
				live: false,
				createdAt: session.created,
				lastUsedAt: session.modified,
				messageCount: session.messageCount,
				firstMessage: session.firstMessage,
			};
			if (session.name !== undefined) summary.name = session.name;
			live.set(session.id, summary);
		}
		return [...live.values()].sort((a, b) => {
			const aTime = a.lastUsedAt?.getTime() ?? a.createdAt?.getTime() ?? 0;
			const bTime = b.lastUsedAt?.getTime() ?? b.createdAt?.getTime() ?? 0;
			return bTime - aTime;
		});
	}

	loadSkills(): LoadSkillsResult {
		const loadOptions: LoadClankySkillsOptions = { paths: this.paths };
		if (this.bundledSkillsDir !== undefined) loadOptions.bundledSkillsDir = this.bundledSkillsDir;
		return loadClankySkills(loadOptions);
	}

	async createSkill(input: CreateClankySkillInput): Promise<ClankySkillMutationResult> {
		return await createProfileSkill(this.paths, input);
	}

	async removeSkill(name: string): Promise<ClankySkillMutationResult | undefined> {
		return await removeProfileSkill(this.paths, name);
	}

	async recordSkillUsage(input: SkillUsageRecordInput): Promise<SkillUsageRecord> {
		return await this.skillUsage.record(input);
	}

	async listSkillUsage(): Promise<SkillUsageRecord[]> {
		return await this.skillUsage.list();
	}

	async linkLinearIssue(input: CreateLinearLinkInput): Promise<LinearLink> {
		return await this.linearLinks.link(input);
	}

	async listLinearLinks(): Promise<LinearLink[]> {
		return await this.linearLinks.list();
	}

	async addLinearOutboxEntry(input: CreateLinearOutboxEntryInput): Promise<LinearOutboxEntry> {
		return await this.linearOutbox.add(input);
	}

	async listLinearOutbox(): Promise<LinearOutboxEntry[]> {
		return await this.linearOutbox.list();
	}

	async createLinearIssue(
		input: LinearCreateIssueInput,
		options: LinearClientOptions = {},
	): Promise<LinearCreateIssueResult> {
		const client = LinearClient.fromEnv(process.env, options);
		return await client.createIssue(input);
	}

	async flushLinearOutbox(options: FlushLinearOutboxOptions = {}): Promise<FlushLinearOutboxResult> {
		const client = LinearClient.fromEnv(process.env, options);
		const pending = await this.linearOutbox.pending();
		const entryIds = options.entryIds === undefined ? undefined : new Set(options.entryIds);
		const candidates = entryIds === undefined ? pending : pending.filter((entry) => entryIds.has(entry.id));
		const selected = candidates.slice(0, normalizedFlushLimit(options.limit));
		const result: FlushLinearOutboxResult = { posted: [], failed: [] };
		for (const entry of selected) {
			try {
				const posted = await client.postComment({
					id: entry.id,
					issueId: entry.issueId,
					body: entry.body,
				});
				result.posted.push(
					await this.linearOutbox.markPosted(entry.id, {
						commentId: posted.commentId,
						...(posted.url === undefined ? {} : { commentUrl: posted.url }),
					}),
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				result.failed.push(await this.linearOutbox.markError(entry.id, message));
			}
		}
		return result;
	}

	async recordSessionMessage(input: SessionIndexMessageInput): Promise<void> {
		await this.sessionIndex.recordMessage(input);
	}

	async recordPendingPrompt(input: PendingPromptCheckpointInput): Promise<void> {
		await mkdir(this.pendingPromptDir(), { recursive: true, mode: 0o700 });
		const checkpoint: PendingPromptCheckpoint = {
			...input,
			createdAt: new Date().toISOString(),
		};
		const file = this.pendingPromptFile(input.sessionId);
		const tempFile = `${file}.${process.pid}.tmp`;
		await writeFile(tempFile, `${JSON.stringify(checkpoint, null, "\t")}\n`, { mode: 0o600 });
		await rename(tempFile, file);
	}

	async clearPendingPrompt(sessionId: string): Promise<void> {
		await unlink(this.pendingPromptFile(sessionId)).catch(() => undefined);
	}

	async createTask(input: CreateClankyTaskInput): Promise<ClankyTask> {
		return await this.sessionIndex.createTask(input);
	}

	async listTasks(options: ListClankyTasksOptions = {}): Promise<ClankyTask[]> {
		return await this.sessionIndex.listTasks(options);
	}

	async updateTask(input: UpdateClankyTaskInput): Promise<ClankyTask | undefined> {
		return await this.sessionIndex.updateTask(input);
	}

	async searchSessions(options: SessionSearchOptions): Promise<SessionSearchResult[]> {
		await this.sessionIndex.indexSessionDirectory(this.paths.sessionsDir);
		return await this.sessionIndex.search(options);
	}

	async memoryStatus(): Promise<MemoryStatus> {
		return await this.memoryStore.status();
	}

	async rememberMemory(input: RememberMemoryInput): Promise<MemoryWriteResult> {
		return await this.memoryStore.remember(input, { scope: "project", subjectId: this.cwd });
	}

	async recordMemoryEvent(input: MemoryEventInput): Promise<MemoryEvent> {
		return await this.memoryStore.recordEvent(input);
	}

	async searchMemory(options: MemorySearchOptions): Promise<MemorySearchResult> {
		return await this.memoryStore.search(options);
	}

	async forgetMemory(input: ForgetMemoryInput): Promise<MemoryForgetResult> {
		return await this.memoryStore.forget(input);
	}

	async setMemoryConsent(input: SetMemoryConsentInput): Promise<MemoryConsent> {
		return await this.memoryStore.setConsent(input);
	}

	async exportMemory(): Promise<MemoryExport> {
		return await this.memoryStore.export();
	}

	async readSelfMemory(): Promise<string> {
		return await this.memoryStore.readSelfMemory();
	}

	async writeSelfMemory(content: string): Promise<string> {
		return await this.memoryStore.writeSelfMemory(content);
	}

	async memoryPacket(input: MemoryPacketInput): Promise<MemoryPacket> {
		return await this.memoryStore.packet(input);
	}

	modelAuthStatus(): ModelAuthStatus {
		return getModelAuthStatus({ homeDir: this.paths.homeDir, profile: this.paths.profile });
	}

	setModelApiKey(provider: string, apiKey: string): ModelAuthMutationResult {
		const result = setStoredModelApiKey(
			{ homeDir: this.paths.homeDir, profile: this.paths.profile },
			{ provider, apiKey },
		);
		this.refreshLiveModelAuth();
		return result;
	}

	removeModelAuth(provider: string): ModelAuthMutationResult {
		const result = removeStoredModelAuth({ homeDir: this.paths.homeDir, profile: this.paths.profile }, provider);
		this.refreshLiveModelAuth();
		return result;
	}

	async beginModelOAuthLogin(providerInput: string = OPENAI_CODEX_OAUTH_PROVIDER): Promise<ModelOAuthBeginResult> {
		const provider = normalizeModelOAuthProvider(providerInput);
		const started = await startProviderOAuthLogin(provider);
		const completion = started.completion.then((result) => this.storeModelOAuthCredential(result));
		completion.catch(() => undefined);
		this.modelOAuthLogins.set(started.loginId, {
			cancel: started.cancel,
			completion,
			provider,
		});
		void completion.finally(() => {
			const cleanup = setTimeout(
				() => {
					this.modelOAuthLogins.delete(started.loginId);
				},
				5 * 60 * 1000,
			);
			cleanup.unref?.();
		});
		return started.info;
	}

	listAuthProviders(): AuthProviderInfo[] {
		return listAuthProviderInfos();
	}

	async waitModelOAuthLogin(loginId: string): Promise<ModelOAuthLoginResult> {
		const pending = this.modelOAuthLogins.get(loginId);
		if (pending === undefined) throw new Error(`Unknown OAuth login: ${loginId}`);
		return await pending.completion;
	}

	cancelModelOAuthLogin(loginId: string): { cancelled: boolean; provider?: string } {
		const pending = this.modelOAuthLogins.get(loginId);
		if (pending === undefined) return { cancelled: false };
		pending.cancel();
		this.modelOAuthLogins.delete(loginId);
		return { cancelled: true, provider: pending.provider };
	}

	setAgentToolHandlers(handlers: ClankyAgentToolHandlers): void {
		this.agentToolHandlers = this.withDefaultAgentToolHandlers(handlers);
	}

	private storeModelOAuthCredential(result: ModelOAuthCredentialResult): ModelOAuthLoginResult {
		const authStorage = AuthStorage.create(this.paths.authFile);
		authStorage.set(result.provider, result.credential);
		const errors = authStorage.drainErrors();
		if (errors.length > 0) throw errors[0];
		this.refreshLiveModelAuth();
		return { provider: result.provider, status: this.modelAuthStatus() };
	}

	private refreshLiveModelAuth(): void {
		for (const registered of this.sessions.values()) {
			registered.session.modelRegistry.authStorage.reload();
			registered.session.modelRegistry.refresh();
			registered.hasUsableModel = registered.session.model
				? registered.session.modelRegistry.hasConfiguredAuth(registered.session.model)
				: false;
		}
	}

	private async createRegisteredSession(
		sessionManager: SessionManager,
		options: CreateRegisteredSessionOptions = {},
	): Promise<MutableRegisteredSession> {
		const cwd = options.cwd ?? sessionManager.getCwd();
		const authStorage = AuthStorage.create(this.paths.authFile);
		const modelRegistry = ModelRegistry.create(authStorage, this.paths.modelsFile);
		await this.configureModelRegistry?.(modelRegistry);
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: this.paths.profileDir,
			extensionFactories: createClankyExtensionFactories(this.agentToolHandlers),
			skillsOverride: (current) => {
				const loadOptions: LoadClankySkillsOptions = { paths: this.paths };
				if (this.bundledSkillsDir !== undefined) loadOptions.bundledSkillsDir = this.bundledSkillsDir;
				const clankySkills = loadClankySkills(loadOptions);
				const skillsByName = new Map<string, Skill>();
				for (const skill of clankySkills.skills) skillsByName.set(skill.name, skill);
				for (const skill of current.skills) skillsByName.set(skill.name, skill);
				return {
					skills: [...skillsByName.values()],
					diagnostics: [...current.diagnostics, ...clankySkills.diagnostics],
				};
			},
		});
		await resourceLoader.reload();
		const createOptions: Parameters<typeof createAgentSession>[0] = {
			cwd,
			agentDir: this.paths.profileDir,
			authStorage,
			modelRegistry,
			resourceLoader,
			sessionManager,
			settingsManager,
		};
		const requestedModel = resolveRequestedModel(modelRegistry, options.provider, options.model);
		if (requestedModel !== undefined) createOptions.model = requestedModel;
		const customTools = createClankyToolDefinitions(this.agentToolHandlers);
		if (customTools.length > 0) createOptions.customTools = customTools;
		if (options.tools !== undefined) createOptions.tools = options.tools;
		if (options.noTools !== undefined) createOptions.noTools = options.noTools;
		const result = await createAgentSession(createOptions);

		const now = new Date();
		const registered: MutableRegisteredSession = {
			id: result.session.sessionId,
			session: result.session,
			sessionFile: await existingFile(result.session.sessionFile),
			cwd,
			hasUsableModel: result.session.model ? modelRegistry.hasConfiguredAuth(result.session.model) : false,
			createdAt: now,
			lastUsedAt: now,
		};
		return registered;
	}

	private withDefaultAgentToolHandlers(handlers: ClankyAgentToolHandlers = {}): ClankyAgentToolHandlers {
		return {
			...handlers,
			linearCreateIssue: handlers.linearCreateIssue ?? ((input) => this.createLinearIssue(input)),
			linearLink: handlers.linearLink ?? ((input) => this.linkLinearIssue(input)),
			taskCreate: handlers.taskCreate ?? ((input) => this.createTask({ ...input, source: "agent" })),
			indexMessage: handlers.indexMessage ?? ((input) => this.recordSessionMessage(input)),
			beforeProviderRequest: handlers.beforeProviderRequest ?? (async (input) => input.payload),
			listSkills: handlers.listSkills ?? (async () => this.loadSkills()),
			createSkill: handlers.createSkill ?? ((input) => this.createSkill(input)),
			memoryPacket: handlers.memoryPacket ?? ((input) => this.memoryPacket(input)),
			memoryRemember: handlers.memoryRemember ?? ((input) => this.rememberMemory(input)),
			memorySearch: handlers.memorySearch ?? ((input) => this.searchMemory(input)),
			memoryForget: handlers.memoryForget ?? ((input) => this.forgetMemory(input)),
			memoryExport: handlers.memoryExport ?? (() => this.exportMemory()),
			memoryConsent: handlers.memoryConsent ?? ((input) => this.setMemoryConsent(input)),
			selfMemory: handlers.selfMemory ?? (() => this.readSelfMemory()),
			profileStatus:
				handlers.profileStatus ??
				(async () => ({
					profile: this.paths.profile,
					homeDir: this.paths.homeDir,
					profileDir: this.paths.profileDir,
					sessionsDir: this.paths.sessionsDir,
					skillsDir: this.paths.skillsDir,
					profileSkillsDir: this.paths.profileSkillsDir,
				})),
		};
	}

	private async createForkSessionManager(
		source: RegisteredSession,
		targetLeafId: string | null,
	): Promise<SessionManager> {
		const sourceFile = await existingFile(source.sessionFile ?? source.session.sessionFile);
		if (targetLeafId === null) {
			const manager = SessionManager.create(source.cwd, this.paths.sessionsDir);
			if (sourceFile !== undefined) manager.newSession({ parentSession: sourceFile });
			return manager;
		}

		if (sourceFile !== undefined) {
			const sourceManager = SessionManager.open(sourceFile, this.paths.sessionsDir);
			const forkedSessionFile = sourceManager.createBranchedSession(targetLeafId);
			if (forkedSessionFile === undefined) return sourceManager;
			const persistedFork = await existingFile(forkedSessionFile);
			return persistedFork === undefined ? sourceManager : SessionManager.open(persistedFork, this.paths.sessionsDir);
		}

		const manager = source.session.sessionManager;
		manager.createBranchedSession(targetLeafId);
		source.session.dispose();
		this.sessions.delete(source.id);
		return manager;
	}

	private async findSessionFile(sessionId: string): Promise<string | undefined> {
		const files = await readdir(this.paths.sessionsDir).catch(() => []);
		const matches = files.filter((file) => file.endsWith(".jsonl") && file.includes(sessionId));
		if (matches.length > 1) {
			throw new Error(`Ambiguous session id: ${sessionId}`);
		}
		const match = matches[0];
		return match ? join(this.paths.sessionsDir, match) : undefined;
	}

	get(sessionId: string): RegisteredSession | undefined {
		const registered = this.sessions.get(sessionId);
		if (!registered) return undefined;
		registered.lastUsedAt = new Date();
		return registered;
	}

	list(): RegisteredSession[] {
		return [...this.sessions.values()].sort((a, b) => b.lastUsedAt.getTime() - a.lastUsedAt.getTime());
	}

	async refreshSessionFile(sessionId: string): Promise<string | undefined> {
		const registered = this.sessions.get(sessionId);
		if (registered === undefined) return undefined;
		registered.sessionFile = await existingFile(registered.session.sessionFile);
		return registered.sessionFile;
	}

	async drainSessions(options: DrainSessionsOptions = {}): Promise<DrainSessionsResult> {
		const timeoutMs = options.timeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
		const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_DRAIN_POLL_INTERVAL_MS;
		const tracked = new Set(this.streamingSessionIds());
		if (tracked.size === 0) return { drained: [], stillRunning: [] };
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline && this.hasStreamingSession(tracked)) {
			await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
		}
		const stillRunning = this.streamingSessionIds().filter((id) => tracked.has(id));
		return {
			drained: [...tracked].filter((id) => !stillRunning.includes(id)),
			stillRunning,
		};
	}

	async disposeSession(sessionId: string): Promise<boolean> {
		const registered = this.sessions.get(sessionId);
		if (registered === undefined) return false;
		await registered.session.abort();
		registered.session.dispose();
		this.sessions.delete(sessionId);
		return true;
	}

	async dispose(): Promise<void> {
		await this.skillWatcher?.close();
		this.skillWatcher = undefined;
		for (const registered of this.sessions.values()) {
			await registered.session.abort();
			registered.session.dispose();
		}
		this.sessions.clear();
		this.sessionIndex.close();
		this.memoryStore.close();
		this.started = false;
	}

	private streamingSessionIds(): string[] {
		return [...this.sessions.values()]
			.filter((registered) => registered.session.isStreaming)
			.map((registered) => registered.id);
	}

	private hasStreamingSession(sessionIds: Set<string>): boolean {
		for (const id of sessionIds) {
			if (this.sessions.get(id)?.session.isStreaming === true) return true;
		}
		return false;
	}

	private evictIdleSessions(): void {
		const cutoff = Date.now() - this.idleTtlMs;
		for (const [id, registered] of this.sessions) {
			if (registered.lastUsedAt.getTime() >= cutoff) continue;
			registered.session.dispose();
			this.sessions.delete(id);
		}
	}

	private evictOverflowSessions(): void {
		if (this.sessions.size < this.maxLiveSessions) return;
		const oldest = [...this.sessions.values()].sort((a, b) => a.lastUsedAt.getTime() - b.lastUsedAt.getTime());
		const evictCount = this.sessions.size - this.maxLiveSessions + 1;
		for (const registered of oldest.slice(0, evictCount)) {
			registered.session.dispose();
			this.sessions.delete(registered.id);
		}
	}

	private async startSkillWatcher(): Promise<void> {
		if (this.skillWatcher !== undefined) return;
		const watcherOptions: ConstructorParameters<typeof ClankySkillWatcher>[0] = {
			paths: this.paths,
			onChange: async () => {
				await this.reloadLiveSessionResources();
			},
			onError: (error) => {
				console.error(`Skill watcher error: ${error.message}`);
			},
		};
		if (this.bundledSkillsDir !== undefined) watcherOptions.bundledSkillsDir = this.bundledSkillsDir;
		const watcher = new ClankySkillWatcher(watcherOptions);
		await watcher.start();
		this.skillWatcher = watcher;
	}

	private async reloadLiveSessionResources(): Promise<void> {
		await Promise.all([...this.sessions.values()].map((registered) => registered.session.resourceLoader.reload()));
	}

	private pendingPromptDir(): string {
		return join(this.paths.sessionsDir, ".pending");
	}

	private pendingPromptFile(sessionId: string): string {
		return join(this.pendingPromptDir(), `${sessionId}.json`);
	}

	private async recoverPendingPrompts(): Promise<void> {
		const pendingDir = this.pendingPromptDir();
		const files = await readdir(pendingDir).catch(() => []);
		for (const file of files) {
			if (!file.endsWith(".json")) continue;
			await this.recoverPendingPromptFile(join(pendingDir, file));
		}
	}

	private async recoverPendingPromptFile(file: string): Promise<void> {
		const content = await readFile(file, "utf8").catch(() => undefined);
		if (content === undefined) return;
		const checkpoint = parsePendingPromptCheckpoint(content);
		if (checkpoint === undefined) {
			await unlink(file).catch(() => undefined);
			return;
		}
		const sessionFile =
			checkpoint.sessionFile ??
			join(this.paths.sessionsDir, `${safeSessionFileTimestamp(checkpoint.createdAt)}_${checkpoint.sessionId}.jsonl`);
		const sessionExists = await access(sessionFile)
			.then(() => true)
			.catch(() => false);
		if (sessionExists) {
			await unlink(file).catch(() => undefined);
			return;
		}
		await mkdir(dirname(sessionFile), { recursive: true, mode: 0o700 });
		const header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: checkpoint.sessionId,
			timestamp: checkpoint.createdAt,
			cwd: checkpoint.cwd,
		};
		const entry = {
			type: "custom",
			id: `${checkpoint.sessionId}:pending-prompt`,
			parentId: null,
			timestamp: checkpoint.createdAt,
			customType: "clanky.prompt_checkpoint",
			data: {
				source: checkpoint.source,
				status: "interrupted",
				prompt: checkpoint.prompt,
				...(checkpoint.skill === undefined ? {} : { skill: checkpoint.skill }),
				...(checkpoint.jobId === undefined ? {} : { jobId: checkpoint.jobId }),
			},
		};
		await writeFile(sessionFile, `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`, { mode: 0o600 });
		await unlink(file).catch(() => undefined);
	}
}

function safeSessionFileTimestamp(timestamp: string): string {
	return timestamp.replace(/[:.]/g, "-");
}

function parsePendingPromptCheckpoint(content: string): PendingPromptCheckpoint | undefined {
	try {
		const value = JSON.parse(content) as unknown;
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		const record = value as Record<string, unknown>;
		if (
			typeof record.sessionId !== "string" ||
			typeof record.cwd !== "string" ||
			(record.source !== "send" && record.source !== "cron") ||
			typeof record.prompt !== "string" ||
			typeof record.createdAt !== "string"
		) {
			return undefined;
		}
		const checkpoint: PendingPromptCheckpoint = {
			sessionId: record.sessionId,
			cwd: record.cwd,
			source: record.source,
			prompt: record.prompt,
			createdAt: record.createdAt,
		};
		if (typeof record.sessionFile === "string") checkpoint.sessionFile = record.sessionFile;
		if (typeof record.skill === "string") checkpoint.skill = record.skill;
		if (typeof record.jobId === "string") checkpoint.jobId = record.jobId;
		return checkpoint;
	} catch {
		return undefined;
	}
}

interface ForkTarget {
	targetLeafId: string | null;
	selectedText?: string;
}

async function forkCancelledByExtension(
	source: RegisteredSession,
	entryId: string,
	position: ForkLiveRegisteredSessionPosition,
): Promise<boolean> {
	if (!source.session.extensionRunner.hasHandlers("session_before_fork")) return false;
	const result = await source.session.extensionRunner.emit({
		type: "session_before_fork",
		entryId,
		position,
	});
	return result?.cancel === true;
}

function forkTarget(
	source: RegisteredSession,
	entryId: string,
	position: ForkLiveRegisteredSessionPosition,
): ForkTarget {
	const entry = source.session.sessionManager.getEntry(entryId);
	if (entry === undefined) throw new Error("Invalid entry ID for forking");
	if (position === "at") return { targetLeafId: entry.id };
	if (entry.type !== "message" || entry.message.role !== "user") {
		throw new Error("Invalid entry ID for forking");
	}
	const target: ForkTarget = {
		targetLeafId: entry.parentId,
		selectedText: extractUserMessageText(entry.message.content),
	};
	return target;
}

function extractUserMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(textContentPart).join("");
}

function textContentPart(value: unknown): string {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return "";
	const record = value as Record<string, unknown>;
	return record.type === "text" && typeof record.text === "string" ? record.text : "";
}

async function existingFile(file: string | undefined): Promise<string | undefined> {
	if (file === undefined) return undefined;
	const exists = await access(file)
		.then(() => true)
		.catch(() => false);
	return exists ? file : undefined;
}

async function delay(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

type RegistryModel = ReturnType<ModelRegistry["getAll"]>[number];

function resolveRequestedModel(
	modelRegistry: ModelRegistry,
	provider: string | undefined,
	model: string | undefined,
): RegistryModel | undefined {
	if (provider === undefined && model === undefined) return undefined;
	const requestedProvider = provider?.trim();
	const requestedModel = model?.trim();
	if (requestedProvider === "" || requestedModel === "")
		throw new Error("Provider and model must be non-empty strings");

	if (requestedProvider !== undefined && requestedModel !== undefined) {
		const exact = modelRegistry.find(requestedProvider, requestedModel);
		if (exact === undefined) throw new Error(`Unknown model override: ${requestedProvider}/${requestedModel}`);
		return exact;
	}

	if (requestedProvider !== undefined) {
		const available = modelRegistry.getAvailable().filter((candidate) => candidate.provider === requestedProvider);
		const candidates =
			available.length > 0
				? available
				: modelRegistry.getAll().filter((candidate) => candidate.provider === requestedProvider);
		const match = candidates[0];
		if (match === undefined) throw new Error(`Unknown provider override: ${requestedProvider}`);
		return match;
	}

	if (requestedModel === undefined) return undefined;
	const slashIndex = requestedModel.indexOf("/");
	if (slashIndex > 0) {
		const modelProvider = requestedModel.slice(0, slashIndex);
		const modelId = requestedModel.slice(slashIndex + 1);
		const exact = modelRegistry.find(modelProvider, modelId);
		if (exact !== undefined) return exact;
	}

	const matches = modelRegistry
		.getAll()
		.filter((candidate) => candidate.id === requestedModel || candidate.name === requestedModel);
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) throw new Error(`Ambiguous model override: ${requestedModel}`);
	throw new Error(`Unknown model override: ${requestedModel}`);
}

function normalizeModelOAuthProvider(providerInput: string): string {
	const provider = providerInput.trim().toLowerCase();
	if (provider === "codex" || provider === OPENAI_CODEX_OAUTH_PROVIDER) return OPENAI_CODEX_OAUTH_PROVIDER;
	if (provider === "claude" || provider === ANTHROPIC_OAUTH_PROVIDER) return ANTHROPIC_OAUTH_PROVIDER;
	if (provider === "copilot" || provider === GITHUB_COPILOT_OAUTH_PROVIDER) return GITHUB_COPILOT_OAUTH_PROVIDER;
	const known = new Set(
		listAuthProviderInfos()
			.filter((info) => info.supportsOAuth)
			.map((info) => info.id),
	);
	if (known.has(provider)) return provider;
	const supported = Array.from(known).sort().join(", ");
	throw new Error(`Unsupported OAuth provider: ${providerInput}. Supported providers: ${supported}`);
}

function normalizedFlushLimit(limit: number | undefined): number {
	if (limit === undefined) return Number.POSITIVE_INFINITY;
	if (!Number.isInteger(limit) || limit <= 0) throw new Error("Linear flush limit must be a positive integer");
	return limit;
}
