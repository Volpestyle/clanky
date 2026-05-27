/**
 * Owns the lifecycle of Clanky's agent-owned Discord bridge so the
 * `/discord-login` slash command can restart it after persisting new
 * credentials, without restarting the whole Clanky process.
 *
 * The runtime reference is bound after `createAgentSessionRuntime` returns,
 * since the controller has to be constructed earlier (the discord-auth
 * extension factory captures it).
 */

import { appendFile } from "node:fs/promises";
import {
	type ClankyPaths,
	type DelegateToMainWorkerToolInput,
	DiscordSubagentStore,
	type MainSessionContextToolInput,
	type SendSubagentMessageInput,
	type SendSubagentMessageResult,
} from "@clanky/core";
import type {
	AgentSessionRuntime,
	AuthStorage,
	CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import { createAgentDiscordClient, loginAgentDiscordClient } from "./agentDiscordClient.ts";
import {
	type ClankyAgentDiscordGatewayHandle,
	resolveAgentDiscordCredentialConfig,
	resolveAgentDiscordGatewayConfig,
	startAgentDiscordGateway,
} from "./agentDiscordGateway.ts";
import {
	type ClankyAgentDiscordVoiceHandle,
	resolveAgentDiscordVoiceConfig,
	startAgentDiscordVoiceBridge,
} from "./agentDiscordVoice.ts";
import type { ClankyThinkingLevel } from "./clankyDefaults.ts";
import type { StoredDiscordVoiceSettings } from "./discordVoiceSettings.ts";
import { readMainSessionContext } from "./mainSessionContext.ts";
import { delegateToMainWorker } from "./mainWorkerDelegation.ts";
import { type RuntimeTurnQueue, SerialRuntimeTurnQueue } from "./runtimeTurnQueue.ts";
import type { VoiceSupervisorDelegateHandle } from "./voiceSupervisorExtension.ts";

type JsonRecord = Record<string, unknown>;
const DISCORD_CLIENT_READY_TIMEOUT_MS = 30_000;
const DISCORD_CLIENT_READY_POLL_MS = 50;

export type DiscordVoiceStartProgressPhase =
	| "stopping_existing"
	| "resolving_config"
	| "creating_client"
	| "logging_in_client"
	| "waiting_for_client_ready"
	| "starting_voice_bridge"
	| "ready"
	| "skipped";

export interface DiscordVoiceStartProgress {
	phase: DiscordVoiceStartProgressPhase;
	message: string;
	guildId?: string;
	channelId?: string;
}

export interface DiscordVoiceStartOptions {
	onProgress?: (progress: DiscordVoiceStartProgress) => void;
}

export interface ClankyDiscordGatewayControllerDependencies {
	createClient?: typeof createAgentDiscordClient;
	loginClient?: typeof loginAgentDiscordClient;
	startGateway?: typeof startAgentDiscordGateway;
	startVoice?: typeof startAgentDiscordVoiceBridge;
}

interface ResolvedClankyDiscordGatewayControllerDependencies {
	createClient: typeof createAgentDiscordClient;
	loginClient: typeof loginAgentDiscordClient;
	startGateway: typeof startAgentDiscordGateway;
	startVoice: typeof startAgentDiscordVoiceBridge;
}

export class ClankyDiscordGatewayController {
	private readonly authStorage: AuthStorage;
	private readonly paths: ClankyPaths;
	private readonly bridgeLogPath: string | undefined;
	private readonly voiceLogPath: string | undefined;
	private readonly env: NodeJS.ProcessEnv;
	private readonly readVoiceSettings: (() => StoredDiscordVoiceSettings | undefined) | undefined;
	private readonly dependencies: ResolvedClankyDiscordGatewayControllerDependencies;
	private readonly runtimeTurnQueue: RuntimeTurnQueue;
	private readonly subagentStore: DiscordSubagentStore;
	private readonly voiceSupervisorDelegate: VoiceSupervisorDelegateHandle | undefined;
	private runtime: AgentSessionRuntime | undefined;
	private createRuntime: CreateAgentSessionRuntimeFactory | undefined;
	private createVoiceRuntime: CreateAgentSessionRuntimeFactory | undefined;
	private cwd: string | undefined;
	private handle: ClankyAgentDiscordGatewayHandle | undefined;
	private voiceHandle: ClankyAgentDiscordVoiceHandle | undefined;
	private voiceOnlyClient: ClankyAgentDiscordGatewayHandle["client"] | undefined;
	private handleClientSupportsVoice = false;
	private voiceConfigError: string | undefined;

	constructor(input: {
		authStorage: AuthStorage;
		paths: ClankyPaths;
		bridgeLogPath?: string;
		voiceLogPath?: string;
		env?: NodeJS.ProcessEnv;
		readVoiceSettings?: () => StoredDiscordVoiceSettings | undefined;
		runtimeTurnQueue?: RuntimeTurnQueue;
		voiceSupervisorDelegate?: VoiceSupervisorDelegateHandle;
		dependencies?: ClankyDiscordGatewayControllerDependencies;
	}) {
		this.authStorage = input.authStorage;
		this.paths = input.paths;
		this.bridgeLogPath = input.bridgeLogPath;
		this.voiceLogPath = input.voiceLogPath;
		this.env = input.env ?? process.env;
		this.readVoiceSettings = input.readVoiceSettings;
		this.runtimeTurnQueue = input.runtimeTurnQueue ?? new SerialRuntimeTurnQueue();
		this.subagentStore = new DiscordSubagentStore(input.paths);
		this.voiceSupervisorDelegate = input.voiceSupervisorDelegate;
		this.dependencies = {
			createClient: input.dependencies?.createClient ?? createAgentDiscordClient,
			loginClient: input.dependencies?.loginClient ?? loginAgentDiscordClient,
			startGateway: input.dependencies?.startGateway ?? startAgentDiscordGateway,
			startVoice: input.dependencies?.startVoice ?? startAgentDiscordVoiceBridge,
		};
	}

	bindRuntime(runtime: AgentSessionRuntime): void {
		this.runtime = runtime;
	}

	bindSubagentRuntimeFactory(
		createRuntime: CreateAgentSessionRuntimeFactory,
		cwd: string,
		createVoiceRuntime?: CreateAgentSessionRuntimeFactory,
	): void {
		this.createRuntime = createRuntime;
		this.createVoiceRuntime = createVoiceRuntime;
		this.cwd = cwd;
	}

	async start(options: DiscordVoiceStartOptions = {}): Promise<void> {
		if (this.handle !== undefined || this.voiceHandle !== undefined) return;
		if (this.runtime === undefined) {
			throw new Error("ClankyDiscordGatewayController.start: runtime not bound");
		}
		this.voiceConfigError = undefined;
		this.reportVoiceProgress(options, {
			phase: "resolving_config",
			message: "Resolving Discord voice configuration.",
		});
		const discordCredentials = resolveAgentDiscordCredentialConfig(this.env, this.authStorage);
		const discordConfig = resolveAgentDiscordGatewayConfig(this.env, this.authStorage);
		const storedVoiceSettings = this.readVoiceSettings?.();
		let voiceConfig: ReturnType<typeof resolveAgentDiscordVoiceConfig>;
		try {
			voiceConfig = resolveAgentDiscordVoiceConfig(this.env, discordCredentials, this.authStorage, storedVoiceSettings);
		} catch (error) {
			if (isDiscordVoiceExplicitlyEnabledByEnv(this.env)) throw error;
			const message = error instanceof Error ? error.message : String(error);
			this.voiceConfigError = message;
			this.logBridge(`voice-config-skipped error=${message}`);
			voiceConfig = undefined;
		}
		const client =
			discordCredentials !== undefined && voiceConfig !== undefined
				? this.dependencies.createClient({ voice: true, chat: discordConfig !== undefined })
				: undefined;
		if (client !== undefined) {
			this.reportVoiceProgress(options, {
				phase: "creating_client",
				message: "Preparing Discord voice-capable client.",
				...voiceProgressTarget(voiceConfig),
			});
		}
		const startInput: Parameters<typeof startAgentDiscordGateway>[0] = {
			runtime: this.runtime,
			authStorage: this.authStorage,
			runtimeTurnQueue: this.runtimeTurnQueue,
		};
		if (this.createRuntime !== undefined) {
			startInput.createSubagentRuntime = this.createRuntime;
			startInput.subagentStore = this.subagentStore;
			startInput.subagentSessionDir = this.paths.subagentSessionsDir;
			startInput.subagentCwd = this.cwd ?? this.runtime.cwd;
		}
		if (discordConfig !== undefined) startInput.config = discordConfig;
		if (client !== undefined) startInput.client = client;
		if (this.bridgeLogPath !== undefined) startInput.bridgeLogPath = this.bridgeLogPath;
		try {
			this.handle = discordConfig === undefined ? undefined : await this.dependencies.startGateway(startInput);
			this.handleClientSupportsVoice = this.handle !== undefined && client !== undefined;
			if (
				this.handle === undefined &&
				client !== undefined &&
				discordCredentials !== undefined &&
				voiceConfig !== undefined
			) {
				this.reportVoiceProgress(options, {
					phase: "logging_in_client",
					message: "Logging in Discord voice client.",
					...voiceProgressTarget(voiceConfig),
				});
				await this.dependencies.loginClient(client, discordCredentials);
				this.voiceOnlyClient = client;
			}
		} catch (error) {
			client?.destroy();
			throw error;
		}
		const voiceClient = this.handle?.client ?? this.voiceOnlyClient;
		if (voiceClient !== undefined && discordCredentials !== undefined && voiceConfig !== undefined) {
			try {
				this.reportVoiceProgress(options, {
					phase: "waiting_for_client_ready",
					message: "Waiting for Discord voice client to become ready.",
					...voiceProgressTarget(voiceConfig),
				});
				await waitForDiscordClientReady(voiceClient);
				this.reportVoiceProgress(options, {
					phase: "starting_voice_bridge",
					message: "Starting Discord voice bridge.",
					...voiceProgressTarget(voiceConfig),
				});
				this.voiceHandle = await this.dependencies.startVoice({
					runtime: this.runtime,
					client: voiceClient,
					discordConfig: discordCredentials,
					authStorage: this.authStorage,
					config: voiceConfig,
					runtimeTurnQueue: this.runtimeTurnQueue,
					...(this.createRuntime === undefined
						? {}
						: {
								createSubagentRuntime: this.createRuntime,
								subagentStore: this.subagentStore,
								subagentSessionDir: this.paths.subagentSessionsDir,
								subagentCwd: this.cwd ?? this.runtime.cwd,
							}),
					...(this.createVoiceRuntime === undefined ? {} : { createVoiceSubagentRuntime: this.createVoiceRuntime }),
					...(this.voiceSupervisorDelegate === undefined
						? {}
						: { voiceSupervisorDelegate: this.voiceSupervisorDelegate }),
					...(this.bridgeLogPath === undefined ? {} : { bridgeLogPath: this.bridgeLogPath }),
					...(this.voiceLogPath === undefined ? {} : { voiceLogPath: this.voiceLogPath }),
				});
				this.reportVoiceProgress(options, {
					phase: "ready",
					message: "Discord voice client is ready.",
					...voiceProgressTarget(voiceConfig),
				});
			} catch (error) {
				await this.stop();
				throw error;
			}
		}
	}

	async restart(): Promise<void> {
		if (this.runtime === undefined) {
			throw new Error("ClankyDiscordGatewayController.restart: runtime not bound");
		}
		await this.stop();
		await this.start();
	}

	async restartVoice(options: DiscordVoiceStartOptions = {}): Promise<void> {
		if (this.runtime === undefined) {
			throw new Error("ClankyDiscordGatewayController.restartVoice: runtime not bound");
		}
		this.voiceConfigError = undefined;
		if (this.voiceHandle !== undefined) {
			this.reportVoiceProgress(options, {
				phase: "stopping_existing",
				message: "Stopping existing Discord voice bridge.",
			});
		}
		await this.voiceHandle?.stop();
		this.voiceHandle = undefined;

		this.reportVoiceProgress(options, {
			phase: "resolving_config",
			message: "Resolving Discord voice configuration.",
		});
		const discordCredentials = resolveAgentDiscordCredentialConfig(this.env, this.authStorage);
		let voiceConfig: ReturnType<typeof resolveAgentDiscordVoiceConfig>;
		try {
			voiceConfig = resolveAgentDiscordVoiceConfig(
				this.env,
				discordCredentials,
				this.authStorage,
				this.readVoiceSettings?.(),
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.voiceConfigError = message;
			this.logBridge(`voice-config-skipped error=${message}`);
			if (isDiscordVoiceExplicitlyEnabledByEnv(this.env)) throw error;
			return;
		}
		if (discordCredentials === undefined || voiceConfig === undefined) {
			this.reportVoiceProgress(options, {
				phase: "skipped",
				message: "Discord voice is not configured.",
			});
			return;
		}

		let voiceClient = this.voiceOnlyClient;
		if (voiceClient === undefined && this.handle !== undefined && this.handleClientSupportsVoice) {
			voiceClient = this.handle.client;
		}
		if (voiceClient === undefined) {
			this.reportVoiceProgress(options, {
				phase: "creating_client",
				message: "Creating Discord voice client.",
				...voiceProgressTarget(voiceConfig),
			});
			voiceClient = this.dependencies.createClient({ voice: true, chat: false });
			try {
				this.reportVoiceProgress(options, {
					phase: "logging_in_client",
					message: "Logging in Discord voice client.",
					...voiceProgressTarget(voiceConfig),
				});
				await this.dependencies.loginClient(voiceClient, discordCredentials);
				this.voiceOnlyClient = voiceClient;
			} catch (error) {
				voiceClient.destroy();
				throw error;
			}
		}

		const usingVoiceOnlyClient = voiceClient === this.voiceOnlyClient;
		try {
			this.reportVoiceProgress(options, {
				phase: "waiting_for_client_ready",
				message: "Waiting for Discord voice client to become ready.",
				...voiceProgressTarget(voiceConfig),
			});
			await waitForDiscordClientReady(voiceClient);
			this.reportVoiceProgress(options, {
				phase: "starting_voice_bridge",
				message: "Starting Discord voice bridge.",
				...voiceProgressTarget(voiceConfig),
			});
			this.voiceHandle = await this.dependencies.startVoice({
				runtime: this.runtime,
				client: voiceClient,
				discordConfig: discordCredentials,
				authStorage: this.authStorage,
				config: voiceConfig,
				runtimeTurnQueue: this.runtimeTurnQueue,
				...(this.createRuntime === undefined
					? {}
					: {
							createSubagentRuntime: this.createRuntime,
							subagentStore: this.subagentStore,
							subagentSessionDir: this.paths.subagentSessionsDir,
							subagentCwd: this.cwd ?? this.runtime.cwd,
						}),
				...(this.createVoiceRuntime === undefined ? {} : { createVoiceSubagentRuntime: this.createVoiceRuntime }),
				...(this.voiceSupervisorDelegate === undefined
					? {}
					: { voiceSupervisorDelegate: this.voiceSupervisorDelegate }),
				...(this.bridgeLogPath === undefined ? {} : { bridgeLogPath: this.bridgeLogPath }),
				...(this.voiceLogPath === undefined ? {} : { voiceLogPath: this.voiceLogPath }),
			});
			this.reportVoiceProgress(options, {
				phase: "ready",
				message: "Discord voice client is ready.",
				...voiceProgressTarget(voiceConfig),
			});
		} catch (error) {
			if (usingVoiceOnlyClient) {
				this.voiceOnlyClient?.destroy();
				this.voiceOnlyClient = undefined;
			}
			throw error;
		}
	}

	async stop(): Promise<void> {
		await this.voiceHandle?.stop();
		this.voiceHandle = undefined;
		if (this.voiceOnlyClient !== undefined) {
			this.voiceOnlyClient.destroy();
			this.voiceOnlyClient = undefined;
		}
		if (this.handle === undefined) return;
		await this.handle.stop();
		this.handle = undefined;
		this.handleClientSupportsVoice = false;
	}

	hasActiveBridge(): boolean {
		return this.handle !== undefined || this.voiceHandle !== undefined;
	}

	mainSessionContext(input: MainSessionContextToolInput): unknown {
		return readMainSessionContext(this.runtime, input);
	}

	delegateToMainWorker(input: DelegateToMainWorkerToolInput): unknown {
		return delegateToMainWorker(input, {
			runtime: this.runtime,
			runtimeTurnQueue: this.runtimeTurnQueue,
			log: (line) => this.logBridge(line),
		});
	}

	async sendSubagentMessage(input: SendSubagentMessageInput): Promise<SendSubagentMessageResult> {
		const text = input.text.trim();
		const id = input.id.trim();
		if (id.length === 0 || text.length === 0) {
			return { accepted: false, message: "Subagent id and message are required." };
		}
		const textResult = await this.handle?.sendSubagentMessage?.({ id, text });
		if (textResult !== undefined) return textResult;
		const voiceResult = await this.voiceHandle?.sendSubagentMessage?.({ id, text });
		if (voiceResult !== undefined) return voiceResult;
		return {
			accepted: false,
			message: "That subagent is not attached to an active Clanky runtime in this process.",
		};
	}

	setSubagentThinkingLevel(level: ClankyThinkingLevel): number {
		return (
			(this.handle?.setSubagentThinkingLevel?.(level) ?? 0) + (this.voiceHandle?.setSubagentThinkingLevel?.(level) ?? 0)
		);
	}

	requestVoiceTextUtterance(text: string): void {
		if (this.voiceHandle === undefined) throw new Error("Discord voice bridge is not active.");
		this.voiceHandle.requestTextUtterance(text);
	}

	private reportVoiceProgress(options: DiscordVoiceStartOptions, progress: DiscordVoiceStartProgress): void {
		options.onProgress?.(progress);
	}

	status(): JsonRecord {
		const voice = this.voiceHandle?.status();
		const status: JsonRecord = {
			textBridgeActive: this.handle !== undefined,
			voiceBridgeActive: this.voiceHandle !== undefined && (!isRecord(voice) || voice.active !== false),
			voiceOnlyClientActive: this.voiceOnlyClient !== undefined,
			voice,
		};
		if (this.voiceConfigError !== undefined) status.voiceConfigError = this.voiceConfigError;
		return status;
	}

	private logBridge(line: string): void {
		if (this.bridgeLogPath === undefined) return;
		appendFile(this.bridgeLogPath, `${new Date().toISOString()} ${line}\n`).catch((error: unknown) => {
			console.error(`discord-controller log failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	}
}

function isDiscordVoiceExplicitlyEnabledByEnv(env: NodeJS.ProcessEnv): boolean {
	const value = env.CLANKY_DISCORD_VOICE_ENABLED ?? env.CLANKY_DISCORD_VOICE;
	const normalized = value?.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function voiceProgressTarget(
	config: ReturnType<typeof resolveAgentDiscordVoiceConfig>,
): Pick<DiscordVoiceStartProgress, "guildId" | "channelId"> {
	if (config === undefined) return {};
	return {
		...(typeof config.guildId === "string" && config.guildId.length > 0 ? { guildId: config.guildId } : {}),
		...(typeof config.channelId === "string" && config.channelId.length > 0 ? { channelId: config.channelId } : {}),
	};
}

async function waitForDiscordClientReady(client: ClankyAgentDiscordGatewayHandle["client"]): Promise<void> {
	const deadline = Date.now() + DISCORD_CLIENT_READY_TIMEOUT_MS;
	while (!client.isReady()) {
		if (Date.now() >= deadline) {
			throw new Error("Discord client did not become ready before starting voice.");
		}
		await sleep(DISCORD_CLIENT_READY_POLL_MS);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
