import { SettingsSection } from "../SettingsSection";
import { LlmProviderOptions } from "./LlmProviderOptions";
import { isGpt5FamilyModel } from "../../../../src/llm/llmHelpers.ts";

const REASONING_EFFORT_OPTIONS = Object.freeze([
  { value: "none", label: "None" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "X-High" }
]);

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
  setMemoryLlmProvider,
  selectMemoryLlmPresetModel,
  memoryLlmModelOptions,
  selectedMemoryLlmPresetModel
}) {
  const supportsReasoningEffort = isGpt5FamilyModel(form.model);

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

      {supportsReasoningEffort && (
        <>
          <label htmlFor="reasoning-effort">Reasoning effort</label>
          <select
            id="reasoning-effort"
            value={String(form.reasoningEffort || "low")}
            onChange={set("reasoningEffort")}
          >
            {REASONING_EFFORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p>
            Applied to GPT-5 family reasoning models. Lower effort is faster; higher effort spends more thinking tokens.
          </p>
        </>
      )}

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
