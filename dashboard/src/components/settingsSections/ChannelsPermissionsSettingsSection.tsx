import React from "react";
import { SettingsSection } from "../SettingsSection";

export function ChannelsPermissionsSettingsSection({ id, form, set }) {
  return (
    <SettingsSection id={id} title="Channels & Permissions">
      <label htmlFor="reply-channels">Reply/lurk channel IDs (text, optional)</label>
      <textarea
        id="reply-channels"
        rows={2}
        value={form.replyChannels}
        onChange={set("replyChannels")}
      />
      <p className="settings-hint">
        Comma or newline separated. Leave blank to allow reply/lurk behavior in all non-private text channels that are otherwise allowed.
      </p>

      <label htmlFor="discovery-channels">Discovery post channel IDs (text, explicit only)</label>
      <textarea
        id="discovery-channels"
        rows={2}
        value={form.discoveryChannels}
        onChange={set("discoveryChannels")}
      />
      <p className="settings-hint">
        Comma or newline separated. Leave blank to disable discovery posting in all channels.
      </p>

      <h4>Text channels & users</h4>
      <label htmlFor="allowed-channels">Allowed text channel IDs (optional)</label>
      <textarea
        id="allowed-channels"
        rows={3}
        value={form.allowedChannels}
        onChange={set("allowedChannels")}
      />
      <p className="settings-hint">
        Comma or newline separated. Leave blank to allow all text channels unless blocked below.
      </p>

      <label htmlFor="blocked-channels">Blocked text channel IDs (optional)</label>
      <textarea
        id="blocked-channels"
        rows={3}
        value={form.blockedChannels}
        onChange={set("blockedChannels")}
      />
      <p className="settings-hint">
        Comma or newline separated. These text channels are always excluded, even if they are otherwise allowed.
      </p>

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
      <label htmlFor="voice-allowed-channels">Allowed voice channel IDs (optional)</label>
      <textarea
        id="voice-allowed-channels"
        rows={3}
        value={form.voiceAllowedChannelIds}
        onChange={set("voiceAllowedChannelIds")}
      />
      <p className="settings-hint">
        Comma or newline separated. Leave blank to allow voice mode in all voice channels unless blocked below.
      </p>

      <label htmlFor="voice-blocked-channels">Blocked voice channel IDs (optional)</label>
      <textarea
        id="voice-blocked-channels"
        rows={3}
        value={form.voiceBlockedChannelIds}
        onChange={set("voiceBlockedChannelIds")}
      />
      <p className="settings-hint">
        Comma or newline separated. These voice channels are always excluded, even if voice mode is otherwise allowed.
      </p>

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
