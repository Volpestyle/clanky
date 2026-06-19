import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { resolveClankyDataPath } from "./paths.ts";

export const INTEGRATION_ROLES = [
	{
		key: "workTracker",
		label: "work tracker",
		env: "CLANKY_WORK_TRACKER",
		defaultConnection: "linear",
	},
	{
		key: "designTool",
		label: "design tool",
		env: "CLANKY_DESIGN_TOOL",
		defaultConnection: "figma",
	},
] as const;

export type IntegrationRole = (typeof INTEGRATION_ROLES)[number]["key"];
export type IntegrationRoleBindings = Partial<Record<IntegrationRole, string>>;

interface IntegrationRoleStore {
	exists: boolean;
	bindings: IntegrationRoleBindings;
}

const CONNECTION_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

export async function resolveRoleBindings(env: NodeJS.ProcessEnv = process.env): Promise<IntegrationRoleBindings> {
	const store = await readRoleStore(env);
	const bindings = store.exists ? store.bindings : defaultRoleBindings();
	for (const role of INTEGRATION_ROLES) {
		const override = normalizeConnectionName(env[role.env]);
		if (override !== undefined) bindings[role.key] = override;
	}
	return bindings;
}

export async function setRoleBinding(
	role: IntegrationRole,
	connectionName: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ path: string; bindings: IntegrationRoleBindings }> {
	const store = await readRoleStore(env);
	const bindings = store.exists ? store.bindings : defaultRoleBindings();
	const trimmed = connectionName?.trim() ?? "";
	if (trimmed.length === 0) {
		delete bindings[role];
	} else if (CONNECTION_NAME_RE.test(trimmed)) {
		bindings[role] = trimmed;
	} else {
		throw new Error(`Invalid connection name: ${trimmed}`);
	}
	const path = resolveRoleBindingsPath(env);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(path, `${JSON.stringify(bindings, null, "\t")}\n`, { mode: 0o600 });
	return { path, bindings };
}

export async function listAvailableConnections(agentRoot = resolve(process.cwd(), "agent")): Promise<string[]> {
	const connectionsDir = resolve(agentRoot, "connections");
	const entries = await readdir(connectionsDir, { withFileTypes: true }).catch((error: unknown) => {
		if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") return [];
		throw error;
	});
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && entry.name !== "index.ts")
		.map((entry) => entry.name.slice(0, -".ts".length))
		.filter((name) => normalizeConnectionName(name) !== undefined)
		.sort((a, b) => a.localeCompare(b));
}

export function roleLabel(role: IntegrationRole): string {
	return INTEGRATION_ROLES.find((entry) => entry.key === role)?.label ?? role;
}

async function readRoleStore(env: NodeJS.ProcessEnv): Promise<IntegrationRoleStore> {
	const path = resolveRoleBindingsPath(env);
	try {
		const raw = await readFile(path, "utf8");
		return { exists: true, bindings: parseRoleBindings(JSON.parse(raw) as unknown, path) };
	} catch (error) {
		if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") {
			return { exists: false, bindings: {} };
		}
		throw error;
	}
}

function resolveRoleBindingsPath(env: NodeJS.ProcessEnv): string {
	return resolveClankyDataPath("integration-roles.json", env);
}

function defaultRoleBindings(): IntegrationRoleBindings {
	return Object.fromEntries(INTEGRATION_ROLES.map((role) => [role.key, role.defaultConnection])) as IntegrationRoleBindings;
}

function parseRoleBindings(value: unknown, source: string): IntegrationRoleBindings {
	if (!isRecord(value)) throw new Error(`${source} must be a JSON object`);
	const bindings: IntegrationRoleBindings = {};
	for (const role of INTEGRATION_ROLES) {
		const normalized = normalizeConnectionName(value[role.key]);
		if (normalized !== undefined) bindings[role.key] = normalized;
	}
	return bindings;
}

// Lenient: read paths (env overrides, the stored file, the turn.started
// resolver) must degrade an unusable value to "unset" rather than throw and
// fail the turn. setRoleBinding validates TUI input strictly on its own.
function normalizeConnectionName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	if (normalized.length === 0 || !CONNECTION_NAME_RE.test(normalized)) return undefined;
	return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
