export type McpConnectionSearchInspection = {
	readonly matchedConnection: boolean;
	readonly needsAuthorization: boolean;
	readonly sawUsableTool: boolean;
	readonly errors: readonly string[];
};

export function inspectConnectionSearchOutput(output: unknown, connectionName: string): McpConnectionSearchInspection {
	const items = parseConnectionSearchItems(output);
	const errors: string[] = [];
	let matchedConnection = false;
	let needsAuthorization = false;
	let sawUsableTool = false;

	for (const item of items) {
		if (!isRecord(item) || item.connection !== connectionName) continue;
		matchedConnection = true;
		if (item.needsAuthorization === true) needsAuthorization = true;
		if (typeof item.error === "string" && item.error.trim().length > 0) errors.push(item.error);
		if (typeof item.qualifiedName === "string" && typeof item.tool === "string") sawUsableTool = true;
	}

	return { matchedConnection, needsAuthorization, sawUsableTool, errors };
}

function parseConnectionSearchItems(output: unknown): readonly unknown[] {
	const unwrapped = unwrapToolOutput(parseJsonString(output));
	return Array.isArray(unwrapped) ? unwrapped : [];
}

function unwrapToolOutput(output: unknown): unknown {
	if (!isRecord(output)) return output;
	if ("type" in output && "value" in output) return parseJsonString(output.value);
	return output;
}

function parseJsonString(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	if (trimmed.length === 0) return value;
	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
