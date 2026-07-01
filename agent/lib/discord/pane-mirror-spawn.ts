/**
 * Spawns a read-only herdr pane that tails a presence session's NDJSON event
 * stream through scripts/discord-pane-mirror.ts (SPEC.md §5.6). Shared by the
 * text presence path (discord-gateway) and the voice path (voice channel) so
 * both render the same expandable mirror view and never drift.
 */
import { herdrRequest } from "../herdr-socket.ts";
import {
	getHerdrAgent,
	nonEmptyString,
	paneMatchesPlacement,
	resolveClankyFacePanePlacement,
	startHerdrAgentNearPlacement,
} from "../herdr-placement.ts";
import { paneMirrorArgv } from "../pane-mirror.ts";

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
		argv: paneMirrorArgv(sessionId, slug),
		placement,
	});
}
