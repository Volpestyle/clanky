// Offline smoke for AGENT.md ingestion caps and the mtime/size read cache
// (agent/lib/agent-md.ts). Run: node test/agent-md-cap-smoke.ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	collectAgentMdFiles,
	MAX_AGENT_MD_FILE_BYTES,
	MAX_AGENT_MD_TOTAL_BYTES,
} from "../agent/lib/agent-md.ts";

let failures = 0;
function check(label: string, ok: boolean): void {
	console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
	if (!ok) failures += 1;
}

async function main(): Promise<void> {
	const tempRoot = await mkdtemp(join(tmpdir(), "clanky-agent-md-cap-"));
	try {
		// --- per-file cap ----------------------------------------------------------
		const capDir = join(tempRoot, "cap");
		await mkdir(capDir, { recursive: true });
		await writeFile(join(capDir, "AGENTS.md"), `start-marker ${"a".repeat(MAX_AGENT_MD_FILE_BYTES * 2)} end-marker`);
		const capped = await collectAgentMdFiles({ root: capDir });
		const cappedContent = capped[0]?.content ?? "";
		check("oversized file is ingested", capped.length === 1);
		check(
			"oversized file content is truncated to the cap",
			cappedContent.length <= MAX_AGENT_MD_FILE_BYTES + 200 && cappedContent.startsWith("start-marker"),
		);
		check("truncated content is labeled", cappedContent.includes("[truncated"));
		check("truncated content drops the tail", !cappedContent.includes("end-marker"));

		// --- total cap across the ancestor chain ------------------------------------
		const chainRoot = join(tempRoot, "chain");
		let dir = chainRoot;
		const levels = Math.ceil(MAX_AGENT_MD_TOTAL_BYTES / MAX_AGENT_MD_FILE_BYTES) + 2;
		for (let level = 0; level < levels; level += 1) {
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, "AGENTS.md"), `level ${level}\n${"b".repeat(MAX_AGENT_MD_FILE_BYTES - 100)}`);
			dir = join(dir, "sub");
		}
		const chain = await collectAgentMdFiles({ root: join(dir, "..") });
		const totalBytes = chain.reduce((sum, file) => sum + Buffer.byteLength(file.content, "utf8"), 0);
		check("ancestor chain ingestion respects the total cap", totalBytes <= MAX_AGENT_MD_TOTAL_BYTES);
		check("total cap still ingests the leading files", chain.length >= 1 && chain.length < levels);

		// --- mtime/size cache -------------------------------------------------------
		const cacheDir = join(tempRoot, "cache");
		await mkdir(cacheDir, { recursive: true });
		const cachePath = join(cacheDir, "AGENTS.md");
		await writeFile(cachePath, "first version\n");
		const first = await collectAgentMdFiles({ root: cacheDir });
		check("initial read returns file content", first[0]?.content === "first version\n");

		const again = await collectAgentMdFiles({ root: cacheDir });
		check("unchanged file re-reads identically from cache", again[0]?.content === "first version\n");

		// A different size guarantees invalidation even within mtime granularity.
		await writeFile(cachePath, "second version, longer\n");
		const updated = await collectAgentMdFiles({ root: cacheDir });
		check("modified file invalidates the cache", updated[0]?.content === "second version, longer\n");

		await rm(cachePath);
		const removed = await collectAgentMdFiles({ root: cacheDir });
		check("deleted file stops being ingested", !removed.some((file) => file.path === cachePath));
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}

	console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
	process.exit(failures === 0 ? 0 : 1);
}

void main();
