/**
 * Owns the lifecycle of Clanky's agent-owned Discord bridge so the
 * `/discord-login` slash command can restart it after persisting new
 * credentials, without restarting the whole Clanky process.
 *
 * The runtime reference is bound after `createAgentSessionRuntime` returns,
 * since the controller has to be constructed earlier (the discord-auth
 * extension factory captures it).
 */
import type { AgentSessionRuntime, AuthStorage } from "@earendil-works/pi-coding-agent";
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
	private readonly bridgeLogPath: string | undefined;
	private readonly env: NodeJS.ProcessEnv;
	private readonly dependencies: ResolvedClankyDiscordGatewayControllerDependencies;
	private readonly runtimeTurnQueue: RuntimeTurnQueue;
	private runtime: AgentSessionRuntime | undefined;
	private handle: ClankyAgentDiscordGatewayHandle | undefined;
	private voiceHandle: ClankyAgentDiscordVoiceHandle | undefined;
	private voiceOnlyClient: ClankyAgentDiscordGatewayHandle["client"] | undefined;

	constructor(input: {
		authStorage: AuthStorage;
		bridgeLogPath?: string;
		env?: NodeJS.ProcessEnv;
		runtimeTurnQueue?: RuntimeTurnQueue;
		dependencies?: ClankyDiscordGatewayControllerDependencies;
	}) {
		this.authStorage = input.authStorage;
		this.bridgeLogPath = input.bridgeLogPath;
		this.env = input.env ?? process.env;
		this.runtimeTurnQueue = input.runtimeTurnQueue ?? new SerialRuntimeTurnQueue();
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

	async start(): Promise<void> {
		if (this.handle !== undefined || this.voiceHandle !== undefined) return;
		if (this.runtime === undefined) {
			throw new Error("ClankyDiscordGatewayController.start: runtime not bound");
		}
		const discordCredentials = resolveAgentDiscordCredentialConfig(this.env, this.authStorage);
		const discordConfig = resolveAgentDiscordGatewayConfig(this.env, this.authStorage);
		const voiceConfig = resolveAgentDiscordVoiceConfig(this.env, discordCredentials);
		const client =
			discordCredentials !== undefined && voiceConfig !== undefined
				? this.dependencies.createClient({ voice: true, chat: discordConfig !== undefined })
				: undefined;
		const startInput: Parameters<typeof startAgentDiscordGateway>[0] = {
			runtime: this.runtime,
			authStorage: this.authStorage,
			runtimeTurnQueue: this.runtimeTurnQueue,
		};
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
					config: voiceConfig,
					runtimeTurnQueue: this.runtimeTurnQueue,
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

	requestVoiceTextUtterance(text: string): void {
		if (this.voiceHandle === undefined) throw new Error("Discord voice bridge is not active.");
		this.voiceHandle.requestTextUtterance(text);
	}

	status(): JsonRecord {
		return {
			textBridgeActive: this.handle !== undefined,
			voiceBridgeActive: this.voiceHandle !== undefined,
			voiceOnlyClientActive: this.voiceOnlyClient !== undefined,
			voice: this.voiceHandle?.status(),
		};
	}
}
