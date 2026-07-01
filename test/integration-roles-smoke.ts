// Offline smoke for integration role bindings (agent/lib/integration-roles.ts):
// atomic replace on write and tolerant reads that degrade a corrupt store to
// defaults instead of failing the turn. Run: node test/integration-roles-smoke.ts
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveRoleBindings, setRoleBinding } from "../agent/lib/integration-roles.ts";

let failures = 0;
function check(label: string, ok: boolean): void {
	console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
	if (!ok) failures += 1;
}

async function main(): Promise<void> {
	const home = await mkdtemp(join(tmpdir(), "clanky-integration-roles-"));
	const env = { CLANKY_HOME: home } as NodeJS.ProcessEnv;
	const storePath = join(home, "integration-roles.json");
	try {
		// Defaults apply while no store exists.
		const defaults = await resolveRoleBindings(env);
		check("missing store resolves defaults", defaults.workTracker === "linear" && defaults.designTool === "figma");

		// Writes land atomically: valid JSON on disk, no temp file left behind.
		const saved = await setRoleBinding("workTracker", "github", env);
		check("setRoleBinding reports the store path", saved.path === storePath);
		const raw = await readFile(storePath, "utf8");
		check("written store is valid JSON", (JSON.parse(raw) as { workTracker?: string }).workTracker === "github");
		const leftovers = (await readdir(dirname(storePath))).filter((name) => name.includes(".tmp"));
		check("no temp file remains after atomic replace", leftovers.length === 0);
		const resolved = await resolveRoleBindings(env);
		check("stored binding resolves", resolved.workTracker === "github");

		// Clearing a binding removes it from the store.
		await setRoleBinding("workTracker", undefined, env);
		const cleared = await resolveRoleBindings(env);
		check("cleared binding resolves unset (store exists, no defaults)", cleared.workTracker === undefined);

		// Invalid input is rejected on the strict write path.
		let threw = false;
		try {
			await setRoleBinding("workTracker", "not a name!", env);
		} catch {
			threw = true;
		}
		check("setRoleBinding rejects invalid connection names", threw);

		// Tolerant read: corrupt JSON degrades to defaults rather than throwing.
		await writeFile(storePath, "{ not json");
		const corrupt = await resolveRoleBindings(env);
		check("corrupt store degrades to defaults", corrupt.workTracker === "linear" && corrupt.designTool === "figma");

		// Tolerant read: non-object JSON also degrades to defaults.
		await writeFile(storePath, "[1, 2, 3]\n");
		const nonObject = await resolveRoleBindings(env);
		check("non-object store degrades to defaults", nonObject.workTracker === "linear");

		// Bad stored values degrade to unset without dropping good ones.
		await writeFile(storePath, `${JSON.stringify({ workTracker: "  ", designTool: "figma" })}\n`);
		const partial = await resolveRoleBindings(env);
		check("unusable stored value degrades to unset", partial.workTracker === undefined && partial.designTool === "figma");

		// Env override still wins over a corrupt store.
		await writeFile(storePath, "{ not json");
		const overridden = await resolveRoleBindings({ ...env, CLANKY_WORK_TRACKER: "jira" });
		check("env override applies over a corrupt store", overridden.workTracker === "jira");

		// A write after corruption recovers the store.
		const recovered = await setRoleBinding("designTool", "sketch", env);
		check("setRoleBinding recovers a corrupt store", recovered.bindings.designTool === "sketch");

		// mkdir for coverage of a fresh nested home.
		const nestedHome = join(home, "nested", "deeper");
		await mkdir(nestedHome, { recursive: true });
		const nested = await setRoleBinding("workTracker", "linear", { CLANKY_HOME: nestedHome } as NodeJS.ProcessEnv);
		check("write creates parent dirs for a fresh home", nested.bindings.workTracker === "linear");
	} finally {
		await rm(home, { recursive: true, force: true });
	}

	console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
	process.exit(failures === 0 ? 0 : 1);
}

void main();
