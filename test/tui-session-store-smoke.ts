import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionState } from "eve/client";
import {
	readTuiSessionStore,
	rememberTuiSession,
	sessionStateId,
} from "../agent/lib/tui-session-store.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function session(state: SessionState): SessionState {
	return state;
}

const root = await mkdtemp(join(tmpdir(), "clanky-tui-sessions-"));
const path = join(root, "nested", "sessions.json");

try {
	const missing = await readTuiSessionStore(path);
	assert(missing.entries.length === 0, "missing session store should read as empty");

	const first = await rememberTuiSession(path, {
		label: "First prompt",
		lastPrompt: "First prompt with more detail",
		session: session({ continuationToken: "c1", sessionId: "s1", streamIndex: 3 }),
	}, { limit: 5 });
	assert(first?.id === "s1", "session id should be the primary persisted id");

	let store = await readTuiSessionStore(path);
	assert(store.entries.length === 1, "remember should write one entry");
	assert(store.entries[0]?.label === "First prompt", "stored entry should keep the label");
	assert(store.entries[0]?.session.streamIndex === 3, "stored entry should keep the session cursor");

	const createdAt = store.entries[0]?.createdAt;
	await rememberTuiSession(path, {
		label: "Renamed prompt",
		session: session({ continuationToken: "c1b", sessionId: "s1", streamIndex: 4 }),
	}, { limit: 5 });
	store = await readTuiSessionStore(path);
	assert(store.entries.length === 1, "remember should upsert existing session ids");
	assert(store.entries[0]?.createdAt === createdAt, "upsert should preserve createdAt");
	assert(store.entries[0]?.label === "Renamed prompt", "upsert should replace provided label");
	assert(store.entries[0]?.lastPrompt === "First prompt with more detail", "upsert should preserve omitted last prompt");
	assert(store.entries[0]?.session.streamIndex === 4, "upsert should replace session state");

	await rememberTuiSession(path, {
		label: "Second",
		session: session({ continuationToken: "c2", sessionId: "s2", streamIndex: 1 }),
	}, { limit: 2 });
	await rememberTuiSession(path, {
		label: "Third",
		session: session({ continuationToken: "c3", sessionId: "s3", streamIndex: 1 }),
	}, { limit: 2 });
	store = await readTuiSessionStore(path);
	assert(store.entries.length === 2, "session store should enforce the entry limit");
	assert(store.entries.some((entry) => entry.id === "s3"), "newest entry should be retained");
	assert(store.entries.some((entry) => entry.id === "s2"), "second newest entry should be retained");
	assert(!store.entries.some((entry) => entry.id === "s1"), "oldest entry should be trimmed");

	assert(sessionStateId(session({ continuationToken: "only-continuation", streamIndex: 0 })) === "only-continuation", "continuation token should identify sessions without ids");
	assert(sessionStateId(session({ streamIndex: 0 })) === undefined, "empty session state should not be persisted");

	const agePath = join(root, "age", "sessions.json");
	const dayMs = 24 * 60 * 60 * 1000;
	const staleIso = new Date(Date.now() - 10 * dayMs).toISOString();
	const freshIso = new Date(Date.now() - dayMs).toISOString();
	await mkdir(dirname(agePath), { recursive: true });
	await writeFile(
		agePath,
		`${JSON.stringify({
			version: 1,
			entries: [
				{ id: "stale", createdAt: staleIso, updatedAt: staleIso, session: { sessionId: "stale", streamIndex: 0 } },
				{ id: "fresh", createdAt: freshIso, updatedAt: freshIso, session: { sessionId: "fresh", streamIndex: 0 } },
			],
		})}\n`,
	);
	const pruned = await readTuiSessionStore(agePath, { maxAgeMs: 7 * dayMs });
	assert(pruned.entries.length === 1 && pruned.entries[0]?.id === "fresh", "maxAgeMs should drop sessions older than the cutoff");
	const unpruned = await readTuiSessionStore(agePath);
	assert(unpruned.entries.length === 2, "omitting maxAgeMs should retain all sessions");

	console.log("tui-session-store-smoke: ok");
} finally {
	await rm(root, { force: true, recursive: true });
}
