import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import figmaConnection from "../agent/connections/figma.ts";
import linearConnection from "../agent/connections/linear.ts";
import { listAvailableConnections, resolveRoleBindings, setRoleBinding } from "../agent/lib/integration-roles.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const expectedLinearUrl = process.env.CLANKY_LINEAR_MCP_URL?.trim() || "https://mcp.linear.app/sse";
const expectedFigmaUrl = process.env.CLANKY_FIGMA_MCP_URL?.trim() || "https://mcp.figma.com/mcp";

assert(linearConnection.url === expectedLinearUrl, "Linear connection URL drifted");
assert(linearConnection.description.includes("Linear workspace"), "Linear connection description missing routing context");
assert(linearConnection.auth !== undefined, "Linear connection missing OAuth auth");
assert(linearConnection.auth.startAuthorization !== undefined, "Linear connection is not interactive OAuth");
assert(linearConnection.auth.completeAuthorization !== undefined, "Linear connection cannot complete OAuth");
assert(linearConnection.auth.vercelConnect === undefined, "Linear connection must not use Vercel Connect");
assert(linearConnection.approval !== undefined, "Linear connection should be approval-gated");

assert(figmaConnection.url === expectedFigmaUrl, "Figma connection URL drifted");
assert(figmaConnection.description.includes("Figma workspace"), "Figma connection description missing routing context");
assert(figmaConnection.auth !== undefined, "Figma connection missing OAuth auth");
assert(figmaConnection.auth.startAuthorization !== undefined, "Figma connection is not interactive OAuth");
assert(figmaConnection.auth.completeAuthorization !== undefined, "Figma connection cannot complete OAuth");
assert(figmaConnection.auth.vercelConnect === undefined, "Figma connection must not use Vercel Connect");
assert(figmaConnection.approval !== undefined, "Figma connection should be approval-gated");

const previousHome = process.env.CLANKY_HOME;
const previousWorkTracker = process.env.CLANKY_WORK_TRACKER;
const previousDesignTool = process.env.CLANKY_DESIGN_TOOL;
const home = await mkdtemp(join(tmpdir(), "clanky-connections-"));
try {
	process.env.CLANKY_HOME = home;
	delete process.env.CLANKY_WORK_TRACKER;
	delete process.env.CLANKY_DESIGN_TOOL;

	const available = await listAvailableConnections();
	assert(available.includes("linear"), "available connections did not include linear");
	assert(available.includes("figma"), "available connections did not include figma");

	const defaults = await resolveRoleBindings();
	assert(defaults.workTracker === "linear", "default work tracker binding should be linear");
	assert(defaults.designTool === "figma", "default design tool binding should be figma");

	process.env.CLANKY_WORK_TRACKER = "override_tracker";
	const overridden = await resolveRoleBindings();
	assert(overridden.workTracker === "override_tracker", "env work tracker override did not win over defaults");
	delete process.env.CLANKY_WORK_TRACKER;

	await setRoleBinding("workTracker", undefined);
	const unsetWorkTracker = await resolveRoleBindings();
	assert(unsetWorkTracker.workTracker === undefined, "unset work tracker should stay unset after store exists");
	assert(unsetWorkTracker.designTool === "figma", "setting one role should preserve seeded default design tool binding");

	await setRoleBinding("designTool", "figma");
	const stored = await resolveRoleBindings();
	assert(stored.designTool === "figma", "design role binding did not persist");
	const path = join(home, "integration-roles.json");
	const info = await stat(path);
	assert((info.mode & 0o777) === 0o600, "integration role store should be 0600");
	const raw = await readFile(path, "utf8");
	assert(raw.includes("\t\"designTool\""), "integration role store should use tab-indented JSON");
} finally {
	if (previousHome === undefined) delete process.env.CLANKY_HOME;
	else process.env.CLANKY_HOME = previousHome;
	if (previousWorkTracker === undefined) delete process.env.CLANKY_WORK_TRACKER;
	else process.env.CLANKY_WORK_TRACKER = previousWorkTracker;
	if (previousDesignTool === undefined) delete process.env.CLANKY_DESIGN_TOOL;
	else process.env.CLANKY_DESIGN_TOOL = previousDesignTool;
	await rm(home, { recursive: true, force: true });
}

console.log("ALL OK");
