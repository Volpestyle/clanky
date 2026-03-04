import React from "react";
import { SettingsSection } from "../SettingsSection";

export function ChannelsPermissionsSettingsSection({ id, form, set }) {
  return (
    <SettingsSection id={id} title="Channels & Permissions">
      <label htmlFor="reply-channels">Reply/lurk channel IDs</label>
      <textarea
        id="reply-channels"
        rows={2}
        value={form.replyChannels}
        onChange={set("replyChannels")}
      />

      <label htmlFor="discovery-channels">Discovery post channel IDs</label>
      <textarea
        id="discovery-channels"
        rows={2}
        value={form.discoveryChannels}
        onChange={set("discoveryChannels")}
      />

      <h4>Text channels & users</h4>
      <label htmlFor="allowed-channels">Allowed channel IDs (comma/newline)</label>
      <textarea
        id="allowed-channels"
        rows={3}
        value={form.allowedChannels}
        onChange={set("allowedChannels")}
      />

      <label htmlFor="blocked-channels">Blocked channel IDs (comma/newline)</label>
      <textarea
        id="blocked-channels"
        rows={3}
        value={form.blockedChannels}
        onChange={set("blockedChannels")}
      />

      <label htmlFor="blocked-users">Blocked user IDs (comma/newline)</label>
      <textarea
        id="blocked-users"
        rows={3}
        value={form.blockedUsers}
        onChange={set("blockedUsers")}
      />

      <h4>Voice channels & users</h4>
      <label htmlFor="voice-allowed-channels">Allowed voice channel IDs (optional)</label>
      <textarea
        id="voice-allowed-channels"
        rows={3}
        value={form.voiceAllowedChannelIds}
        onChange={set("voiceAllowedChannelIds")}
      />

      <label htmlFor="voice-blocked-channels">Blocked voice channel IDs</label>
      <textarea
        id="voice-blocked-channels"
        rows={3}
        value={form.voiceBlockedChannelIds}
        onChange={set("voiceBlockedChannelIds")}
      />

      <label htmlFor="voice-blocked-users">Blocked voice user IDs</label>
      <textarea
        id="voice-blocked-users"
        rows={3}
        value={form.voiceBlockedUserIds}
        onChange={set("voiceBlockedUserIds")}
      />
    </SettingsSection>
  );
}
