import { type ClankyPaths, DiscordSubagentStore, LinearLinkStore, LinearOutboxStore, MemoryStore } from "@clanky/core";

export interface ClankyStores {
	memory: MemoryStore;
	linearLinks: LinearLinkStore;
	linearOutbox: LinearOutboxStore;
	subagents: DiscordSubagentStore;
}

/**
 * Create the standalone clanky persistence stores rooted at the given paths.
 *
 * Each store is a lightweight wrapper around an on-disk file or sqlite db; this
 * factory just wires the right ClankyPaths fields into each constructor. None
 * of the underlying files are created here — call the store's own ensure()
 * method (or simply use it; MemoryStore lazy-creates) before reading.
 */
export function createClankyStores(paths: ClankyPaths): ClankyStores {
	return {
		memory: new MemoryStore(paths),
		linearLinks: new LinearLinkStore(paths),
		linearOutbox: new LinearOutboxStore(paths),
		subagents: new DiscordSubagentStore(paths),
	};
}
