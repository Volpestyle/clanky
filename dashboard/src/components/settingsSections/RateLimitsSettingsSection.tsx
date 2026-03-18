import { SettingsSection } from "../SettingsSection";
import { SETTINGS_NUMERIC_CONSTRAINTS } from "../../../../src/settings/settingsConstraints.ts";

export function RateLimitsSettingsSection({ id, form, set }) {
  return (
    <SettingsSection id={id} title="Rate Limits">
      <div className="split-3">
        <div>
          <label htmlFor="max-messages">Max bot messages/hour</label>
          <input
            id="max-messages"
            type="number"
            min={SETTINGS_NUMERIC_CONSTRAINTS.permissions.replies.maxMessagesPerHour.min}
            max={SETTINGS_NUMERIC_CONSTRAINTS.permissions.replies.maxMessagesPerHour.max}
            value={form.maxMessages}
            onChange={set("maxMessages")}
          />
        </div>
        <div>
          <label htmlFor="max-reactions">Max reactions/hour</label>
          <input
            id="max-reactions"
            type="number"
            min={SETTINGS_NUMERIC_CONSTRAINTS.permissions.replies.maxReactionsPerHour.min}
            max={SETTINGS_NUMERIC_CONSTRAINTS.permissions.replies.maxReactionsPerHour.max}
            value={form.maxReactions}
            onChange={set("maxReactions")}
          />
        </div>
        <div>
          <label htmlFor="min-gap">Min seconds between bot msgs</label>
          <input
            id="min-gap"
            type="number"
            min="5"
            max="300"
            value={form.minGap}
            onChange={set("minGap")}
          />
        </div>
      </div>
    </SettingsSection>
  );
}
