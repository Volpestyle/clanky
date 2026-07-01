import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { herdrRequest } from "../lib/herdr-socket.ts";
import { readPaneRecording } from "../lib/pane-recorder.ts";
import { readTranscript } from "../lib/transcripts.ts";

const HERDR_SOURCES = ["visible", "recent", "recent_unwrapped", "detection"] as const;
const READ_SOURCES = ["auto", "transcript", "recording", ...HERDR_SOURCES] as const;
type HerdrSource = (typeof HERDR_SOURCES)[number];

export default defineTool({
	needsApproval: never(),
	description:
		"Read durable Clanky history or live Herdr output from an agent or pane on the host. auto prefers durable history (worker transcript for agents, pane recording for panes) and falls back to live Herdr reads; visible reads the exact current TUI state. Recording reads support anchor/skip to page through history beyond Herdr's 1000-line cap (anchor=head skip=0 reads a session's beginning).",
	inputSchema: z.object({
		agent: z.string().optional().describe("agent name, for example clanky:fix-tests"),
		pane: z.string().optional().describe("pane id, for example w1:p3"),
		source: z.enum(READ_SOURCES).default("auto"),
		lines: z.number().int().min(1).max(1000).default(120),
		anchor: z
			.enum(["tail", "head"])
			.default("tail")
			.describe("recording reads: tail reads newest lines, head reads from the start"),
		skip: z
			.number()
			.int()
			.min(0)
			.default(0)
			.describe("recording reads: lines to skip from the anchored end, for paging"),
		recording_id: z.string().optional().describe("pin a specific pane recording instead of the latest"),
	}),
	async execute(input) {
		if (input.source === "transcript") {
			if (!input.agent) throw new Error("transcript reads require an agent name");
			return readTranscript(input.agent, { lines: input.lines });
		}
		if (input.source === "recording") {
			if (!input.pane) throw new Error("recording reads require a pane id");
			return readPaneRecording(input.pane, {
				lines: input.lines,
				anchor: input.anchor,
				skip: input.skip,
				recordingId: input.recording_id,
			});
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
				try {
					return await readPaneRecording(input.pane, {
						lines: input.lines,
						anchor: input.anchor,
						skip: input.skip,
						recordingId: input.recording_id,
					});
				} catch (error) {
					const fallback = await readHerdr(undefined, input.pane, "recent_unwrapped", input.lines);
					return {
						source: "herdr-recent-unwrapped",
						fallback: true,
						fallbackReason: (error as Error).message,
						pane: input.pane,
						lines: input.lines,
						text: herdrText(fallback),
						herdr: fallback,
					};
				}
			}
		}
		if (isHerdrSource(input.source)) {
			return readHerdr(input.agent, input.pane, input.source, input.lines);
		}
		throw new Error("herdr_read requires agent or pane");
	},
});

async function readHerdr(
	agent: string | undefined,
	pane: string | undefined,
	source: HerdrSource,
	lines: number,
): Promise<unknown> {
	if (agent) return herdrRequest("agent.read", { target: agent, source, lines });
	if (pane) return herdrRequest("pane.read", { pane_id: pane, source, lines });
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
	if (typeof result === "object" && result !== null && "read" in result) {
		const read = (result as { read?: { text?: unknown } }).read;
		if (typeof read?.text === "string") return read.text;
	}
	return JSON.stringify(result);
}
