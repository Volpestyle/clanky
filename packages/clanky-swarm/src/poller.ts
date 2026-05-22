export function swarmActivityChanges(activity: unknown): string[] {
	const changes = property(activity, "changes");
	if (!Array.isArray(changes)) return [];
	return changes.filter((change) => typeof change === "string");
}

export function isSwarmTimeoutActivity(activity: unknown): boolean {
	return property(activity, "timeout") === true;
}

function property(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return (value as Record<string, unknown>)[key];
}
