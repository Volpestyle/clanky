import React from "react";
import { SettingsSection } from "../SettingsSection";
import { ChannelChecklist } from "../ChannelChecklist";

export function ChannelsPermissionsSettingsSection({ id, form, set }) {
  return (
    <SettingsSection id={id} title="Channels & Permissions">
      <ChannelChecklist
        label="Initiative + unsolicited reply channels (text)"
        hint="This is the shared eligible pool for standalone initiative posts and unsolicited replies. Leave empty to disable bot-initiated text activity everywhere."
        value={form.replyChannels}
        onChange={set("replyChannels")}
        channelType="text"
      />

      <h4>Text channels & users</h4>
      <ChannelChecklist
        label="Allowed text channels"
        hint="Leave empty to allow all text channels unless blocked below."
        value={form.allowedChannels}
        onChange={set("allowedChannels")}
        channelType="text"
      />

      <ChannelChecklist
        label="Blocked text channels"
        hint="These text channels are always excluded, even if they are otherwise allowed."
        value={form.blockedChannels}
        onChange={set("blockedChannels")}
        channelType="text"
      />

      <label htmlFor="blocked-users">Blocked user IDs (text, optional)</label>
      <textarea
        id="blocked-users"
        rows={3}
        value={form.blockedUsers}
        onChange={set("blockedUsers")}
      />
      <p className="settings-hint">
        Comma or newline separated. Messages from these users will be ignored for text replies and reactions.
      </p>

      <h4>Voice channels & users</h4>
      <ChannelChecklist
        label="Allowed voice channels"
        hint="Leave empty to allow voice mode in all voice channels unless blocked below."
        value={form.voiceAllowedChannelIds}
        onChange={set("voiceAllowedChannelIds")}
        channelType="voice"
      />

      <ChannelChecklist
        label="Blocked voice channels"
        hint="These voice channels are always excluded, even if voice mode is otherwise allowed."
        value={form.voiceBlockedChannelIds}
        onChange={set("voiceBlockedChannelIds")}
        channelType="voice"
      />

      <label htmlFor="voice-blocked-users">Blocked voice user IDs (optional)</label>
      <textarea
        id="voice-blocked-users"
        rows={3}
        value={form.voiceBlockedUserIds}
        onChange={set("voiceBlockedUserIds")}
      />
      <p className="settings-hint">
        Comma or newline separated. These users cannot trigger or interact with voice mode.
      </p>
    </SettingsSection>
  );
}
