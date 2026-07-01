// Live smoke for the iOS chat pane-mirror seam (ADR-0004, VUH-352). Requires
// running inside a herdr session (HERDR_ENV=1). Uses a throwaway workspace label
// so it never touches a real "Clanky" workspace. Asserts the one-pane invariant
// (each chat tab has exactly one pane and the workspace keeps no orphan default
// tab), idempotent revalidation, tab re-root, and chat.close teardown, then closes
// every workspace/tab/pane it created.
import { randomUUID } from "node:crypto";
import { herdrRequest } from "../agent/lib/herdr-socket.ts";
import { closeIosChatMirror, mirrorIosChat } from "../agent/lib/ios/chat-mirror-spawn.ts";

if (process.env.HERDR_ENV !== "1") {
	console.error("ios-chat-mirror smoke requires running inside herdr (HERDR_ENV=1)");
	process.exit(1);
}

const LABEL = `Clanky-smoke-${randomUUID().slice(0, 8)}`;
process.env.CLANKY_IOS_WORKSPACE_LABEL = LABEL;
delete process.env.CLANKY_IOS_WORKSPACE_ID;

function check(name: string, condition: boolean): void {
	if (!condition) throw new Error(name);
	console.log(`ok    ${name}`);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function newSessionId(): string {
	return `smoke-sess-${randomUUID()}`;
}

async function tabPaneCount(tabId: string): Promise<number> {
	const tab = asRecord(asRecord(await herdrRequest("tab.get", { tab_id: tabId }))?.tab);
	return typeof tab?.pane_count === "number" ? tab.pane_count : -1;
}

async function workspaceTabIds(workspaceId: string): Promise<string[]> {
	const tabs = asRecord(await herdrRequest("tab.list", { workspace_id: workspaceId }))?.tabs;
	if (!Array.isArray(tabs)) return [];
	return tabs.flatMap((entry) => {
		const id = asRecord(entry)?.tab_id;
		return typeof id === "string" ? [id] : [];
	});
}

async function tabAlive(tabId: string): Promise<boolean> {
	return herdrRequest("tab.get", { tab_id: tabId }).then(
		() => true,
		() => false,
	);
}

async function workspaceLabelFor(workspaceId: string): Promise<string | undefined> {
	const workspaces = asRecord(await herdrRequest("workspace.list"))?.workspaces;
	if (!Array.isArray(workspaces)) return undefined;
	for (const entry of workspaces) {
		const record = asRecord(entry);
		if (record?.workspace_id === workspaceId) return typeof record.label === "string" ? record.label : undefined;
	}
	return undefined;
}

async function workspaceIdByLabel(label: string): Promise<string | undefined> {
	const workspaces = asRecord(await herdrRequest("workspace.list").catch(() => undefined))?.workspaces;
	if (!Array.isArray(workspaces)) return undefined;
	for (const entry of workspaces) {
		const record = asRecord(entry);
		if (record?.label === label && typeof record.workspace_id === "string") return record.workspace_id;
	}
	return undefined;
}

async function cleanup(workspaceId: string | undefined): Promise<void> {
	const id = workspaceId ?? (await workspaceIdByLabel(LABEL));
	if (id !== undefined) await herdrRequest("workspace.close", { workspace_id: id }).catch(() => undefined);
}

let workspaceId: string | undefined;

try {
	// First chat reuses the workspace's initial tab -> exactly one pane, no orphan.
	const slugA = `a-${randomUUID().slice(0, 6)}`;
	const chatA = await mirrorIosChat({ sessionId: newSessionId(), slug: slugA, title: "Smoke Chat A" });
	workspaceId = chatA.workspace_id;
	check("first chat returns handles", chatA.workspace_id.length > 0 && chatA.tab_id.length > 0 && chatA.pane_id.length > 0);
	check("dedicated workspace uses the label", (await workspaceLabelFor(chatA.workspace_id)) === LABEL);
	check("first chat tab has exactly one pane", (await tabPaneCount(chatA.tab_id)) === 1);
	check("workspace holds a single tab (no orphan default)", (await workspaceTabIds(chatA.workspace_id)).length === 1);

	// Second chat: a distinct one-pane tab in the same workspace.
	const slugB = `b-${randomUUID().slice(0, 6)}`;
	const chatB = await mirrorIosChat({ sessionId: newSessionId(), slug: slugB, title: "Smoke Chat B" });
	check("second chat shares the workspace", chatB.workspace_id === chatA.workspace_id);
	check("second chat is a distinct tab", chatB.tab_id !== chatA.tab_id);
	check("second chat tab has exactly one pane", (await tabPaneCount(chatB.tab_id)) === 1);
	check("workspace now holds two tabs", (await workspaceTabIds(chatA.workspace_id)).length === 2);

	// Revalidation with the live handles is a no-op: same pane and tab.
	const revalidated = await mirrorIosChat({ sessionId: newSessionId(), slug: slugA, tabId: chatA.tab_id, paneId: chatA.pane_id });
	check("revalidation reuses the live pane", revalidated.pane_id === chatA.pane_id && revalidated.tab_id === chatA.tab_id);

	// Re-root by tab handle when the remembered pane is stale: alive tab, bogus pane.
	const rerooted = await mirrorIosChat({ sessionId: newSessionId(), slug: slugA, tabId: chatA.tab_id, paneId: "does-not-exist" });
	check("re-root keeps the mirror one-pane", (await tabPaneCount(rerooted.tab_id)) === 1);
	check("re-root replaces the old tab", !(await tabAlive(chatA.tab_id)));
	check("workspace still holds two tabs after re-root", (await workspaceTabIds(chatA.workspace_id)).length === 2);

	// chat.close with close_tab removes chat B's presence entirely.
	const closeB = await closeIosChatMirror({ tabId: chatB.tab_id, paneId: chatB.pane_id, closeTab: true });
	check("close B acks", closeB.closed_tab === true && closeB.closed_pane === true);
	check("chat B tab is gone", !(await tabAlive(chatB.tab_id)));
	check("workspace holds one tab after close", (await workspaceTabIds(chatA.workspace_id)).length === 1);

	console.log("\nALL OK");
	await cleanup(workspaceId);
	process.exit(0);
} catch (error) {
	console.error(`\nFAIL: ${(error as Error).message}`);
	await cleanup(workspaceId);
	process.exit(1);
}
