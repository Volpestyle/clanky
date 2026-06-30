import { herdrRequest } from "./herdr-socket.ts";

export type HerdrPanePlacement = {
	workspace_id?: string;
	tab_id?: string;
	target_pane_id?: string;
};
export type HerdrAgentRecord = Record<string, unknown>;
export type HerdrSplitDirection = "right" | "down";

export interface StartHerdrAgentInput {
	name: string;
	argv: readonly string[];
	cwd?: string;
	focus?: boolean;
	split?: HerdrSplitDirection;
	placement?: HerdrPanePlacement;
	/// Target herdr session (name/path). Omit for the relay's env-bound session.
	session?: string;
}

interface PaneLayoutRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface PaneLayoutPane {
	pane_id: string;
	rect: PaneLayoutRect;
}

interface PaneMovePlan {
	tabId: string;
	targetPaneId: string;
	split: HerdrSplitDirection;
	ratio?: number;
}

export async function getHerdrAgent(target: string): Promise<HerdrAgentRecord | undefined> {
	const result = await herdrRequest("agent.get", { target }).catch(() => undefined);
	return agentFromGetResult(result);
}

export async function resolveClankyFacePanePlacement(
	mainAgent = process.env.CLANKY_MAIN_AGENT ?? "clanky:main",
	session?: string,
): Promise<HerdrPanePlacement> {
	const facePlacement = placementFromEnv(
		"CLANKY_FACE_HERDR_WORKSPACE_ID",
		"CLANKY_FACE_HERDR_TAB_ID",
		"CLANKY_FACE_HERDR_PANE_ID",
	);
	if (hasPlacement(facePlacement)) return facePlacement;

	const inheritedPlacement = placementFromEnv(
		"HERDR_WORKSPACE_ID",
		"HERDR_TAB_ID",
		"HERDR_PANE_ID",
	);
	if (hasPlacement(inheritedPlacement)) return inheritedPlacement;

	const result = await herdrRequest("agent.get", { target: mainAgent }, session).catch(() => undefined);
	return placementFromAgentGetResult(result);
}

export async function startHerdrAgentNearPlacement(input: StartHerdrAgentInput): Promise<unknown> {
	const split = input.split ?? "right";
	const params: Record<string, unknown> = {
		name: input.name,
		argv: [...input.argv],
		focus: input.focus === true,
		...(input.cwd === undefined ? {} : { cwd: input.cwd }),
		split,
		...startPlacement(input.placement),
	};
	const result = await herdrRequest("agent.start", params, input.session);
	await ensureHerdrAgentRecordNearPlacement(agentFromGetResult(result), input.placement, split, input.session);
	return result;
}

export async function ensureHerdrAgentRecordNearPlacement(
	agent: HerdrAgentRecord | undefined,
	placement: HerdrPanePlacement | undefined,
	split: HerdrSplitDirection = "right",
	session?: string,
): Promise<void> {
	if (placement === undefined) return;
	const targetPaneId = placement?.target_pane_id;
	if (targetPaneId === undefined) return;
	const paneId = nonEmptyString(agent?.pane_id);
	if (paneId === undefined || paneId === targetPaneId) return;
	const plan = await resolveMovePlan(placement, agent, split, paneId, session);
	if (plan === undefined) return;
	const destination: Record<string, unknown> = {
		type: "tab",
		tab_id: plan.tabId,
		target_pane_id: plan.targetPaneId,
		split: plan.split,
	};
	if (plan.ratio !== undefined) destination.ratio = plan.ratio;
	await herdrRequest("pane.move", {
		pane_id: paneId,
		destination,
		focus: false,
	}, session);
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

function placementFromEnv(workspaceEnv: string, tabEnv: string, paneEnv: string): HerdrPanePlacement {
	return buildPlacement(
		nonEmptyString(process.env[workspaceEnv]),
		nonEmptyString(process.env[tabEnv]),
		nonEmptyString(process.env[paneEnv]),
	);
}

function placementFromAgentGetResult(result: unknown): HerdrPanePlacement {
	const agent = agentFromGetResult(result);
	return buildPlacement(
		nonEmptyString(agent?.workspace_id),
		nonEmptyString(agent?.tab_id),
		nonEmptyString(agent?.pane_id),
	);
}

function agentFromGetResult(result: unknown): HerdrAgentRecord | undefined {
	const record = asRecord(result);
	return asRecord(record?.agent) ?? record;
}

function buildPlacement(workspaceId: string | undefined, tabId: string | undefined, paneId: string | undefined): HerdrPanePlacement {
	return {
		...(workspaceId === undefined ? {} : { workspace_id: workspaceId }),
		...(tabId === undefined ? {} : { tab_id: tabId }),
		...(paneId === undefined ? {} : { target_pane_id: paneId }),
	};
}

function hasPlacement(placement: HerdrPanePlacement): boolean {
	return placement.workspace_id !== undefined || placement.tab_id !== undefined || placement.target_pane_id !== undefined;
}

function startPlacement(placement: HerdrPanePlacement | undefined): HerdrPanePlacement {
	return {
		...(placement?.workspace_id === undefined ? {} : { workspace_id: placement.workspace_id }),
		...(placement?.tab_id === undefined ? {} : { tab_id: placement.tab_id }),
	};
}

async function resolveMovePlan(
	placement: HerdrPanePlacement,
	agent: HerdrAgentRecord | undefined,
	split: HerdrSplitDirection,
	movedPaneId: string,
	session?: string,
): Promise<PaneMovePlan | undefined> {
	const targetPaneId = placement.target_pane_id;
	if (targetPaneId === undefined) return undefined;
	const fallbackTabId = placement.tab_id ?? nonEmptyString(agent?.tab_id);
	if (split !== "right") {
		return fallbackTabId === undefined ? undefined : { tabId: fallbackTabId, targetPaneId, split };
	}
	const layout = await readPaneLayout(targetPaneId, session);
	const tabId = layout?.tab_id ?? fallbackTabId;
	if (tabId === undefined) return undefined;
	const panes = (layout?.panes ?? []).filter((pane) => pane.pane_id !== movedPaneId);
	const target = panes.find((pane) => pane.pane_id === targetPaneId);
	if (target !== undefined && panes.length === 1) {
		return { tabId, targetPaneId, split, ratio: 2 / 3 };
	}
	if (target !== undefined && panes.length === 2 && isLeftColumnTarget(target, panes)) {
		return { tabId, targetPaneId, split, ratio: 0.5 };
	}
	return { tabId, targetPaneId, split };
}

async function readPaneLayout(paneId: string, session?: string): Promise<{ tab_id?: string; panes: PaneLayoutPane[] } | undefined> {
	const result = await herdrRequest("pane.layout", { pane_id: paneId }, session).catch(() => undefined);
	const layout = asRecord(asRecord(result)?.layout);
	const tabId = nonEmptyString(layout?.tab_id);
	const panesValue = Array.isArray(layout?.panes) ? layout.panes : [];
	const panes = panesValue.flatMap((pane) => {
		const record = asRecord(pane);
		const pane_id = nonEmptyString(record?.pane_id);
		const rect = rectFromValue(record?.rect);
		return pane_id === undefined || rect === undefined ? [] : [{ pane_id, rect }];
	});
	return { ...(tabId === undefined ? {} : { tab_id: tabId }), panes };
}

function rectFromValue(value: unknown): PaneLayoutRect | undefined {
	const rect = asRecord(value);
	const x = numberField(rect, "x");
	const y = numberField(rect, "y");
	const width = numberField(rect, "width");
	const height = numberField(rect, "height");
	return x === undefined || y === undefined || width === undefined || height === undefined
		? undefined
		: { x, y, width, height };
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isLeftColumnTarget(target: PaneLayoutPane, panes: readonly PaneLayoutPane[]): boolean {
	const other = panes.find((pane) => pane.pane_id !== target.pane_id);
	return (
		other !== undefined &&
		target.rect.x <= other.rect.x &&
		target.rect.y === other.rect.y &&
		target.rect.height === other.rect.height
	);
}

function asRecord(value: unknown): HerdrAgentRecord | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as HerdrAgentRecord) : undefined;
}
