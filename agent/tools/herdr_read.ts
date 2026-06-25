import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { herdrRequest } from "../lib/herdr-socket.ts";
import { readTranscript } from "../lib/transcripts.ts";

const HERDR_SOURCES = ["visible", "recent", "recent_unwrapped", "detection"] as const;
const READ_SOURCES = ["auto", "transcript", ...HERDR_SOURCES] as const;
type HerdrSource = (typeof HERDR_SOURCES)[number];

export default defineTool({
	needsApproval: never(),
	description:
		"Read durable Clanky transcripts or live Herdr output from an agent or pane on the host. Use auto for worker history, visible for exact current TUI state.",
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
		if (isHerdrSource(input.source)) return readHerdr(input.agent, input.pane, input.source, input.lines);
		throw new Error("herdr_read requires agent or pane");
	},
});

async function readHerdr(
	agent: string | undefined,
	pane: string | undefined,
	source: HerdrSource,
	lines: number,
): Promise<unknown> {
	if (agent) {
		return herdrRequest("agent.read", {
			target: agent,
			source,
			lines,
		});
	}
	if (pane) {
		return herdrRequest("pane.read", {
			pane_id: pane,
			source,
			lines,
		});
	}
	throw new Error("herdr_read requires agent or pane");
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
	return JSON.stringify(result);
}
