/**
 * Clanky's conductor model: the OpenAI Codex subscription, exposed as a Vercel
 * AI SDK LanguageModel so eve can run it via `model:` in agent.ts.
 *
 * Spike-verified route (a) from SPEC.md §4.6: the stock @ai-sdk/openai Responses
 * model talks to the Codex backend when we
 *   - point baseURL at the codex responses endpoint,
 *   - inject the OAuth bearer + chatgpt-account-id + OpenAI-Beta headers, and
 *   - send instructions (non-empty) + store:false on every (streamed) call.
 *
 * The system message does NOT populate the Responses `instructions` field, so a
 * middleware injects it from providerOptions.
 */
import { createOpenAI } from "@ai-sdk/openai";
import { wrapLanguageModel, type LanguageModel } from "ai";
import { getValidCodexCredentials } from "./codex-auth.ts";

// createOpenAI().responses() appends `/responses`, yielding
// https://chatgpt.com/backend-api/codex/responses
const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

// Identifies the client to the Codex backend, mirroring the Codex CLI.
const ORIGINATOR = "codex_cli_rs";

export type CodexReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface CodexModelOptions {
	/** Codex model id, e.g. "gpt-5.5", "gpt-5.4", "gpt-5.3-codex-spark". */
	modelId: string;
	/**
	 * Non-empty text for the Responses `instructions` field. Required by the
	 * Codex backend. Clanky's persona flows through eve's system prompt; this is
	 * the harness preamble that satisfies the backend contract.
	 */
	instructions: string;
	/** Reasoning effort for the Responses API; omit to use the backend default. */
	reasoningEffort?: CodexReasoningEffort;
}

/** Per-request fetch that attaches fresh Codex credentials and required headers. */
async function codexFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
	const creds = await getValidCodexCredentials();
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${creds.access}`);
	headers.set("chatgpt-account-id", creds.accountId);
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("originator", ORIGINATOR);
	return fetch(input, { ...init, headers });
}

/**
 * Build the Codex-subscription LanguageModel. The returned model always sends
 * the Codex-required `instructions` and `store:false` provider options, so
 * callers (eve) cannot accidentally omit them.
 */
export function createCodexModel(options: CodexModelOptions): LanguageModel {
	const provider = createOpenAI({
		baseURL: CODEX_BASE_URL,
		// Placeholder: codexFetch overrides the Authorization header per request.
		apiKey: "codex-oauth",
		fetch: codexFetch,
	});

	return wrapLanguageModel({
		model: provider.responses(options.modelId),
		middleware: {
			transformParams: async ({ params }) => {
				const providerOptions = params.providerOptions ?? {};
				const openai = { ...(providerOptions.openai ?? {}) };
				if (typeof openai.instructions !== "string" || openai.instructions.length === 0) {
					openai.instructions = options.instructions;
				}
				openai.store = false;
				if (options.reasoningEffort !== undefined && openai.reasoningEffort === undefined) {
					openai.reasoningEffort = options.reasoningEffort;
				}
				return { ...params, providerOptions: { ...providerOptions, openai } };
			},
		},
	});
}
