export const LOCAL_CONTEXT_TOKENS_ENV = "CLANKY_LOCAL_CONTEXT_TOKENS";
export const DEFAULT_LOCAL_CONTEXT_TOKENS = 32_768;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export function parseLocalContextWindowTokens(value: string | undefined): number | undefined {
	const raw = value?.trim();
	if (raw === undefined || raw.length === 0 || !/^\d+$/.test(raw)) return undefined;
	const parsed = Number.parseInt(raw, 10);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function localContextWindowTokensFromEnv(env: NodeJS.ProcessEnv): number | undefined {
	if ((env.CLANKY_MODEL_PROVIDER ?? "codex") !== "local") return undefined;
	return parseLocalContextWindowTokens(env[LOCAL_CONTEXT_TOKENS_ENV]) ?? DEFAULT_LOCAL_CONTEXT_TOKENS;
}

export function ollamaApiBaseURLFromOpenAIBaseURL(baseURL: string): string | undefined {
	try {
		const url = new URL(baseURL);
		url.search = "";
		url.hash = "";
		url.pathname = url.pathname.replace(/\/+$/u, "");
		if (url.pathname.endsWith("/v1")) url.pathname = url.pathname.slice(0, -3) || "/";
		if (url.pathname.length === 0) url.pathname = "/";
		return url.toString().replace(/\/+$/u, "");
	} catch {
		return undefined;
	}
}

export function extractContextWindowTokensFromOllamaShow(body: unknown): number | undefined {
	const root = recordFromUnknown(body);
	if (root === undefined) return undefined;

	const candidates: number[] = [];
	appendPositiveInteger(candidates, root.context_length);

	const modelInfo = recordFromUnknown(root.model_info);
	if (modelInfo !== undefined) {
		for (const [key, value] of Object.entries(modelInfo)) {
			if (key.toLowerCase().endsWith("context_length")) appendPositiveInteger(candidates, value);
		}
	}

	if (typeof root.parameters === "string") {
		const match = /^num_ctx\s+(\d+)$/mu.exec(root.parameters);
		appendPositiveInteger(candidates, match?.[1]);
	}

	return candidates.length === 0 ? undefined : Math.max(...candidates);
}

export async function resolveOllamaContextWindowTokens(options: {
	baseURL: string;
	modelId: string;
	timeoutMs?: number;
	fetch?: FetchLike;
}): Promise<number | undefined> {
	const apiBaseURL = ollamaApiBaseURLFromOpenAIBaseURL(options.baseURL);
	if (apiBaseURL === undefined) return undefined;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 3_000);
	timeout.unref?.();

	try {
		const fetchImpl = options.fetch ?? fetch;
		const response = await fetchImpl(`${apiBaseURL}/api/show`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: options.modelId }),
			signal: controller.signal,
		});
		if (!response.ok) return undefined;
		return extractContextWindowTokensFromOllamaShow(await response.json());
	} catch {
		return undefined;
	} finally {
		clearTimeout(timeout);
	}
}

function appendPositiveInteger(target: number[], value: unknown): void {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string" && /^\d+$/u.test(value.trim())
				? Number.parseInt(value.trim(), 10)
				: undefined;
	if (parsed !== undefined && Number.isSafeInteger(parsed) && parsed > 0) target.push(parsed);
}

function recordFromUnknown(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
