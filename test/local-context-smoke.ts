import {
	DEFAULT_LOCAL_CONTEXT_TOKENS,
	extractContextWindowTokensFromOllamaShow,
	localContextWindowTokensFromEnv,
	ollamaApiBaseURLFromOpenAIBaseURL,
	resolveOllamaContextWindowTokens,
} from "../agent/lib/local-context.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

assert(localContextWindowTokensFromEnv({ CLANKY_MODEL_PROVIDER: "codex" }) === undefined, "non-local providers should omit local context");
assert(
	localContextWindowTokensFromEnv({ CLANKY_MODEL_PROVIDER: "local" }) === DEFAULT_LOCAL_CONTEXT_TOKENS,
	"local providers should retain the fallback when no override is present",
);
assert(
	localContextWindowTokensFromEnv({ CLANKY_MODEL_PROVIDER: "local", CLANKY_LOCAL_CONTEXT_TOKENS: "262144" }) === 262_144,
	"explicit local context env should win",
);
assert(
	localContextWindowTokensFromEnv({ CLANKY_MODEL_PROVIDER: "local", CLANKY_LOCAL_CONTEXT_TOKENS: "bad" }) === DEFAULT_LOCAL_CONTEXT_TOKENS,
	"invalid local context env should fall back",
);

assert(
	ollamaApiBaseURLFromOpenAIBaseURL("http://127.0.0.1:11434/v1") === "http://127.0.0.1:11434",
	"Ollama OpenAI base URL should map to the native API root",
);
assert(
	ollamaApiBaseURLFromOpenAIBaseURL("http://127.0.0.1:11434/proxy/v1/") === "http://127.0.0.1:11434/proxy",
	"proxied OpenAI base URL should keep its parent path",
);
assert(
	extractContextWindowTokensFromOllamaShow({ model_info: { "qwen3_5.context_length": 262_144 } }) === 262_144,
	"Ollama show metadata should expose the model context length",
);
assert(
	extractContextWindowTokensFromOllamaShow({ context_length: 131_072, model_info: { "qwen3_5.context_length": 262_144 } }) === 262_144,
	"context extraction should prefer the largest reported context length",
);

let requestedUrl = "";
let requestedBody = "";
const resolved = await resolveOllamaContextWindowTokens({
	baseURL: "http://127.0.0.1:11434/v1",
	modelId: "qwen3.6:27b-mlx-bf16",
	fetch: async (input, init) => {
		requestedUrl = String(input);
		requestedBody = String(init?.body ?? "");
		return new Response(JSON.stringify({ model_info: { "qwen3_5.context_length": 262_144 } }));
	},
});

assert(resolved === 262_144, "Ollama context resolver should parse /api/show");
assert(requestedUrl === "http://127.0.0.1:11434/api/show", "resolver should call the native Ollama show endpoint");
assert(JSON.parse(requestedBody).model === "qwen3.6:27b-mlx-bf16", "resolver should request the active model id");

console.log("ALL OK");
