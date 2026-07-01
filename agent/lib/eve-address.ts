/**
 * Eve server address resolution shared by every Clanky process.
 *
 * Two distinct address concepts exist and historically shared one env var
 * (CLANKY_EVE_HOST), which broke iOS-cold-started brains: the lifecycle script
 * exported a bind host ("127.0.0.1") that agent-side code then used as a fetch
 * base URL. They are now separate:
 *
 *   CLANKY_EVE_PORT       eve/relay port (default 2000)
 *   CLANKY_EVE_BIND_HOST  interface the owned eve dev server binds to
 *                         (e.g. "127.0.0.1" or "0.0.0.0"); never a URL
 *   CLANKY_EVE_BASE_URL   base URL other processes use to reach the server
 *                         (e.g. "http://127.0.0.1:2000"); always a URL
 *
 * Legacy compat: CLANKY_EVE_HOST is still honored. If it parses as an http(s)
 * URL it is treated as the base URL; otherwise as the bind host.
 */

export const DEFAULT_EVE_PORT = 2000;

/** Parse a port env value, throwing a clear message on invalid input. */
export function parsePortValue(value: string | undefined, fallback: number, envName = "CLANKY_EVE_PORT"): number {
	const raw = value?.trim();
	if (raw === undefined || raw.length === 0) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isInteger(parsed) || String(parsed) !== raw || parsed < 1 || parsed > 65_535) {
		throw new Error(`${envName} must be an integer from 1 to 65535; got ${JSON.stringify(value)}`);
	}
	return parsed;
}

export function resolveEvePort(env: NodeJS.ProcessEnv = process.env): number {
	return parsePortValue(env.CLANKY_EVE_PORT, DEFAULT_EVE_PORT);
}

function asHttpUrl(value: string | undefined): URL | undefined {
	const trimmed = value?.trim();
	if (trimmed === undefined || trimmed.length === 0) return undefined;
	try {
		const url = new URL(trimmed);
		return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Interface the owned eve dev server should bind to, or undefined to keep
 * eve's own default. A legacy CLANKY_EVE_HOST value counts only when it is a
 * bare host (not a URL).
 */
export function resolveEveBindHost(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const bind = env.CLANKY_EVE_BIND_HOST?.trim();
	if (bind !== undefined && bind.length > 0) return bind;
	const legacy = env.CLANKY_EVE_HOST?.trim();
	if (legacy !== undefined && legacy.length > 0 && asHttpUrl(legacy) === undefined) return legacy;
	return undefined;
}

/**
 * Base URL for reaching the eve server from this machine. A legacy
 * CLANKY_EVE_HOST value counts only when it is a full http(s) URL; a bind-host
 * value ("127.0.0.1", "0.0.0.0") never leaks into fetch targets.
 */
export function resolveEveBaseUrl(port: number, env: NodeJS.ProcessEnv = process.env): string {
	const configured = asHttpUrl(env.CLANKY_EVE_BASE_URL) ?? asHttpUrl(env.CLANKY_EVE_HOST);
	if (configured !== undefined) return configured.origin;
	return `http://127.0.0.1:${port}`;
}
