import React from "react";
import { SettingsSection } from "../SettingsSection";

export function BrowserSettingsSection({
  id,
  form,
  set,
  setBrowserLlmProvider,
  selectBrowserLlmPresetModel,
  browserLlmModelOptions,
  selectedBrowserLlmPresetModel
}) {
  const nativeRuntime = form.stackResolvedBrowserRuntime === "openai_computer_use";
  return (
    <SettingsSection id={id} title="Browser Runtime" active={form.browserEnabled}>
      <div className="toggles">
        <label>
          <input
            type="checkbox"
            checked={form.browserEnabled}
            onChange={set("browserEnabled")}
          />
          Enable browser agent
        </label>
      </div>

      {form.browserEnabled && (
        <>
          <p className="status-msg info" style={{ marginTop: 0 }}>
            Resolved runtime: {form.stackResolvedBrowserRuntime}
          </p>

          {nativeRuntime ? (
            <div className="split">
              <div>
                <label htmlFor="browser-openai-computer-use-model">OpenAI computer use model</label>
                <input
                  id="browser-openai-computer-use-model"
                  type="text"
                  value={form.browserOpenAiComputerUseModel}
                  onChange={set("browserOpenAiComputerUseModel")}
                  placeholder="computer-use-preview"
                />
              </div>
            </div>
          ) : (
            <div className="split">
              <div>
                <label htmlFor="browser-llm-provider">Provider</label>
                <select
                  id="browser-llm-provider"
                  value={form.browserLlmProvider}
                  onChange={setBrowserLlmProvider}
                >
                  <option value="anthropic">anthropic</option>
                  <option value="openai">openai</option>
                </select>
              </div>
              <div>
                <label htmlFor="browser-llm-model-preset">Model ID</label>
                <select
                  id="browser-llm-model-preset"
                  value={selectedBrowserLlmPresetModel}
                  onChange={selectBrowserLlmPresetModel}
                >
                  {browserLlmModelOptions.map((modelId) => (
                    <option key={modelId} value={modelId}>
                      {modelId}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          <div className="split">
            <div>
              <label htmlFor="browser-max-per-hour">Max browse calls/hour</label>
              <input
                id="browser-max-per-hour"
                type="number"
                min="1"
                max="60"
                value={form.browserMaxPerHour}
                onChange={set("browserMaxPerHour")}
              />
            </div>
            <div>
              <label htmlFor="browser-max-steps">Max steps/task</label>
              <input
                id="browser-max-steps"
                type="number"
                min="1"
                max="30"
                value={form.browserMaxSteps}
                onChange={set("browserMaxSteps")}
              />
            </div>
          </div>

          <div className="split">
            <div>
              <label htmlFor="browser-step-timeout">Step timeout (ms)</label>
              <input
                id="browser-step-timeout"
                type="number"
                min="5000"
                max="120000"
                step="1000"
                value={form.browserStepTimeoutMs}
                onChange={set("browserStepTimeoutMs")}
              />
            </div>
            <div>
              <label htmlFor="browser-session-timeout">Session timeout (ms)</label>
              <input
                id="browser-session-timeout"
                type="number"
                min="30000"
                max="600000"
                step="1000"
                value={form.browserSessionTimeoutMs}
                onChange={set("browserSessionTimeoutMs")}
              />
            </div>
          </div>
        </>
      )}
    </SettingsSection>
  );
}
