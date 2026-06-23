import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

export function resolveClankyHome(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.CLANKY_HOME?.trim() || join(homedir(), ".clanky"));
}

export function resolveClankyDataPath(relativePath: string, env: NodeJS.ProcessEnv = process.env): string {
	const home = resolveClankyHome(env);
	const resolved = resolve(home, relativePath);
	// Reject absolute or `..` segments that would escape the data directory.
	if (resolved !== home && !resolved.startsWith(home + sep)) {
		throw new Error(`Clanky data path must stay inside the data directory: ${relativePath}`);
	}
	return resolved;
}
