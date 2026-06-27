import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { herdrRequest } from "../lib/herdr-socket.ts";
import { readTranscript } from "../lib/transcripts.ts";

const HERDR_SOURCES = ["visible", "recent", "recent_unwrapped", "full", "detection"] as const;
const READ_SOURCES = ["auto", "transcript", ...HERDR_SOURCES] as const;
type HerdrSource = (typeof HERDR_SOURCES)[number];
const VANILLA_HERDR_FALLBACK_LINES = 1000;

export default defineTool({
	needsApproval: never(),
	description:
		"Read durable Clanky transcripts or live Herdr output from an agent or pane on the host. Use auto for worker history, visible for exact current TUI state, or full for retained Herdr scrollback.",
	inputSchema: z.object({
		agent: z.string().optional().describe("agent name, for example clanky:fix-tests"),
		pane: z.string().optional().describe("pane id, for example 1-2"),
		source: z.enum(READ_SOURCES).default("auto"),
		lines: z.number().int().min(1).max(1000).default(120),
	}),
	async execute(input) {
		if (input.source === "transcript") {
			if (!input.agent) throw new Error("transcript reads require an agent name");
			return readTranscript(input.agent, { lines: input.lines });
		}
		if (input.source === "auto") {
			if (input.agent) {
				try {
					return await readTranscript(input.agent, { lines: input.lines });
				} catch (error) {
					const fallback = await readHerdr(input.agent, undefined, "recent_unwrapped", input.lines);
					return {
						source: "herdr-recent-unwrapped",
						fallback: true,
						fallbackReason: (error as Error).message,
						agent: input.agent,
						lines: input.lines,
						text: herdrText(fallback),
						herdr: fallback,
					};
				}
			}
			if (input.pane) {
				const fallback = await readHerdr(undefined, input.pane, "recent_unwrapped", input.lines);
				return {
					source: "herdr-recent-unwrapped",
					fallback: true,
					fallbackReason: "transcript reads require an agent name",
					pane: input.pane,
					lines: input.lines,
					text: herdrText(fallback),
					herdr: fallback,
				};
			}
		}
		if (isHerdrSource(input.source)) {
			return readHerdr(input.agent, input.pane, input.source, input.source === "full" ? undefined : input.lines);
		}
		throw new Error("herdr_read requires agent or pane");
	},
});

async function readHerdr(
	agent: string | undefined,
	pane: string | undefined,
	source: HerdrSource,
	lines: number | undefined,
): Promise<unknown> {
	if (agent) {
		const params: Record<string, unknown> = {
			target: agent,
			source,
		};
		if (lines !== undefined) params.lines = lines;
		return readHerdrWithFullFallback("agent.read", params);
	}
	if (pane) {
		const params: Record<string, unknown> = {
			pane_id: pane,
			source,
		};
		if (lines !== undefined) params.lines = lines;
		return readHerdrWithFullFallback("pane.read", params);
	}
	throw new Error("herdr_read requires agent or pane");
}

async function readHerdrWithFullFallback(
	method: "agent.read" | "pane.read",
	params: Record<string, unknown>,
): Promise<unknown> {
	try {
		return await herdrRequest(method, params);
	} catch (error) {
		if (params.source !== "full" || !isUnsupportedFullSourceError(error)) throw error;
		const fallbackParams = {
			...params,
			source: "recent_unwrapped",
			lines: VANILLA_HERDR_FALLBACK_LINES,
		};
		return {
			source: "herdr-recent-unwrapped",
			fallback: true,
			fallbackReason: (error as Error).message,
			text: herdrText(await herdrRequest(method, fallbackParams)),
		};
	}
}

function isUnsupportedFullSourceError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return (
		message.includes("unknown variant `full`") ||
		message.includes("unknown variant 'full'") ||
		message.includes("invalid read source: full")
	);
}

function isHerdrSource(source: string): source is HerdrSource {
	return HERDR_SOURCES.includes(source as HerdrSource);
}

function herdrText(result: unknown): string {
	if (typeof result === "string") return result;
	if (typeof result === "object" && result !== null && "text" in result) {
		const text = (result as { text?: unknown }).text;
		if (typeof text === "string") return text;
	}
	if (typeof result === "object" && result !== null && "read" in result) {
		const read = (result as { read?: { text?: unknown } }).read;
		if (typeof read?.text === "string") return read.text;
	}
	return JSON.stringify(result);
}
