/**
 * Smoke test: media_inspect resolves sandbox-staged attachment paths.
 *
 * Regression guard for the bug where user-sent images failed media_inspect
 * because eve stages inbound attachments into the sandbox vfs (e.g.
 * `/workspace/attachments/...`) while inspectVisualMedia read the host fs
 * directly. The fix falls back to the active sandbox session when a path is
 * missing on the host disk.
 *
 * Run: node test/media-inspect-sandbox-smoke.ts
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { inspectVisualMedia } from "../agent/lib/media.ts";

const SANDBOX_PATH = "/workspace/attachments/smoke/photo.jpeg";

async function findStagedAttachment(): Promise<Buffer> {
	// Reuse any real staged jpeg from the sandbox cache as representative bytes;
	// fall back to a tiny synthetic JPEG header if none exist yet.
	const { glob } = await import("node:fs/promises");
	for await (const entry of glob(".eve/sandbox-cache/**/workspace/attachments/**/*.jpeg")) {
		return await readFile(entry);
	}
	// Minimal valid JPEG SOI + APP0 + EOI so detectImageMediaType accepts it.
	return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
}

const bytes = await findStagedAttachment();

const sandbox = {
	id: "smoke",
	resolvePath: (path: string) => path,
	async readBinaryFile({ path }: { path: string }) {
		return path === SANDBOX_PATH ? bytes : null;
	},
} as unknown as NonNullable<Parameters<typeof inspectVisualMedia>[1]>["sandbox"];

const stub = async () => ({ text: "STUB DESCRIPTION" });

// 1. With a sandbox, the /workspace path resolves and inspection proceeds.
const withSandbox = await inspectVisualMedia(
	{ paths: [SANDBOX_PATH] },
	{ env: {}, sandbox, generate: stub },
);
assert.equal(withSandbox.text, "STUB DESCRIPTION", "expected stubbed inspection text");
assert.equal(withSandbox.totalRequested, 1);
assert.equal(withSandbox.items[0]?.path, SANDBOX_PATH, "item should surface the sandbox path");
console.log("ok: sandbox-staged path resolved ->", withSandbox.items[0]?.mediaType, withSandbox.items[0]?.bytes, "bytes");

// 2. Without a sandbox (and no such host file), it fails clearly instead of silently.
await assert.rejects(
	() => inspectVisualMedia({ paths: [SANDBOX_PATH] }, { env: {}, generate: stub }),
	/does not exist on the host filesystem or in the sandbox/,
	"expected a clear not-found error when no sandbox is available",
);
console.log("ok: missing path without sandbox rejects clearly");

console.log("PASS media-inspect-sandbox-smoke");
