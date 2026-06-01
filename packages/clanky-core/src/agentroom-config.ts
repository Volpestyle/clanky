import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";

export type PortableClankyChatGatewayOwner = "agent" | "room" | "off";

export interface PortableAgentRoomConfig {
	configPath: string;
	rootDir: string;
	clanky?: PortableClankyConfig;
	workTracker?: PortableWorkTrackerConfig;
}

export interface PortableClankyConfig {
	home?: string;
	homeDir?: string;
	profile?: string;
	chatGatewayOwner?: PortableClankyChatGatewayOwner;
}

export interface PortableWorkTrackerConfig {
	default: string;
	providers: Record<string, PortableWorkTrackerProviderConfig>;
}

export interface PortableWorkTrackerProviderConfig {
	type: string;
	teamId?: string;
	projectId?: string;
	baseUrl?: string;
}

export interface PortableClankyDefaults {
	config?: PortableAgentRoomConfig;
	homeDir?: string;
	profile?: string;
	env: NodeJS.ProcessEnv;
}

const AGENTROOM_CONFIG_RELATIVE_PATH = join(".agentroom", "config.yaml");

export function maybeLoadAgentRoomPortableConfig(
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): PortableAgentRoomConfig | undefined {
	const configPath = resolveAgentRoomPortableConfigPath(cwd, env);
	if (configPath === undefined) return undefined;
	try {
		const parsed = parseYamlRecord(readFileSync(configPath, "utf8"));
		const rootDir = dirname(dirname(configPath));
		const clanky = parsePortableClankyConfig(objectAt(parsed, "clanky"));
		const workTracker = parsePortableWorkTrackerConfig(objectAt(parsed, "workTracker"));
		return {
			configPath,
			rootDir,
			...(clanky !== undefined ? { clanky } : {}),
			...(workTracker !== undefined ? { workTracker } : {}),
		};
	} catch {
		return undefined;
	}
}

export function resolvePortableClankyDefaults(input: {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	explicitHomeDir?: string;
	explicitProfile?: string;
}): PortableClankyDefaults {
	const cwd = input.cwd ?? process.cwd();
	const env = input.env ?? process.env;
	const config = maybeLoadAgentRoomPortableConfig(cwd, env);
	const homeFromConfig = config?.clanky?.homeDir ?? config?.clanky?.home;
	const homeDir = input.explicitHomeDir ?? env.CLANKY_HOME ?? resolvePortablePath(config?.rootDir, homeFromConfig);
	const profile = input.explicitProfile ?? env.CLANKY_PROFILE ?? config?.clanky?.profile;
	return {
		...(config !== undefined ? { config } : {}),
		...(homeDir !== undefined ? { homeDir } : {}),
		...(profile !== undefined ? { profile } : {}),
		env: withAgentRoomPortableEnv(env, config),
	};
}

export function withAgentRoomPortableEnv(
	env: NodeJS.ProcessEnv,
	config: PortableAgentRoomConfig | undefined,
): NodeJS.ProcessEnv {
	if (config === undefined) return env;
	const next: NodeJS.ProcessEnv = { ...env };
	if (next.CLANKY_AGENTROOM_CONFIG === undefined) {
		next.CLANKY_AGENTROOM_CONFIG = config.configPath;
	}
	if (next.CLANKY_CHAT_GATEWAY_OWNER === undefined && config.clanky?.chatGatewayOwner !== undefined) {
		next.CLANKY_CHAT_GATEWAY_OWNER = config.clanky.chatGatewayOwner;
	}

	const selectedTrackerId = config.workTracker?.default;
	if (selectedTrackerId !== undefined) {
		const provider = config.workTracker?.providers[selectedTrackerId];
		if (next.CLANKY_WORK_TRACKER === undefined) next.CLANKY_WORK_TRACKER = selectedTrackerId;
		if (provider !== undefined) {
			if (next.CLANKY_WORK_TRACKER_PROVIDER_KIND === undefined) {
				next.CLANKY_WORK_TRACKER_PROVIDER_KIND = provider.type;
			}
			if (provider.teamId !== undefined && next.CLANKY_WORK_TRACKER_TEAM_ID === undefined) {
				next.CLANKY_WORK_TRACKER_TEAM_ID = provider.teamId;
			}
		}
	}

	return next;
}

function resolveAgentRoomPortableConfigPath(cwd: string, env: NodeJS.ProcessEnv): string | undefined {
	const configured = env.CLANKY_AGENTROOM_CONFIG?.trim();
	if (configured === "0" || configured === "false") return undefined;
	if (configured !== undefined && configured.length > 0) {
		return isAbsolute(configured) ? configured : resolve(cwd, configured);
	}

	let current = resolve(cwd);
	while (true) {
		const candidate = join(current, AGENTROOM_CONFIG_RELATIVE_PATH);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function resolvePortablePath(rootDir: string | undefined, value: string | undefined): string | undefined {
	if (value === undefined || value.trim().length === 0) return undefined;
	const trimmed = value.trim();
	if (isAbsolute(trimmed)) return trimmed;
	return resolve(rootDir ?? process.cwd(), trimmed);
}

function parsePortableClankyConfig(input: Record<string, unknown>): PortableClankyConfig | undefined {
	if (Object.keys(input).length === 0) return undefined;
	const home = stringAt(input, "home");
	const homeDir = stringAt(input, "homeDir");
	const profile = stringAt(input, "profile");
	const chatGatewayOwner = parseChatGatewayOwner(stringAt(input, "chatGatewayOwner"));
	return {
		...(home !== undefined ? { home } : {}),
		...(homeDir !== undefined ? { homeDir } : {}),
		...(profile !== undefined ? { profile } : {}),
		...(chatGatewayOwner !== undefined ? { chatGatewayOwner } : {}),
	};
}

function parsePortableWorkTrackerConfig(input: Record<string, unknown>): PortableWorkTrackerConfig | undefined {
	if (Object.keys(input).length === 0) return undefined;
	const defaultProvider = stringAt(input, "default");
	if (defaultProvider === undefined || defaultProvider.length === 0) return undefined;
	return {
		default: defaultProvider,
		providers: parsePortableWorkTrackerProviders(objectAt(input, "providers")),
	};
}

function parsePortableWorkTrackerProviders(
	input: Record<string, unknown>,
): Record<string, PortableWorkTrackerProviderConfig> {
	const providers: Record<string, PortableWorkTrackerProviderConfig> = {};
	for (const [id, value] of Object.entries(input)) {
		const provider = asRecord(value);
		const type = stringAt(provider, "type");
		if (type === undefined || type.length === 0) continue;
		const output: PortableWorkTrackerProviderConfig = { type };
		const teamId = stringAt(provider, "teamId");
		if (teamId !== undefined) output.teamId = teamId;
		const projectId = stringAt(provider, "projectId");
		if (projectId !== undefined) output.projectId = projectId;
		const baseUrl = stringAt(provider, "baseUrl");
		if (baseUrl !== undefined) output.baseUrl = baseUrl;
		providers[id] = output;
	}
	return providers;
}

function parseChatGatewayOwner(value: string | undefined): PortableClankyChatGatewayOwner | undefined {
	if (value === "agent" || value === "room" || value === "off") return value;
	return undefined;
}

function parseYamlRecord(text: string): Record<string, unknown> {
	return asRecord(parse(text));
}

function objectAt(value: Record<string, unknown>, key: string): Record<string, unknown> {
	return asRecord(value[key]);
}

function asRecord(value: unknown): Record<string, unknown> {
	if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	return {};
}

function stringAt(value: Record<string, unknown>, key: string): string | undefined {
	return typeof value[key] === "string" ? value[key] : undefined;
}
