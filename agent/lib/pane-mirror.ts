/**
 * Shared argv for the read-only eve-session NDJSON mirror pane
 * (scripts/discord-pane-mirror.ts, SPEC.md §5.6). Both presence placements — the
 * Discord/voice face split (agent/lib/discord/pane-mirror-spawn.ts) and the iOS
 * per-chat workspace tab (agent/lib/ios/chat-mirror-spawn.ts, ADR-0004) — launch
 * the same viewer command so the two surfaces never drift. The script tails the
 * session read-only; it is a viewer, not a performer, so it never funnels through
 * the transcript-run seam.
 */
import { join } from "node:path";
import { resolveEveBaseUrl, resolveEvePort } from "./eve-address.ts";

export function paneMirrorArgv(sessionId: string, slug: string): string[] {
	const eveHost = resolveEveBaseUrl(resolveEvePort(process.env), process.env);
	const scriptPath = join(process.env.CLANKY_REPO_DIR ?? process.cwd(), "scripts", "discord-pane-mirror.ts");
	return [process.execPath, scriptPath, eveHost, sessionId, slug];
}
