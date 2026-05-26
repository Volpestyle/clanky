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

type JsonRecord = Record<string, unknown>;

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
	private readonly env: NodeJS.ProcessEnv;
	private readonly readVoiceSettings: (() => StoredDiscordVoiceSettings | undefined) | undefined;
	private readonly dependencies: ResolvedClankyDiscordGatewayControllerDependencies;
	private readonly runtimeTurnQueue: RuntimeTurnQueue;
	private readonly subagentStore: DiscordSubagentStore;
	private runtime: AgentSessionRuntime | undefined;
	private createRuntime: CreateAgentSessionRuntimeFactory | undefined;
	private cwd: string | undefined;
	private handle: ClankyAgentDiscordGatewayHandle | undefined;
	private voiceHandle: ClankyAgentDiscordVoiceHandle | undefined;
	private voiceOnlyClient: ClankyAgentDiscordGatewayHandle["client"] | undefined;
	private voiceConfigError: string | undefined;

	constructor(input: {
		authStorage: AuthStorage;
		paths: ClankyPaths;
		bridgeLogPath?: string;
		env?: NodeJS.ProcessEnv;
		readVoiceSettings?: () => StoredDiscordVoiceSettings | undefined;
		runtimeTurnQueue?: RuntimeTurnQueue;
		dependencies?: ClankyDiscordGatewayControllerDependencies;
	}) {
		this.authStorage = input.authStorage;
		this.paths = input.paths;
		this.bridgeLogPath = input.bridgeLogPath;
		this.env = input.env ?? process.env;
		this.readVoiceSettings = input.readVoiceSettings;
		this.runtimeTurnQueue = input.runtimeTurnQueue ?? new SerialRuntimeTurnQueue();
		this.subagentStore = new DiscordSubagentStore(input.paths);
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

	bindSubagentRuntimeFactory(createRuntime: CreateAgentSessionRuntimeFactory, cwd: string): void {
		this.createRuntime = createRuntime;
		this.cwd = cwd;
	}

	async start(): Promise<void> {
		if (this.handle !== undefined || this.voiceHandle !== undefined) return;
		if (this.runtime === undefined) {
			throw new Error("ClankyDiscordGatewayController.start: runtime not bound");
		}
		this.voiceConfigError = undefined;
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
			if (
				this.handle === undefined &&
				client !== undefined &&
				discordCredentials !== undefined &&
				voiceConfig !== undefined
			) {
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
					...(this.bridgeLogPath === undefined ? {} : { bridgeLogPath: this.bridgeLogPath }),
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

	setSubagentThinkingLevel(level: ClankyThinkingLevel): number {
		return this.handle?.setSubagentThinkingLevel(level) ?? 0;
	}

	requestVoiceTextUtterance(text: string): void {
		if (this.voiceHandle === undefined) throw new Error("Discord voice bridge is not active.");
		this.voiceHandle.requestTextUtterance(text);
	}

	status(): JsonRecord {
		const status: JsonRecord = {
			textBridgeActive: this.handle !== undefined,
			voiceBridgeActive: this.voiceHandle !== undefined,
			voiceOnlyClientActive: this.voiceOnlyClient !== undefined,
			voice: this.voiceHandle?.status(),
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
