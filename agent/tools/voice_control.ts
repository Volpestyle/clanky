import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { executeActiveVoiceControl } from "../channels/voice.ts";

const voiceControlOpSchema = z.enum([
	"status",
	"music_play",
	"music_stop",
	"music_pause",
	"music_resume",
	"music_volume",
	"video_play",
	"video_visualizer",
	"video_stop",
	"video_pause",
	"video_resume",
	"golive_start",
	"golive_stop",
	"golive_pause",
	"golive_resume",
]);

export default defineTool({
	needsApproval: never(),
	description:
		"Control the active Discord voice session: play/pause/stop YouTube or direct music, set music volume, start/publish/pause/stop Go Live video, or check voice media status. Requires Clanky to already be in a voice channel.",
	inputSchema: z.object({
		op: voiceControlOpSchema,
		url: z.string().optional().describe("for music_play, video_play, or video_visualizer"),
		resolvedDirectUrl: z.boolean().optional().describe("true only for direct media URLs that should skip yt-dlp"),
		volume: z.number().min(0).max(1).optional().describe("for music_volume"),
		fadeMs: z.number().int().min(0).max(10000).optional().describe("for music_volume"),
		visualizerMode: z.enum(["cqt", "spectrum", "waves", "vectorscope"]).optional().describe("for video_visualizer"),
		preferredRegion: z.string().optional().describe("for Go Live publish requests"),
		streamKey: z.string().optional().describe("optional Go Live stream key for stop/pause/resume"),
	}),
	async execute(input) {
		return await executeActiveVoiceControl(input);
	},
});
