import type { SwarmLeaderState, SwarmLeaderStatus } from "./lifecycle.ts";

export interface SwarmQueryResult {
	ok: boolean;
	state: SwarmLeaderState;
	message: string;
	status: SwarmLeaderStatus;
	data?: unknown;
}

export interface SwarmSnapshotResult {
	ok: boolean;
	state: SwarmLeaderState;
	message: string;
	status: SwarmLeaderStatus;
	instances?: unknown;
	tasks?: unknown;
	health?: unknown;
}
