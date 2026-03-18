import { SettingsSection } from "../SettingsSection";
import { SETTINGS_NUMERIC_CONSTRAINTS } from "../../../../src/settings/settingsConstraints.ts";

export function StartupCatchupSettingsSection({ id, form, set }) {
  return (
    <SettingsSection id={id} title="Startup Catch-up" active={form.catchupEnabled}>
      <div className="toggles">
        <label>
          <input type="checkbox" checked={form.catchupEnabled} onChange={set("catchupEnabled")} />
          Catch up on recent messages at startup
        </label>
      </div>

      {form.catchupEnabled && (
        <div className="split-3">
          <div>
            <label htmlFor="catchup-lookback">Catch-up lookback (hours)</label>
            <input
              id="catchup-lookback"
              type="number"
              min={SETTINGS_NUMERIC_CONSTRAINTS.interaction.startup.catchupLookbackHours.min}
              max={SETTINGS_NUMERIC_CONSTRAINTS.interaction.startup.catchupLookbackHours.max}
              value={form.catchupLookbackHours}
              onChange={set("catchupLookbackHours")}
            />
          </div>
          <div>
            <label htmlFor="catchup-max-messages">Messages scanned per channel</label>
            <input
              id="catchup-max-messages"
              type="number"
              min={SETTINGS_NUMERIC_CONSTRAINTS.interaction.startup.catchupMaxMessagesPerChannel.min}
              max={SETTINGS_NUMERIC_CONSTRAINTS.interaction.startup.catchupMaxMessagesPerChannel.max}
              value={form.catchupMaxMessages}
              onChange={set("catchupMaxMessages")}
            />
          </div>
          <div>
            <label htmlFor="catchup-max-replies">Max startup replies per channel</label>
            <input
              id="catchup-max-replies"
              type="number"
              min={SETTINGS_NUMERIC_CONSTRAINTS.interaction.startup.maxCatchupRepliesPerChannel.min}
              max={SETTINGS_NUMERIC_CONSTRAINTS.interaction.startup.maxCatchupRepliesPerChannel.max}
              value={form.catchupMaxReplies}
              onChange={set("catchupMaxReplies")}
            />
          </div>
        </div>
      )}
    </SettingsSection>
  );
}
