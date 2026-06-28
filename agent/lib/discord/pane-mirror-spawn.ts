/**
 * Spawns a read-only herdr pane that tails a presence session's NDJSON event
 * stream through scripts/discord-pane-mirror.ts (SPEC.md §5.6). Shared by the
 * text presence path (discord-gateway) and the voice path (voice channel) so
 * both render the same expandable mirror view and never drift.
 */
import { join } from "node:path";
import { herdrRequest } from "../herdr-socket.ts";
import {
	getHerdrAgent,
	nonEmptyString,
	paneMatchesPlacement,
	resolveClankyFacePanePlacement,
	startHerdrAgentNearPlacement,
} from "../herdr-placement.ts";

function eveHost(): string {
	return process.env.CLANKY_EVE_HOST ?? "http://127.0.0.1:2000";
}

function mirrorScriptPath(): string {
	return join(process.env.CLANKY_REPO_DIR ?? process.cwd(), "scripts", "discord-pane-mirror.ts");
}

/**
 * Spawn (or re-place) the `clanky:<slug>` mirror pane for a session. The slug is
 * both the herdr agent suffix and the mirror's display label.
 */
export async function spawnSessionPaneMirror(slug: string, sessionId: string): Promise<void> {
	const agent = `clanky:${slug}`;
	const placement = await resolveClankyFacePanePlacement();
	const existing = await getHerdrAgent(agent);
	if (existing !== undefined) {
		if (paneMatchesPlacement(existing, placement)) return;
		const paneId = nonEmptyString(existing.pane_id);
		if (paneId === undefined) return;
		await herdrRequest("pane.close", { pane_id: paneId }).catch(() => undefined);
	}
	await startHerdrAgentNearPlacement({
		name: agent,
		focus: false,
		argv: [process.execPath, mirrorScriptPath(), eveHost(), sessionId, slug],
		placement,
	});
}
