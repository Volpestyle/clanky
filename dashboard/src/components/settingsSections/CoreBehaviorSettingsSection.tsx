import React from "react";
import { SettingsSection } from "../SettingsSection";
import { rangeStyle } from "../../utils";

export function CoreBehaviorSettingsSection({ id, form, set, onSanitizeBotNameAliases }) {
  return (
    <SettingsSection id={id} title="Core Behavior">
      <label htmlFor="bot-name">Bot display name</label>
      <input id="bot-name" type="text" value={form.botName} onChange={set("botName")} />

      <label htmlFor="bot-name-aliases">Bot aliases/nicknames (comma or newline separated)</label>
      <textarea
        id="bot-name-aliases"
        rows={3}
        value={form.botNameAliases}
        onChange={set("botNameAliases")}
        onBlur={onSanitizeBotNameAliases}
      />

      <label htmlFor="persona-flavor">Persona flavor</label>
      <textarea
        id="persona-flavor"
        rows={3}
        value={form.personaFlavor}
        onChange={set("personaFlavor")}
      />

      <label htmlFor="persona-hard-limits">Persona hard limits (one per line)</label>
      <textarea
        id="persona-hard-limits"
        rows={4}
        value={form.personaHardLimits}
        onChange={set("personaHardLimits")}
      />

      <label htmlFor="reply-level-reply-channels">
        Unsolicited reply eagerness (reply channels): <strong>{form.replyLevelReplyChannels}%</strong>
      </label>
      <input
        id="reply-level-reply-channels"
        type="range"
        min="0"
        max="100"
        step="1"
        value={form.replyLevelReplyChannels}
        onChange={set("replyLevelReplyChannels")}
        style={rangeStyle(form.replyLevelReplyChannels)}
      />

      <label htmlFor="reply-level-other-channels">
        Unsolicited reply eagerness (other channels): <strong>{form.replyLevelOtherChannels}%</strong>
      </label>
      <input
        id="reply-level-other-channels"
        type="range"
        min="0"
        max="100"
        step="1"
        value={form.replyLevelOtherChannels}
        onChange={set("replyLevelOtherChannels")}
        style={rangeStyle(form.replyLevelOtherChannels)}
      />

      <label htmlFor="text-thought-loop-eagerness">
        Text thought-loop eagerness: <strong>{form.textThoughtLoopEagerness}%</strong>
      </label>
      <input
        id="text-thought-loop-eagerness"
        type="range"
        min="0"
        max="100"
        step="1"
        value={form.textThoughtLoopEagerness}
        onChange={set("textThoughtLoopEagerness")}
        style={rangeStyle(form.textThoughtLoopEagerness)}
      />

      <label htmlFor="reaction-level">
        Reaction eagerness: <strong>{form.reactionLevel}%</strong>
      </label>
      <input
        id="reaction-level"
        type="range"
        min="0"
        max="100"
        step="1"
        value={form.reactionLevel}
        onChange={set("reactionLevel")}
        style={rangeStyle(form.reactionLevel)}
      />

      <div className="toggles">
        <label>
          <input type="checkbox" checked={form.allowReplies} onChange={set("allowReplies")} />
          Allow replies
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.allowUnsolicitedReplies}
            onChange={set("allowUnsolicitedReplies")}
          />
          Allow unsolicited replies
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.textThoughtLoopEnabled}
            onChange={set("textThoughtLoopEnabled")}
          />
          Enable text thought loop
        </label>
        <label>
          <input type="checkbox" checked={form.allowReactions} onChange={set("allowReactions")} />
          Allow reactions
        </label>
        <label>
          <input type="checkbox" checked={form.memoryEnabled} onChange={set("memoryEnabled")} />
          Durable memory enabled
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.adaptiveDirectivesEnabled}
            onChange={set("adaptiveDirectivesEnabled")}
          />
          Adaptive directives enabled
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.automationsEnabled}
            onChange={set("automationsEnabled")}
          />
          Automations enabled
        </label>
      </div>

      {form.textThoughtLoopEnabled && (
        <div className="split">
          <div>
            <label htmlFor="text-thought-loop-min-minutes">Min minutes between thoughts</label>
            <input
              id="text-thought-loop-min-minutes"
              type="number"
              min="5"
              max="1440"
              value={form.textThoughtLoopMinMinutesBetweenThoughts}
              onChange={set("textThoughtLoopMinMinutesBetweenThoughts")}
            />
          </div>
          <div>
            <label htmlFor="text-thought-loop-max-per-day">Max thought replies/day</label>
            <input
              id="text-thought-loop-max-per-day"
              type="number"
              min="0"
              max="100"
              value={form.textThoughtLoopMaxThoughtsPerDay}
              onChange={set("textThoughtLoopMaxThoughtsPerDay")}
            />
          </div>
        </div>
      )}

      {form.textThoughtLoopEnabled && (
        <div>
          <label htmlFor="text-thought-loop-lookback">Recent messages to inspect per channel</label>
          <input
            id="text-thought-loop-lookback"
            type="number"
            min="4"
            max="80"
            value={form.textThoughtLoopLookbackMessages}
            onChange={set("textThoughtLoopLookbackMessages")}
          />
        </div>
      )}
    </SettingsSection>
  );
}
