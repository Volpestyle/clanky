/**
 * Shared value-coercion and guard helpers used across the Clanky packages.
 *
 * These consolidate micro-utilities that were previously copy-pasted into many
 * modules. Keep them behaviorally minimal and dependency-free so any consumer
 * (core, agent, browser-bridge) can import them.
 */

export type JsonRecord = Record<string, unknown>;

/**
 * Type guard for plain object records. Arrays and `null` are rejected.
 */
export function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns the value when it is a string, otherwise an empty string. Does not
 * trim — callers that need trimming should trim the result themselves.
 */
export function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/**
 * Extracts a human-readable message from an unknown thrown value.
 */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Coerces a finite number into an integer clamped to `[min, max]`, falling back
 * to `fallback` when the value is undefined or non-finite.
 */
export function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Truncates `text` to `maxLength` characters, appending an ellipsis when the
 * text is longer than the budget allows.
 */
export function truncateText(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	if (maxLength <= 3) return text.slice(0, maxLength);
	return `${text.slice(0, maxLength - 3)}...`;
}
