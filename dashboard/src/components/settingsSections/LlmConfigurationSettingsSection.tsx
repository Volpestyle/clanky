import { SettingsSection } from "../SettingsSection";
import { LlmProviderOptions } from "./LlmProviderOptions";

export function LlmConfigurationSettingsSection({
  id,
  form,
  set,
  setProvider,
  selectPresetModel,
  providerModelOptions,
  selectedPresetModel,
  setTextInitiativeProvider,
  selectTextInitiativePresetModel,
  textInitiativeModelOptions,
  selectedTextInitiativePresetModel,
  setReplyFollowupProvider,
  selectReplyFollowupPresetModel,
  replyFollowupModelOptions,
  selectedReplyFollowupPresetModel,
  setMemoryLlmProvider,
  selectMemoryLlmPresetModel,
  memoryLlmModelOptions,
  selectedMemoryLlmPresetModel
}) {
  return (
    <SettingsSection id={id} title="Text LLM">
      <label htmlFor="provider">LLM provider</label>
      <select id="provider" value={form.provider} onChange={setProvider}>
        <LlmProviderOptions />
      </select>

      <label htmlFor="model-preset">Model ID</label>
      <select id="model-preset" value={selectedPresetModel} onChange={selectPresetModel}>
        {providerModelOptions.map((modelId) => (
          <option key={modelId} value={modelId}>
            {modelId}
          </option>
        ))}
      </select>

      <div className="split">
        <div>
          <label htmlFor="temperature">Temperature</label>
          <input
            id="temperature"
            type="number"
            min="0"
            max="2"
            step="0.1"
            value={form.temperature}
            onChange={set("temperature")}
          />
        </div>
        <div>
          <label htmlFor="max-tokens">Max output tokens</label>
          <input
            id="max-tokens"
            type="number"
            min="32"
            step="1"
            value={form.maxTokens}
            onChange={set("maxTokens")}
          />
        </div>
      </div>

      <h4>Ambient Text LLM</h4>
      <p>Optional override for the ambient text cycle. Leave this on inherit unless you want ambient posts to use a different model.</p>
      <div className="toggles">
        <label>
          <input
            type="checkbox"
            checked={form.textInitiativeUseTextModel}
            onChange={set("textInitiativeUseTextModel")}
          />
          Inherit the main text model
        </label>
      </div>
      <div className="split">
        <div>
          <label htmlFor="text-initiative-llm-provider">Provider</label>
          <select
            id="text-initiative-llm-provider"
            value={form.textInitiativeLlmProvider}
            onChange={setTextInitiativeProvider}
            disabled={form.textInitiativeUseTextModel}
          >
            <LlmProviderOptions />
          </select>
        </div>
        <div>
          <label htmlFor="text-initiative-llm-model-preset">Model ID</label>
          <select
            id="text-initiative-llm-model-preset"
            value={selectedTextInitiativePresetModel}
            onChange={selectTextInitiativePresetModel}
            disabled={form.textInitiativeUseTextModel}
          >
            {textInitiativeModelOptions.map((modelId) => (
              <option key={modelId} value={modelId}>
                {modelId}
              </option>
            ))}
          </select>
        </div>
      </div>

      <h4>Reply Follow-Up Regeneration LLM</h4>
      <p>Optional override for second-pass reply regeneration (web search / memory lookup follow-ups).</p>
      <div className="toggles">
        <label>
          <input
            type="checkbox"
            checked={form.replyFollowupLlmEnabled}
            onChange={set("replyFollowupLlmEnabled")}
          />
          Use separate follow-up LLM
        </label>
      </div>
      <div className="split">
        <div>
          <label htmlFor="reply-followup-llm-provider">Provider</label>
          <select
            id="reply-followup-llm-provider"
            value={form.replyFollowupLlmProvider}
            onChange={setReplyFollowupProvider}
            disabled={!form.replyFollowupLlmEnabled}
          >
            <LlmProviderOptions />
          </select>
        </div>
        <div>
          <label htmlFor="reply-followup-llm-model-preset">Model ID</label>
          <select
            id="reply-followup-llm-model-preset"
            value={selectedReplyFollowupPresetModel}
            onChange={selectReplyFollowupPresetModel}
            disabled={!form.replyFollowupLlmEnabled}
          >
            {replyFollowupModelOptions.map((modelId) => (
              <option key={modelId} value={modelId}>
                {modelId}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="split">
        <div>
          <label htmlFor="reply-followup-max-tool-steps">Max loop steps</label>
          <input
            id="reply-followup-max-tool-steps"
            type="number"
            min="0"
            max="6"
            step="1"
            value={form.replyFollowupMaxToolSteps}
            onChange={set("replyFollowupMaxToolSteps")}
          />
        </div>
        <div>
          <label htmlFor="reply-followup-max-total-tool-calls">Max total tool calls</label>
          <input
            id="reply-followup-max-total-tool-calls"
            type="number"
            min="0"
            max="12"
            step="1"
            value={form.replyFollowupMaxTotalToolCalls}
            onChange={set("replyFollowupMaxTotalToolCalls")}
          />
        </div>
      </div>
      <div className="split">
        <div>
          <label htmlFor="reply-followup-max-web-search-calls">Max web-search calls</label>
          <input
            id="reply-followup-max-web-search-calls"
            type="number"
            min="0"
            max="6"
            step="1"
            value={form.replyFollowupMaxWebSearchCalls}
            onChange={set("replyFollowupMaxWebSearchCalls")}
          />
        </div>
        <div>
          <label htmlFor="reply-followup-max-memory-lookup-calls">Max memory-lookup calls</label>
          <input
            id="reply-followup-max-memory-lookup-calls"
            type="number"
            min="0"
            max="6"
            step="1"
            value={form.replyFollowupMaxMemoryLookupCalls}
            onChange={set("replyFollowupMaxMemoryLookupCalls")}
          />
        </div>
      </div>
      <div className="split">
        <div>
          <label htmlFor="reply-followup-max-image-lookup-calls">Max image-lookup calls</label>
          <input
            id="reply-followup-max-image-lookup-calls"
            type="number"
            min="0"
            max="6"
            step="1"
            value={form.replyFollowupMaxImageLookupCalls}
            onChange={set("replyFollowupMaxImageLookupCalls")}
          />
        </div>
        <div>
          <label htmlFor="reply-followup-tool-timeout-ms">Tool timeout (ms)</label>
          <input
            id="reply-followup-tool-timeout-ms"
            type="number"
            min="0"
            max="60000"
            step="100"
            value={form.replyFollowupToolTimeoutMs}
            onChange={set("replyFollowupToolTimeoutMs")}
          />
        </div>
      </div>

      <h4>Memory LLM</h4>
      <p>
        Used for daily reflection and memory-adjacent background work.
      </p>
      <div className="toggles">
        <label>
          <input
            type="checkbox"
            checked={form.memoryLlmInheritTextModel}
            onChange={set("memoryLlmInheritTextModel")}
          />
          Inherit the main text model
        </label>
      </div>
      <div className="split">
        <div>
          <label htmlFor="memory-llm-provider">Provider</label>
          <select
            id="memory-llm-provider"
            value={form.memoryLlmProvider}
            onChange={setMemoryLlmProvider}
            disabled={form.memoryLlmInheritTextModel}
          >
            <LlmProviderOptions />
          </select>
        </div>
        <div>
          <label htmlFor="memory-llm-model-preset">Model ID</label>
          <select
            id="memory-llm-model-preset"
            value={selectedMemoryLlmPresetModel}
            onChange={selectMemoryLlmPresetModel}
            disabled={form.memoryLlmInheritTextModel}
          >
            {memoryLlmModelOptions.map((modelId) => (
              <option key={modelId} value={modelId}>
                {modelId}
              </option>
            ))}
          </select>
        </div>
      </div>
    </SettingsSection>
  );
}
