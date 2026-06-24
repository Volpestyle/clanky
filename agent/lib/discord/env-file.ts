/**
 * Pure .env upsert used by the custom face's /discord-token and /model slash commands
 * (SPEC.md §5.3). Splitting the merge from the filesystem keeps it testable:
 * given the current .env.local contents and a set of key=value updates, return
 * the new contents — replacing existing keys in place and appending new ones,
 * preserving comments and order.
 */
export function applyEnvUpserts(content: string, updates: Record<string, string>): string {
	const remaining = new Map(Object.entries(updates));
	const lines = content.length === 0 ? [] : content.split("\n");
	const out = lines.map((line) => {
		const key = envKeyOf(line);
		if (key === null || !remaining.has(key)) return line;
		const value = remaining.get(key) ?? "";
		remaining.delete(key);
		return `${key}=${quoteEnvValue(value)}`;
	});
	// Drop a single trailing empty line so appends don't leave a blank gap.
	if (out.length > 0 && out[out.length - 1] === "") out.pop();
	for (const [key, value] of remaining) out.push(`${key}=${quoteEnvValue(value)}`);
	return `${out.join("\n")}\n`;
}

/**
 * Pure .env removal: drop the lines defining any of `keys`, preserving comments,
 * blanks, and the order of remaining lines. Used to clear a setting (e.g. reset
 * reasoning effort to the server default) rather than writing a sentinel value.
 */
export function applyEnvRemovals(content: string, keys: readonly string[]): string {
	const drop = new Set(keys);
	const lines = content.length === 0 ? [] : content.split("\n");
	const out = lines.filter((line) => {
		const key = envKeyOf(line);
		return key === null || !drop.has(key);
	});
	if (out.length > 0 && out[out.length - 1] === "") out.pop();
	return out.length === 0 ? "" : `${out.join("\n")}\n`;
}

/** The KEY of an `export KEY=...` / `KEY=...` line, or null for blanks/comments. */
function envKeyOf(line: string): string | null {
	const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
	return match?.[1] ?? null;
}

function quoteEnvValue(value: string): string {
	return /[\s"'#]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}
