import { SettingsSection } from "../SettingsSection";
import { FullPromptPreview } from "../FullPromptPreview";

export function PromptGuidanceSettingsSection({ id, form, set, onResetPromptGuidance }) {
  return (
    <SettingsSection id={id} title="Prompt Lab">
      <p>
        Low-level prompt overrides. Identity and persona live in Behavior. These fields tune reusable system policy lines and are injected directly into the prompt template.
      </p>
      <p>
        Template variable supported in these fields: <code>{"{{botName}}"}</code>.
      </p>

      <button type="button" className="sm" onClick={onResetPromptGuidance}>
        Reset prompt guidance
      </button>

      <FullPromptPreview form={form} />

      <label htmlFor="prompt-capability-honesty-line">Capability honesty line</label>
      <input
        id="prompt-capability-honesty-line"
        type="text"
        value={form.promptCapabilityHonestyLine}
        onChange={set("promptCapabilityHonestyLine")}
      />

      <label htmlFor="prompt-impossible-action-line">Impossible action fallback line</label>
      <input
        id="prompt-impossible-action-line"
        type="text"
        value={form.promptImpossibleActionLine}
        onChange={set("promptImpossibleActionLine")}
      />

      <label htmlFor="prompt-memory-enabled-line">Memory enabled line</label>
      <input
        id="prompt-memory-enabled-line"
        type="text"
        value={form.promptMemoryEnabledLine}
        onChange={set("promptMemoryEnabledLine")}
      />

      <label htmlFor="prompt-memory-disabled-line">Memory disabled line</label>
      <input
        id="prompt-memory-disabled-line"
        type="text"
        value={form.promptMemoryDisabledLine}
        onChange={set("promptMemoryDisabledLine")}
      />

      <label htmlFor="prompt-skip-line">Skip directive line</label>
      <input
        id="prompt-skip-line"
        type="text"
        value={form.promptSkipLine}
        onChange={set("promptSkipLine")}
      />

      <label htmlFor="prompt-text-guidance">Text guidance lines (one per line)</label>
      <textarea
        id="prompt-text-guidance"
        rows={5}
        value={form.promptTextGuidance}
        onChange={set("promptTextGuidance")}
      />

      <label htmlFor="prompt-voice-guidance">Voice guidance lines (one per line)</label>
      <textarea
        id="prompt-voice-guidance"
        rows={4}
        value={form.promptVoiceGuidance}
        onChange={set("promptVoiceGuidance")}
      />

      <label htmlFor="prompt-voice-operational-guidance">Voice operational guidance lines (one per line)</label>
      <textarea
        id="prompt-voice-operational-guidance"
        rows={4}
        value={form.promptVoiceOperationalGuidance}
        onChange={set("promptVoiceOperationalGuidance")}
      />

      <label htmlFor="prompt-media-guidance">Media prompt craft guidance</label>
      <textarea
        id="prompt-media-guidance"
        rows={5}
        value={form.promptMediaPromptCraftGuidance}
        onChange={set("promptMediaPromptCraftGuidance")}
      />
    </SettingsSection>
  );
}
