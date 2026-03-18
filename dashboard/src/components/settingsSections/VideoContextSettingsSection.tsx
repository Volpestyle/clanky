import { SettingsSection } from "../SettingsSection";

export function VideoContextSettingsSection({ id, form, set }) {
  return (
    <SettingsSection id={id} title="Video Context" active={form.videoContextEnabled}>
      <div className="toggles">
        <label>
          <input
            type="checkbox"
            checked={form.videoContextEnabled}
            onChange={set("videoContextEnabled")}
          />
          Enable video transcript/metadata context in replies
        </label>
      </div>

      {form.videoContextEnabled && (
        <>
          <div className="toggles">
            <label>
              <input
                type="checkbox"
                checked={form.videoContextAsrFallback}
                onChange={set("videoContextAsrFallback")}
              />
              Fallback to ASR when captions are unavailable
            </label>
          </div>

          <div className="split">
            <div>
              <label htmlFor="video-context-per-hour">Max video lookups/hour</label>
              <input
                id="video-context-per-hour"
                type="number"
                min="0"
                max="120"
                value={form.videoContextPerHour}
                onChange={set("videoContextPerHour")}
              />
            </div>
            <div>
              <label htmlFor="video-context-max-videos">Max videos per message</label>
              <input
                id="video-context-max-videos"
                type="number"
                min="0"
                max="6"
                value={form.videoContextMaxVideos}
                onChange={set("videoContextMaxVideos")}
              />
            </div>
          </div>

          <div className="split">
            <div>
              <label htmlFor="video-context-max-chars">Max transcript chars per video</label>
              <input
                id="video-context-max-chars"
                type="number"
                min="200"
                max="4000"
                value={form.videoContextMaxChars}
                onChange={set("videoContextMaxChars")}
              />
            </div>
            <div>
              <label htmlFor="video-context-keyframe-interval">Keyframe interval (seconds)</label>
              <input
                id="video-context-keyframe-interval"
                type="number"
                min="0"
                max="120"
                value={form.videoContextKeyframeInterval}
                onChange={set("videoContextKeyframeInterval")}
              />
            </div>
          </div>

          <div className="split">
            <div>
              <label htmlFor="video-context-max-keyframes">Max keyframes per video</label>
              <input
                id="video-context-max-keyframes"
                type="number"
                min="0"
                max="8"
                value={form.videoContextMaxKeyframes}
                onChange={set("videoContextMaxKeyframes")}
              />
            </div>
            {form.videoContextAsrFallback ? (
              <div>
                <label htmlFor="video-context-max-asr-seconds">Max ASR seconds per video</label>
                <input
                  id="video-context-max-asr-seconds"
                  type="number"
                  min="15"
                  max="600"
                  value={form.videoContextMaxAsrSeconds}
                  onChange={set("videoContextMaxAsrSeconds")}
                />
              </div>
            ) : (
              <div />
            )}
          </div>
        </>
      )}
    </SettingsSection>
  );
}
