export function dropUndefined<T>(value: Record<string, unknown>): T {
	const output: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (item !== undefined) output[key] = item;
	}
	return output as T;
}
