import React from "react";
import { SettingsSection } from "../SettingsSection";
import { rangeStyle } from "../../utils";

export function CoreBehaviorSettingsSection({ id, form, set, onSanitizeBotNameAliases }) {
  return (
    <SettingsSection id={id} title="Core Behavior">
      <label htmlFor="bot-name">Bot display name</label>
      <input id="bot-name" type="text" value={form.botName} onChange={set("botName")} />

      <label htmlFor="bot-name-aliases">Bot aliases/nicknames (comma separated)</label>
      <textarea
        id="bot-name-aliases"
        rows={4}
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

      <label htmlFor="reply-eagerness">
        Text reply eagerness: <strong>{form.replyEagerness}%</strong>
      </label>
      <input
        id="reply-eagerness"
        type="range"
        min="0"
        max="100"
        step="1"
        value={form.replyEagerness}
        onChange={set("replyEagerness")}
        style={rangeStyle(form.replyEagerness)}
      />
      <p>
        How social the bot is in text channels. At low values it mostly stays quiet unless addressed. At high values ({">"}75%) it sees more messages and decides for itself whether to chime in.
      </p>

      <label htmlFor="text-initiative-eagerness">
        Text initiative eagerness: <strong>{form.textInitiativeEagerness}%</strong>
      </label>
      <input
        id="text-initiative-eagerness"
        type="range"
        min="0"
        max="100"
        step="1"
        value={form.textInitiativeEagerness}
        onChange={set("textInitiativeEagerness")}
        style={rangeStyle(form.textInitiativeEagerness)}
      />
      <p>
        This gates how often the bot even considers a standalone post. The model still decides whether to post, where to post, or to skip.
      </p>

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
            checked={form.textInitiativeEnabled}
            onChange={set("textInitiativeEnabled")}
          />
          Enable text initiative
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

      {form.textInitiativeEnabled && (
        <div className="split">
          <div>
            <label htmlFor="text-initiative-min-minutes">Min minutes between initiative posts</label>
            <input
              id="text-initiative-min-minutes"
              type="number"
              min="5"
              max="1440"
              value={form.textInitiativeMinMinutesBetweenPosts}
              onChange={set("textInitiativeMinMinutesBetweenPosts")}
            />
          </div>
          <div>
            <label htmlFor="text-initiative-max-per-day">Max initiative posts/day</label>
            <input
              id="text-initiative-max-per-day"
              type="number"
              min="0"
              max="100"
              value={form.textInitiativeMaxPostsPerDay}
              onChange={set("textInitiativeMaxPostsPerDay")}
            />
          </div>
        </div>
      )}

      {form.textInitiativeEnabled && (
        <>
          <div className="split">
            <div>
              <label htmlFor="text-initiative-lookback">Recent messages to inspect per channel</label>
              <input
                id="text-initiative-lookback"
                type="number"
                min="4"
                max="80"
                value={form.textInitiativeLookbackMessages}
                onChange={set("textInitiativeLookbackMessages")}
              />
            </div>
            <div>
              <label htmlFor="text-initiative-max-tool-steps">Max initiative tool loop steps</label>
              <input
                id="text-initiative-max-tool-steps"
                type="number"
                min="0"
                max="8"
                value={form.textInitiativeMaxToolSteps}
                onChange={set("textInitiativeMaxToolSteps")}
              />
            </div>
          </div>

          <div className="split">
            <div>
              <label htmlFor="text-initiative-max-tool-calls">Max initiative tool calls</label>
              <input
                id="text-initiative-max-tool-calls"
                type="number"
                min="0"
                max="12"
                value={form.textInitiativeMaxToolCalls}
                onChange={set("textInitiativeMaxToolCalls")}
              />
            </div>
            <div className="toggles" style={{ alignItems: "end" }}>
              <label>
                <input
                  type="checkbox"
                  checked={form.textInitiativeAllowActiveCuriosity}
                  onChange={set("textInitiativeAllowActiveCuriosity")}
                />
                Allow active curiosity tools (`web_search`, `browser_browse`)
              </label>
            </div>
          </div>
        </>
      )}
    </SettingsSection>
  );
}
