/**
 * Clanky's optional conductor model on the user's Claude Pro/Max subscription
 * via OAuth, exposed as a Vercel AI SDK LanguageModel (SPEC.md §4.6).
 *
 * Mirrors the Codex model: a custom fetch attaches fresh OAuth credentials and
 * the Claude Code identity headers, and a middleware prepends the Claude Code
 * system block the subscription OAuth path requires. This presents as Anthropic's
 * official CLI — a ToS-gray path; use for personal accounts only.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { wrapLanguageModel, type LanguageModel } from "ai";
import { getValidClaudeCredentials } from "./claude-auth.ts";

// The subscription OAuth path rejects requests whose first system block is not
// the Claude Code identity.
const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";
const CLAUDE_CODE_USER_AGENT = "claude-cli/1.0.0 (external, cli)";
const OAUTH_BETAS = ["claude-code-20250219", "oauth-2025-04-20"];

export interface ClaudeModelOptions {
	/** Anthropic model id, e.g. "claude-sonnet-4-5". */
	modelId: string;
}

/** Per-request fetch: swap x-api-key for the OAuth bearer + Claude Code identity. */
async function claudeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
	const creds = await getValidClaudeCredentials();
	const headers = new Headers(init.headers);
	headers.delete("x-api-key");
	headers.set("Authorization", `Bearer ${creds.access}`);
	const existing = headers.get("anthropic-beta");
	const betas = [...OAUTH_BETAS, ...(existing ? existing.split(",").map((s) => s.trim()) : [])];
	headers.set("anthropic-beta", [...new Set(betas)].join(","));
	headers.set("user-agent", CLAUDE_CODE_USER_AGENT);
	headers.set("x-app", "cli");
	headers.set("anthropic-dangerous-direct-browser-access", "true");
	return fetch(input, { ...init, headers });
}

/** Build the Claude-subscription LanguageModel. */
export function createClaudeModel(options: ClaudeModelOptions): LanguageModel {
	const provider = createAnthropic({
		// Placeholder: claudeFetch removes x-api-key and sets the OAuth bearer.
		apiKey: "claude-oauth",
		fetch: claudeFetch,
	});

	return wrapLanguageModel({
		model: provider(options.modelId),
		middleware: {
			transformParams: async ({ params }) => {
				const head = { role: "system" as const, content: CLAUDE_CODE_SYSTEM };
				return { ...params, prompt: [head, ...params.prompt] };
			},
		},
	});
}
