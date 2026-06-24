import { herdrRequest } from "./herdr-socket.ts";

export type HerdrPanePlacement = { workspace_id?: string; tab_id?: string };
export type HerdrAgentRecord = Record<string, unknown>;

export async function getHerdrAgent(target: string): Promise<HerdrAgentRecord | undefined> {
	const result = await herdrRequest("agent.get", { target }).catch(() => undefined);
	return agentFromGetResult(result);
}

export async function resolveClankyFacePanePlacement(
	mainAgent = process.env.CLANKY_MAIN_AGENT ?? "clanky:main",
): Promise<HerdrPanePlacement> {
	const facePlacement = placementFromEnv("CLANKY_FACE_HERDR_WORKSPACE_ID", "CLANKY_FACE_HERDR_TAB_ID");
	if (hasPlacement(facePlacement)) return facePlacement;

	const inheritedPlacement = placementFromEnv("HERDR_WORKSPACE_ID", "HERDR_TAB_ID");
	if (hasPlacement(inheritedPlacement)) return inheritedPlacement;

	const result = await herdrRequest("agent.get", { target: mainAgent }).catch(() => undefined);
	return placementFromAgentGetResult(result);
}

export function paneMatchesPlacement(agent: HerdrAgentRecord, placement: HerdrPanePlacement): boolean {
	return (
		(placement.workspace_id === undefined || nonEmptyString(agent.workspace_id) === placement.workspace_id) &&
		(placement.tab_id === undefined || nonEmptyString(agent.tab_id) === placement.tab_id)
	);
}

export function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function placementFromEnv(workspaceEnv: string, tabEnv: string): HerdrPanePlacement {
	return buildPlacement(nonEmptyString(process.env[workspaceEnv]), nonEmptyString(process.env[tabEnv]));
}

function placementFromAgentGetResult(result: unknown): HerdrPanePlacement {
	const agent = agentFromGetResult(result);
	return buildPlacement(nonEmptyString(agent?.workspace_id), nonEmptyString(agent?.tab_id));
}

function agentFromGetResult(result: unknown): HerdrAgentRecord | undefined {
	const record = asRecord(result);
	return asRecord(record?.agent) ?? record;
}

function buildPlacement(workspaceId: string | undefined, tabId: string | undefined): HerdrPanePlacement {
	return {
		...(workspaceId === undefined ? {} : { workspace_id: workspaceId }),
		...(tabId === undefined ? {} : { tab_id: tabId }),
	};
}

function hasPlacement(placement: HerdrPanePlacement): boolean {
	return placement.workspace_id !== undefined || placement.tab_id !== undefined;
}

function asRecord(value: unknown): HerdrAgentRecord | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as HerdrAgentRecord) : undefined;
}
