type ActiveMusicGuidanceContext = {
  playbackState?: string | null;
  replyHandoffMode?: string | null;
};

export const VOICE_TINY_REPLY_POLICY_LINE =
  "A valid spoken reply can be tiny. Do not inflate admitted turns by default.";

export const ACTIVE_MUSIC_REPLY_CONTEXT_LINE =
  "Playback is live right now. If you answer without claiming the floor with media_reply_handoff, favor a quick reaction or short answer unless the moment clearly wants more.";

export const MUSIC_ACTIVE_AUTONOMY_POLICY_LINE =
  "If a playback-active turn reaches you at all, you may decide to take the floor, talk naturally over current playback, or stay silent.";

export const MUSIC_REPLY_HANDOFF_POLICY_LINE =
  "Use media_reply_handoff with mode=pause or duck when playback is active and you want only this reply to take the floor temporarily. Runtime auto-restores playback after you finish. Use media_pause only when playback should remain paused beyond the reply.";

export function buildActiveMusicReplyGuidanceLines(
  musicContext: ActiveMusicGuidanceContext | null
) {
  if (!musicContext) return [];
  if (musicContext.playbackState !== "playing" || musicContext.replyHandoffMode) return [];
  return [`- ${ACTIVE_MUSIC_REPLY_CONTEXT_LINE}`];
}
