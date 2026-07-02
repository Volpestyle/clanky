/**
 * iOS native-chat pane mirror seam (ADR-0004, VUH-352). Each native chat binds to
 * a herdr "pane mirror" placed as a tab in a dedicated "Clanky" workspace: the
 * mirror IS the tab root — exactly one pane per chat, no orphan shell — tailing
 * the eve session's NDJSON stream read-only via scripts/discord-pane-mirror.ts.
 *
 * Unlike the Discord/voice mirror (agent/lib/discord/pane-mirror-spawn.ts), which
 * splits an agent pane near the face, the iOS mirror occupies its tab root via the
 * same one-pane herdr `layout.apply` pattern the relay `create-tab` op uses, so the
 * workspace never accumulates blank shell panes. Mirrors are viewers, not
 * performers — this path deliberately does not touch the transcript-run seam.
 */
import { herdrRequest } from "../herdr-socket.ts";
import { nonEmptyString } from "../herdr-placement.ts";
import { paneMirrorArgv } from "../pane-mirror.ts";

const DEFAULT_WORKSPACE_LABEL = "Clanky";

export interface IosChatMirrorHandles {
	workspace_id: string;
	tab_id: string;
	pane_id: string;
}

export interface MirrorIosChatInput {
	sessionId: string;
	slug: string;
	title?: string;
	/// Device-remembered handles from a prior call, used to re-place idempotently.
	tabId?: string;
	paneId?: string;
	/// Fresh-materialization target. Existing remembered handles win; if both
	/// workspace fields are set, workspaceId wins over workspaceLabel.
	workspaceId?: string;
	workspaceLabel?: string;
	/// Target herdr session (name/path). Omit for the relay's env-bound session.
	session?: string;
}

export interface CloseIosChatInput {
	tabId?: string;
	paneId?: string;
	closeTab?: boolean;
	session?: string;
}

export interface CloseIosChatResult {
	closed_pane: boolean;
	closed_tab: boolean;
}

interface WorkspaceHandle {
	workspaceId: string;
	// The freshly-minted default tab from workspace.create, held so the FIRST chat
	// re-roots it into a mirror tab instead of adding a second tab beside an
	// orphaned default. Claimed (cleared) synchronously the first time it is used.
	initialTab?: { tabId: string };
}

type WorkspaceTarget =
	| { kind: "id"; workspaceId: string }
	| { kind: "label"; label: string }
	| { kind: "default"; label: string; overrideId?: string };

// Memoize workspaces per herdr session and requested target (ids are
// session-scoped). An in-flight create is memoized too so concurrent first chats
// to the same target never double-create.
const resolvedWorkspaces = new Map<string, WorkspaceHandle>();
const pendingWorkspaces = new Map<string, Promise<WorkspaceHandle>>();

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function workspaceLabel(): string {
	return nonEmptyString(process.env.CLANKY_IOS_WORKSPACE_LABEL?.trim()) ?? DEFAULT_WORKSPACE_LABEL;
}

function isMissingTargetError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("not found") && (message.includes("workspace") || message.includes("tab"));
}

function isLastTabCloseError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("cannot close the last tab in a workspace");
}

function findWorkspaceIdByLabel(listed: unknown, label: string): string | undefined {
	const workspaces = asRecord(listed)?.workspaces;
	if (!Array.isArray(workspaces)) return undefined;
	for (const entry of workspaces) {
		const record = asRecord(entry);
		if (record !== undefined && nonEmptyString(record.label) === label) {
			const id = nonEmptyString(record.workspace_id);
			if (id !== undefined) return id;
		}
	}
	return undefined;
}

function findWorkspaceIdById(listed: unknown, workspaceId: string): string | undefined {
	const workspaces = asRecord(listed)?.workspaces;
	if (!Array.isArray(workspaces)) return undefined;
	for (const entry of workspaces) {
		const id = nonEmptyString(asRecord(entry)?.workspace_id);
		if (id === workspaceId) return id;
	}
	return undefined;
}

function workspaceTarget(input: MirrorIosChatInput): WorkspaceTarget {
	const workspaceId = nonEmptyString(input.workspaceId?.trim());
	if (workspaceId !== undefined) return { kind: "id", workspaceId };
	const label = nonEmptyString(input.workspaceLabel?.trim());
	if (label !== undefined) return { kind: "label", label };
	const overrideId = nonEmptyString(process.env.CLANKY_IOS_WORKSPACE_ID);
	return { kind: "default", label: workspaceLabel(), ...(overrideId === undefined ? {} : { overrideId }) };
}

function workspaceCacheKey(session: string | undefined, target: WorkspaceTarget): string {
	const sessionKey = session ?? "";
	switch (target.kind) {
		case "id":
			return `${sessionKey}\0id\0${target.workspaceId}`;
		case "label":
			return `${sessionKey}\0label\0${target.label}`;
		case "default":
			return `${sessionKey}\0default\0${target.overrideId ?? target.label}`;
	}
}

async function workspaceById(session: string | undefined, workspaceId: string): Promise<WorkspaceHandle> {
	const existing = findWorkspaceIdById(await herdrRequest("workspace.list", {}, session), workspaceId);
	if (existing === undefined) {
		throw new Error(`chat.mirror workspace_id '${workspaceId}' does not exist in the target herdr session`);
	}
	return { workspaceId: existing };
}

/**
 * Find a workspace by stable label or create it. A fresh workspace exposes its
 * default tab so the first chat can reuse it.
 */
async function findOrCreateWorkspaceByLabel(session: string | undefined, label: string): Promise<WorkspaceHandle> {
	const existing = findWorkspaceIdByLabel(await herdrRequest("workspace.list", {}, session), label);
	if (existing !== undefined) return { workspaceId: existing };

	const created = asRecord(await herdrRequest("workspace.create", { label, focus: false }, session));
	const workspaceId = nonEmptyString(asRecord(created?.workspace)?.workspace_id);
	if (workspaceId === undefined) throw new Error("herdr workspace.create returned no workspace id");
	const initialTabId = nonEmptyString(asRecord(created?.tab)?.tab_id);
	return { workspaceId, ...(initialTabId === undefined ? {} : { initialTab: { tabId: initialTabId } }) };
}

async function findOrCreateWorkspace(session: string | undefined, target: WorkspaceTarget): Promise<WorkspaceHandle> {
	switch (target.kind) {
		case "id":
			return workspaceById(session, target.workspaceId);
		case "label":
			return findOrCreateWorkspaceByLabel(session, target.label);
		case "default":
			if (target.overrideId !== undefined) return { workspaceId: target.overrideId };
			return findOrCreateWorkspaceByLabel(session, target.label);
	}
}

async function resolveWorkspace(session: string | undefined, target: WorkspaceTarget): Promise<WorkspaceHandle> {
	const key = workspaceCacheKey(session, target);
	const resolved = resolvedWorkspaces.get(key);
	if (resolved !== undefined) return resolved;
	const inflight = pendingWorkspaces.get(key);
	if (inflight !== undefined) return inflight;
	const promise = findOrCreateWorkspace(session, target)
		.then((handle) => {
			resolvedWorkspaces.set(key, handle);
			pendingWorkspaces.delete(key);
			return handle;
		})
		.catch((error: unknown) => {
			pendingWorkspaces.delete(key);
			throw error;
		});
	pendingWorkspaces.set(key, promise);
	return promise;
}

/**
 * Apply a one-pane tab whose sole pane runs the mirror command. Passing `tab_id`
 * re-roots (replaces) that existing tab — herdr builds the new one-pane tab and
 * closes the old one, so no shell root survives; passing `workspace_id` mints a
 * fresh one-pane tab in the workspace. Either way the resulting tab holds exactly
 * one pane: the mirror.
 */
async function applyMirrorTab(
	input: MirrorIosChatInput,
	target: { tabId: string } | { workspaceId: string },
): Promise<IosChatMirrorHandles> {
	const title = nonEmptyString(input.title);
	const params: Record<string, unknown> = {
		...("tabId" in target ? { tab_id: target.tabId } : { workspace_id: target.workspaceId }),
		...(title === undefined ? {} : { tab_label: title }),
		focus: false,
		root: { type: "pane", command: paneMirrorArgv(input.sessionId, input.slug), label: input.slug },
	};
	const layout = asRecord(asRecord(await herdrRequest("layout.apply", params, input.session))?.layout);
	const workspace_id = nonEmptyString(layout?.workspace_id);
	const tab_id = nonEmptyString(layout?.tab_id);
	const pane_id = nonEmptyString(layout?.focused_pane_id);
	if (workspace_id === undefined || tab_id === undefined || pane_id === undefined) {
		throw new Error("herdr layout.apply returned an incomplete mirror tab");
	}
	return { workspace_id, tab_id, pane_id };
}

async function applyFreshMirrorTab(input: MirrorIosChatInput): Promise<IosChatMirrorHandles> {
	const workspace = await resolveWorkspace(input.session, workspaceTarget(input));
	// Claim the workspace's default tab synchronously so a concurrent first chat
	// cannot re-root the same tab twice (JS runs this claim uninterrupted).
	const initialTab = workspace.initialTab;
	workspace.initialTab = undefined;
	return applyMirrorTab(input, initialTab === undefined ? { workspaceId: workspace.workspaceId } : { tabId: initialTab.tabId });
}

async function paneMatchesMirror(paneId: string, slug: string, session: string | undefined): Promise<IosChatMirrorHandles | undefined> {
	const pane = asRecord(asRecord(await herdrRequest("pane.get", { pane_id: paneId }, session).catch(() => undefined))?.pane);
	// A recycled pane id can point at an unrelated pane, so confirm the mirror by
	// its label (set to the chat slug when the tab was rooted) before reusing it.
	if (pane === undefined || nonEmptyString(pane.label) !== slug) return undefined;
	const workspace_id = nonEmptyString(pane.workspace_id);
	const tab_id = nonEmptyString(pane.tab_id);
	const pane_id = nonEmptyString(pane.pane_id);
	if (workspace_id === undefined || tab_id === undefined || pane_id === undefined) return undefined;
	return { workspace_id, tab_id, pane_id };
}

async function tabIsAlive(tabId: string, session: string | undefined): Promise<boolean> {
	return herdrRequest("tab.get", { tab_id: tabId }, session).then(
		() => true,
		() => false,
	);
}

async function workspaceIdForTab(tabId: string, session: string | undefined): Promise<string> {
	const tab = asRecord(asRecord(await herdrRequest("tab.get", { tab_id: tabId }, session))?.tab);
	const workspaceId = nonEmptyString(tab?.workspace_id);
	if (workspaceId === undefined) throw new Error(`herdr tab.get returned no workspace id for tab '${tabId}'`);
	return workspaceId;
}

async function closeTabOrWorkspace(tabId: string, session: string | undefined): Promise<void> {
	try {
		await herdrRequest("tab.close", { tab_id: tabId }, session);
	} catch (error) {
		if (!isLastTabCloseError(error)) throw error;
		await herdrRequest("workspace.close", { workspace_id: await workspaceIdForTab(tabId, session) }, session);
	}
}

/**
 * Materialize (or revalidate) a chat's mirror. Idempotent by handle, not by agent
 * name (the mirror is a tab-root command pane, not a registered agent):
 *   1. the remembered pane still runs this chat's mirror -> return it (no-op);
 *   2. else the remembered tab is alive -> re-root its one pane (reuse the tab);
 *   3. else resolve the requested/default workspace and apply a new one-pane tab.
 * A live remembered handle pins the chat where it already is; workspace targets
 * only affect fresh materialization.
 */
export async function mirrorIosChat(input: MirrorIosChatInput): Promise<IosChatMirrorHandles> {
	if (input.paneId !== undefined) {
		const reused = await paneMatchesMirror(input.paneId, input.slug, input.session);
		if (reused !== undefined) return reused;
	}
	if (input.tabId !== undefined && (await tabIsAlive(input.tabId, input.session))) {
		return applyMirrorTab(input, { tabId: input.tabId });
	}
	try {
		return await applyFreshMirrorTab(input);
	} catch (error) {
		// Tearing down the last chat also closes the dedicated workspace (herdr drops
		// a workspace when its final pane goes), leaving the memoized id stale. Drop
		// the matching target cache and rebuild the workspace once.
		if (!isMissingTargetError(error)) throw error;
		resolvedWorkspaces.delete(workspaceCacheKey(input.session, workspaceTarget(input)));
		return applyFreshMirrorTab(input);
	}
}

/**
 * Tear down a chat's presence. With `closeTab`, close the tab directly — that
 * removes the mirror pane with it. If Herdr refuses to close the workspace's last
 * tab, close the owning workspace instead. Otherwise close just the mirror pane,
 * leaving any sibling panes (a chat's subagents) in the tab.
 */
export async function closeIosChatMirror(input: CloseIosChatInput): Promise<CloseIosChatResult> {
	if (input.closeTab === true && input.tabId !== undefined) {
		await closeTabOrWorkspace(input.tabId, input.session);
		return { closed_pane: input.paneId !== undefined, closed_tab: true };
	}
	if (input.paneId !== undefined) {
		await herdrRequest("pane.close", { pane_id: input.paneId }, input.session);
		return { closed_pane: true, closed_tab: false };
	}
	if (input.tabId !== undefined) {
		await closeTabOrWorkspace(input.tabId, input.session);
		return { closed_pane: false, closed_tab: true };
	}
	throw new Error("chat.close requires pane_id or tab_id");
}
