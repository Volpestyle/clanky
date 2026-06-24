import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Client for the petdex desktop sidecar (https://petdex.dev). The sidecar
// listens on 127.0.0.1:7777 and drives a floating mascot: POST /state moves
// the sprite between animation rows, POST /bubble shows speech text. Both are
// gated by a per-session token at ~/.petdex/runtime/update-token (mode 0600),
// so only local processes can talk to it. The pet is optional: when CLANKY_PET
// is off, the sidecar isn't running, or the token can't be read, every call is
// a silent no-op.

// Spritesheet rows the sidecar accepts. Kept in sync with petdex's pet-states.
export type PetState =
	| "idle"
	| "running"
	| "running-left"
	| "running-right"
	| "waving"
	| "jumping"
	| "failed"
	| "review"
	| "waiting";

export interface PetClient {
	setState(state: PetState, durationMs?: number): void;
	say(text: string): void;
}

interface PetSettings {
	enabled: boolean;
	baseUrl: string;
	tokenPath: string;
}

const TOKEN_HEADER = "x-petdex-update-token";
const DEFAULT_PORT = 7777;
// The sidecar caps bubble text at 200 chars; trim here so the request body
// stays small and we don't ship multi-paragraph replies it would truncate.
const MAX_BUBBLE_CHARS = 200;
const REQUEST_TIMEOUT_MS = 1000;

function readPetSettings(env: NodeJS.ProcessEnv): PetSettings {
	const flag = env.CLANKY_PET?.trim().toLowerCase();
	const enabled = flag === "1" || flag === "true" || flag === "on";
	const parsedPort = Number.parseInt(env.CLANKY_PET_PORT?.trim() ?? "", 10);
	const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;
	const tokenPath = env.CLANKY_PET_TOKEN_PATH?.trim() || join(homedir(), ".petdex", "runtime", "update-token");
	return { enabled, baseUrl: `http://127.0.0.1:${port}`, tokenPath };
}

async function readToken(tokenPath: string): Promise<string | null> {
	try {
		const token = (await readFile(tokenPath, "utf8")).trim();
		return token.length === 0 ? null : token;
	} catch {
		return null;
	}
}

export function createPetClient(env: NodeJS.ProcessEnv = process.env): PetClient {
	const settings = readPetSettings(env);
	// The sidecar mints a fresh token each launch. Cache it, but drop the cache
	// on a 401 so the next event re-reads the rotated token from disk.
	let cachedToken: string | null = null;

	async function post(path: string, body: Record<string, unknown>): Promise<void> {
		if (!settings.enabled) return;
		if (cachedToken === null) cachedToken = await readToken(settings.tokenPath);
		if (cachedToken === null) return;
		try {
			const response = await fetch(`${settings.baseUrl}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", [TOKEN_HEADER]: cachedToken },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			if (response.status === 401) cachedToken = null;
		} catch {
			// Sidecar down or not installed — the pet is a best-effort mirror.
		}
	}

	function dispatch(path: string, body: Record<string, unknown>): void {
		void post(path, body);
	}

	return {
		setState(state, durationMs) {
			dispatch("/state", durationMs === undefined ? { state } : { state, duration: durationMs });
		},
		say(text) {
			const trimmed = text.replace(/\s+/g, " ").trim();
			if (trimmed.length === 0) return;
			dispatch("/bubble", { text: trimmed.slice(0, MAX_BUBBLE_CHARS), agent_source: "clanky" });
		},
	};
}
