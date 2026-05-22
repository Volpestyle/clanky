import { mkdir } from "node:fs/promises";
import type { ClankyPaths, SessionRegistry } from "@clanky/core";
import type { BasePlatformAdapter } from "./adapter.ts";
import {
	type BrokerErrorEvent,
	type BrokerEventEmitter,
	type BrokerPolicyEvent,
	type BrokerReceivedEvent,
	type BrokerSentEvent,
	MessagingBroker,
	type MessagingBrokerOptions,
} from "./broker.ts";
import type { DiscordPlatformConfig, MessagingConfig, TelegramPlatformConfig } from "./config.ts";
import { configEnabled, defaultDiscordConfig, defaultTelegramConfig, loadMessagingConfigFromEnv } from "./config.ts";
import type { MemoryRetriever, MemoryWriter, MessagingPolicyGate } from "./hooks.ts";
import { type MessagingPaths, platformConfigFile, platformStateDir, resolveMessagingPaths } from "./paths.ts";
import type { Platform } from "./types.ts";

export type AdapterFactory = (
	config: TelegramPlatformConfig | DiscordPlatformConfig,
	stateDir: string,
) => BasePlatformAdapter;

export interface MessagingManagerEvents {
	onReceived?: (event: BrokerReceivedEvent) => void;
	onSent?: (event: BrokerSentEvent) => void;
	onError?: (event: BrokerErrorEvent) => void;
	onPolicy?: (event: BrokerPolicyEvent) => void;
}

export interface MessagingManagerOptions {
	registry: SessionRegistry;
	clankyPaths: ClankyPaths;
	config?: MessagingConfig;
	policy?: MessagingPolicyGate;
	memory?: MemoryWriter;
	retriever?: MemoryRetriever;
	streamConfig?: MessagingBrokerOptions["streamConfig"];
	groupSessionsPerUser?: boolean;
	provider?: string;
	model?: string;
	adapterFactories?: Partial<Record<Platform, AdapterFactory>>;
	events?: MessagingManagerEvents;
}

export interface MessagingPlatformStatus {
	platform: Platform;
	enabled: boolean;
	connected: boolean;
	fatalError?: { code: string; message: string; retryable: boolean; at: number };
}

export interface MessagingStatus {
	telegram: MessagingPlatformStatus;
	discord: MessagingPlatformStatus;
}

export class MessagingManager {
	readonly paths: MessagingPaths;
	readonly broker: MessagingBroker;
	private readonly registry: SessionRegistry;
	private readonly config: MessagingConfig;
	private readonly adapterFactories: Partial<Record<Platform, AdapterFactory>>;
	private readonly events: MessagingManagerEvents;
	private adapters = new Map<Platform, BasePlatformAdapter>();
	private started = false;

	constructor(options: MessagingManagerOptions) {
		this.registry = options.registry;
		this.paths = resolveMessagingPaths(options.clankyPaths);
		this.config = options.config ?? loadMessagingConfigFromEnv();
		this.adapterFactories = options.adapterFactories ?? {};
		this.events = options.events ?? {};

		const brokerOptions: MessagingBrokerOptions = {
			registry: this.registry,
			sessionsStoreFile: this.paths.telegramSessionsFile,
			events: this.createEmitter(),
		};
		if (options.policy !== undefined) brokerOptions.policy = options.policy;
		if (options.memory !== undefined) brokerOptions.memory = options.memory;
		if (options.retriever !== undefined) brokerOptions.retriever = options.retriever;
		if (options.streamConfig !== undefined) brokerOptions.streamConfig = options.streamConfig;
		if (options.groupSessionsPerUser !== undefined) brokerOptions.groupSessionsPerUser = options.groupSessionsPerUser;
		if (options.provider !== undefined) brokerOptions.provider = options.provider;
		if (options.model !== undefined) brokerOptions.model = options.model;
		this.broker = new MessagingBroker(brokerOptions);
	}

	getConfig(): MessagingConfig {
		return this.config;
	}

	getAdapter(platform: Platform): BasePlatformAdapter | undefined {
		return this.adapters.get(platform);
	}

	async start(): Promise<void> {
		if (this.started) return;
		await mkdir(this.paths.messagingDir, { recursive: true, mode: 0o700 });
		await mkdir(this.paths.telegramDir, { recursive: true, mode: 0o700 });
		await mkdir(this.paths.discordDir, { recursive: true, mode: 0o700 });
		await this.bootPlatform("telegram", this.config.telegram);
		await this.bootPlatform("discord", this.config.discord);
		this.started = true;
	}

	async close(): Promise<void> {
		const adapters = [...this.adapters.values()];
		this.adapters.clear();
		await Promise.all(adapters.map((adapter) => adapter.disconnect().catch(() => undefined)));
		this.started = false;
	}

	status(): MessagingStatus {
		return {
			telegram: this.platformStatus("telegram", this.config.telegram.enabled),
			discord: this.platformStatus("discord", this.config.discord.enabled),
		};
	}

	registerAdapter(adapter: BasePlatformAdapter): void {
		this.adapters.set(adapter.platform, adapter);
		this.broker.registerAdapter(adapter);
	}

	private async bootPlatform(
		platform: Platform,
		platformConfig: TelegramPlatformConfig | DiscordPlatformConfig,
	): Promise<void> {
		if (!configEnabled(this.config, platform)) return;
		const factory = this.adapterFactories[platform];
		if (factory === undefined) return;
		const stateDir = platformStateDir(this.paths, platform);
		await mkdir(stateDir, { recursive: true, mode: 0o700 });
		const adapter = factory(platformConfig, stateDir);
		this.registerAdapter(adapter);
		try {
			await adapter.connect();
		} catch (error) {
			this.events.onError?.({
				platform,
				chatId: "",
				error: error instanceof Error ? error.message : String(error),
				at: new Date().toISOString(),
			});
		}
	}

	private platformStatus(platform: Platform, enabled: boolean): MessagingPlatformStatus {
		const adapter = this.adapters.get(platform);
		const status: MessagingPlatformStatus = {
			platform,
			enabled,
			connected: adapter?.isConnected() ?? false,
		};
		const fatal = adapter?.getFatalError();
		if (fatal !== undefined) {
			status.fatalError = { code: fatal.code, message: fatal.message, retryable: fatal.retryable, at: fatal.at };
		}
		return status;
	}

	private createEmitter(): BrokerEventEmitter {
		return {
			emitReceived: (event) => this.events.onReceived?.(event),
			emitSent: (event) => this.events.onSent?.(event),
			emitError: (event) => this.events.onError?.(event),
			emitPolicy: (event) => this.events.onPolicy?.(event),
		};
	}
}

export function ensurePlatformConfigFiles(paths: MessagingPaths): { telegram: string; discord: string } {
	return {
		telegram: platformConfigFile(paths, "telegram"),
		discord: platformConfigFile(paths, "discord"),
	};
}

export function blankMessagingConfig(): MessagingConfig {
	return { telegram: defaultTelegramConfig(), discord: defaultDiscordConfig() };
}
