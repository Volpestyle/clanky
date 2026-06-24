/**
 * Go Live tool (SPEC.md §5.3): lets Clanky watch someone's screen share or
 * publish his own Go Live in the voice channel he is in. Requires an active
 * voice session on a user/self token (he must join vc first); otherwise there is
 * no Go Live controller and the tool says so.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";
import { gated } from "../lib/approvals.ts";
import { getActiveGoLive } from "../lib/discord/golive.ts";

export default defineTool({
	// Reads (list) run freely; every publish/watch/control op publishes or joins
	// an external Discord stream, so it goes through approval.
	needsApproval: gated((ctx) => ctx.toolInput?.op !== "list"),
	description:
		"Watch a Discord screen share or publish your own Go Live in the voice channel you are in. Requires having joined a vc on a user/self token. ops: list (show active streams), watch (start watching a stream by target), golive (publish your own), stop, pause, resume.",
	inputSchema: z.object({
		op: z.enum(["list", "watch", "golive", "stop", "pause", "resume"]),
		target: z.string().optional().describe("for watch: a user id, channel id, or stream-key fragment"),
		guildId: z.string().optional().describe("for golive: the guild to publish in"),
		channelId: z.string().optional().describe("for golive: the voice channel to publish in"),
		preferredRegion: z.string().optional().describe("for golive: preferred voice region"),
		streamKey: z.string().optional().describe("for stop/pause/resume: the stream key"),
	}),
	async execute(input) {
		const controller = getActiveGoLive();
		if (controller === null) {
			throw new Error("no active Go Live session; join a voice channel on a user token first (\"hop in vc\")");
		}
		switch (input.op) {
			case "list":
				return { streams: controller.listStreams() };
			case "watch": {
				const stream = controller.watch(input.target);
				return { watching: stream.streamKey, userId: stream.userId };
			}
			case "golive": {
				if (input.guildId === undefined || input.channelId === undefined) {
					throw new Error("golive requires guildId and channelId");
				}
				controller.goLive({
					guildId: input.guildId,
					channelId: input.channelId,
					preferredRegion: input.preferredRegion ?? null,
				});
				return { publishing: true, guildId: input.guildId, channelId: input.channelId };
			}
			case "stop": {
				if (input.streamKey === undefined) throw new Error("stop requires streamKey");
				controller.stopPublish(input.streamKey);
				return { stopped: input.streamKey };
			}
			case "pause":
			case "resume": {
				if (input.streamKey === undefined) throw new Error(`${input.op} requires streamKey`);
				controller.setPaused(input.streamKey, input.op === "pause");
				return { streamKey: input.streamKey, paused: input.op === "pause" };
			}
		}
	},
});
