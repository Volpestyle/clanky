import { SettingsSection } from "../SettingsSection";
import { LlmProviderOptions, VISION_LLM_PROVIDER_OPTIONS } from "./LlmProviderOptions";

export function VisionSettingsSection({
  id,
  form,
  set,
  setVisionProvider,
  selectVisionPresetModel,
  visionModelOptions,
  selectedVisionPresetModel
}) {
  return (
    <SettingsSection id={id} title="Vision (Image Captioning)" active={form.visionCaptionEnabled}>
      <div className="toggles">
        <label>
          <input
            type="checkbox"
            checked={form.visionCaptionEnabled}
            onChange={set("visionCaptionEnabled")}
          />
          Enable auto-captioning of images in message history
        </label>
      </div>

      {form.visionCaptionEnabled && (
        <>
          <div className="split">
            <div>
              <label htmlFor="vision-provider">Provider</label>
              <select
                id="vision-provider"
                value={form.visionProvider}
                onChange={setVisionProvider}
              >
                <LlmProviderOptions options={VISION_LLM_PROVIDER_OPTIONS} />
              </select>
            </div>
            <div>
              <label htmlFor="vision-model-preset">Model ID</label>
              <select
                id="vision-model-preset"
                value={selectedVisionPresetModel}
                onChange={selectVisionPresetModel}
              >
                {visionModelOptions.map((modelId) => (
                  <option key={modelId} value={modelId}>
                    {modelId}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="split">
            <div>
              <label htmlFor="vision-max-captions-per-hour">Max captions/hour</label>
              <input
                id="vision-max-captions-per-hour"
                type="number"
                min="0"
                max="300"
                value={form.visionMaxCaptionsPerHour}
                onChange={set("visionMaxCaptionsPerHour")}
              />
            </div>
          </div>
        </>
      )}
    </SettingsSection>
  );
}
