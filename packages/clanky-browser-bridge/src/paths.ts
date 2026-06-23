import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface BrowserBridgePaths {
	homeDir: string;
	bridgeDir: string;
	stateFile: string;
	configFile: string;
	extensionDir: string;
	extensionKeyFile: string;
	extensionConfigFile: string;
	serverLogFile: string;
}

export interface ResolveBrowserBridgePathsOptions {
	homeDir?: string;
	env?: NodeJS.ProcessEnv;
}

export const DEFAULT_BROWSER_BRIDGE_PORT = 41783;

export function resolveBrowserBridgePort(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.CLANKY_BROWSER_BRIDGE_PORT;
	if (raw === undefined || raw.trim().length === 0) return DEFAULT_BROWSER_BRIDGE_PORT;
	const value = Number.parseInt(raw, 10);
	if (!Number.isInteger(value) || value <= 0 || value > 65535) {
		throw new Error(`CLANKY_BROWSER_BRIDGE_PORT must be a TCP port (1-65535); got ${raw}.`);
	}
	return value;
}

export function resolveBrowserBridgePaths(options: ResolveBrowserBridgePathsOptions = {}): BrowserBridgePaths {
	const env = options.env ?? process.env;
	const homeDir = resolve(options.homeDir ?? env.CLANKY_HOME ?? join(homedir(), ".clanky"));
	const bridgeDir = join(homeDir, "browser-bridge");
	return {
		homeDir,
		bridgeDir,
		stateFile: join(bridgeDir, "state.json"),
		configFile: join(bridgeDir, "config.json"),
		extensionDir: join(bridgeDir, "extension"),
		extensionKeyFile: join(bridgeDir, "extension-key.pem"),
		extensionConfigFile: join(bridgeDir, "extension", "config.json"),
		serverLogFile: join(bridgeDir, "server.log"),
	};
}
