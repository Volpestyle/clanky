/**
 * Pure helpers for the Clanky face: provider/effort parsing, integration-role
 * tables, and small formatting/value utilities. No runtime singletons or side
 * effects. Extracted from scripts/clanky.ts (SPEC.md §4.2).
 */
import { type ClankyConfig, type SubscriptionProvider, EFFORT_LEVELS, LOCAL_EFFORT_LEVELS } from "./config-data.ts";
import {
	INTEGRATION_ROLES,
	type IntegrationRole,
	type IntegrationRoleBindings,
	roleLabel,
} from "../../agent/lib/integration-roles.ts";

export function parseProvider(value: string | undefined): ClankyConfig["provider"] | undefined {
	return value === "codex" || value === "claude" || value === "local" || value === "xai" || value === "gemini" ? value : undefined;
}

export function parseSubscriptionProvider(value: string | undefined): SubscriptionProvider | undefined {
	return value === "codex" || value === "claude" ? value : undefined;
}

export function isEffortLevel(value: string): value is (typeof EFFORT_LEVELS)[number] {
	return EFFORT_LEVELS.includes(value as (typeof EFFORT_LEVELS)[number]);
}

export function isLocalEffortLevel(value: string): value is (typeof LOCAL_EFFORT_LEVELS)[number] {
	return LOCAL_EFFORT_LEVELS.includes(value as (typeof LOCAL_EFFORT_LEVELS)[number]);
}

export function parseIntegrationRole(value: string | undefined): IntegrationRole | undefined {
	if (value === undefined) return undefined;
	const normalized = normalizeIntegrationToken(value);
	return INTEGRATION_ROLES.find((role) => normalizeIntegrationToken(role.key) === normalized || normalizeIntegrationToken(role.label) === normalized)
		?.key;
}

export function parseIntegrationBinding(value: string, available: readonly string[]): string | undefined | "invalid" {
	if (value === "unset" || value === "none" || value === "off") return undefined;
	return available.includes(value) ? value : "invalid";
}

export function normalizeIntegrationToken(value: string): string {
	return normalizeCommandToken(value);
}

export function normalizeCommandToken(value: string): string {
	return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// The one boolean parser for face toggles (previously four divergent copies:
// parseBooleanFlag, parseOnOff, parseToggle, parseVoiceToggle). Accepts the
// union of all synonyms each surface historically took.
const TRUE_TOKENS = new Set(["1", "true", "yes", "on", "enable", "enabled", "show", "allow"]);
const FALSE_TOKENS = new Set(["0", "false", "no", "off", "disable", "disabled", "hide", "block"]);

export function parseBooleanToggle(value: string | undefined): boolean | undefined {
	const normalized = value?.trim().toLowerCase();
	if (normalized === undefined || normalized.length === 0) return undefined;
	if (TRUE_TOKENS.has(normalized)) return true;
	if (FALSE_TOKENS.has(normalized)) return false;
	return undefined;
}

export function integrationSavedMessage(role: IntegrationRole, binding: string | undefined): string {
	return `${roleLabel(role)} ${binding === undefined ? "unset" : `bound to ${binding}`}. New turns will use the updated role binding.`;
}

export function formatIntegrationTable(bindings: IntegrationRoleBindings, available: readonly string[]): string {
	const roleWidth = Math.max(...INTEGRATION_ROLES.map((role) => role.label.length), "role".length);
	const bindingWidth = Math.max(
		"binding".length,
		...INTEGRATION_ROLES.map((role) => (bindings[role.key] ?? "(unset)").length),
	);
	const lines = [
		`${"role".padEnd(roleWidth)}  ${"binding".padEnd(bindingWidth)}`,
		`${"-".repeat(roleWidth)}  ${"-".repeat(bindingWidth)}`,
		...INTEGRATION_ROLES.map((role) => `${role.label.padEnd(roleWidth)}  ${(bindings[role.key] ?? "(unset)").padEnd(bindingWidth)}`),
		"",
		`available connections: ${formatAvailableConnections(available)}`,
	];
	return lines.join("\n");
}

export function formatIntegrationSummary(bindings: IntegrationRoleBindings, available: readonly string[]): string {
	const bound = INTEGRATION_ROLES.map((role) => `${role.label}=${bindings[role.key] ?? "unset"}`).join(", ");
	return `${bound}; available=${formatAvailableConnections(available)}`;
}

export function formatAvailableConnections(available: readonly string[]): string {
	return available.length === 0 ? "(none)" : available.join(", ");
}

export function formatBrowserBridgeStatus(status: Record<string, unknown>): string {
	const paths = isRecord(status.paths) ? status.paths : {};
	const extension = isRecord(status.extension) ? status.extension : {};
	const nextSteps = Array.isArray(status.nextSteps) ? status.nextSteps.map(String) : [];
	return [
		`available: ${status.available === true ? "yes" : "no"}`,
		`daemon running: ${status.daemonRunning === true ? "yes" : "no"}`,
		`extension connected: ${status.extensionConnected === true ? "yes" : "no"}`,
		`extension dir: ${typeof extension.extensionDir === "string" ? extension.extensionDir : stringOrFallback(paths.extensionDir, "(missing)")}`,
		`config: ${formatJson(status.config)}`,
		`state: ${formatJson(status.state)}`,
		...(nextSteps.length === 0 ? [] : ["next steps:", ...nextSteps.map((step) => `- ${step}`)]),
	].join("\n");
}

export function formatBrowserBridgeSummary(status: Record<string, unknown>): string {
	const nextSteps = Array.isArray(status.nextSteps) ? status.nextSteps.map(String) : [];
	const state = isRecord(status.state) ? status.state : {};
	const port = typeof state.port === "number" ? ` port=${state.port}` : "";
	const next = nextSteps.length === 0 ? "" : ` next=${nextSteps.join(" | ")}`;
	return `available=${status.available === true} daemon=${status.daemonRunning === true} extension=${status.extensionConnected === true}${port}${next}`;
}

export function stringOrFallback(value: unknown, fallback: string): string {
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function splitArgs(argument: string): string[] {
	return argument.trim().length === 0 ? [] : argument.trim().split(/\s+/);
}

export function formatJson(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

export function formatError(error: unknown): string {
	return error instanceof Error ? error.stack ?? error.message : String(error);
}

export function isAbortError(error: unknown): boolean {
	if (error instanceof DOMException && error.name === "AbortError") return true;
	if (!(error instanceof Error)) return false;
	return error.name === "AbortError" || /abort|cancel/iu.test(error.message);
}

export function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n... truncated ${text.length - maxChars} chars`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
