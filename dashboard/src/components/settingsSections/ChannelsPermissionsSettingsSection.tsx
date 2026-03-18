import { SettingsSection } from "../SettingsSection";
import { ChannelChecklist } from "../ChannelChecklist";
import { UserIdTagInput } from "../UserIdTagInput";

export function ChannelsPermissionsSettingsSection({ id, form, set }) {
  return (
    <SettingsSection id={id} title="Channels & Permissions">
      <ChannelChecklist
        label="Unsolicited reply channels"
        hint="Channels where the bot can vibe — gets a bonus to jump into conversations organically, can reply as standalone messages instead of threads, softer conversational tone. The bot won't proactively start new topics here unless also listed in discovery channels."
        value={form.replyChannels}
        onChange={set("replyChannels")}
        channelType="text"
      />

      <ChannelChecklist
        label="Discovery channels"
        hint="Channels where the bot can post freely on its own initiative — proactive thoughts, sharing interesting finds from feeds, ambient text posts. A channel can be in both lists to get both behaviors."
        value={form.discoveryChannels}
        onChange={set("discoveryChannels")}
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

      <UserIdTagInput
        id="blocked-users"
        label="Blocked user IDs (text)"
        hint="Messages from these users will be ignored for text replies and reactions."
        value={form.blockedUsers}
        onChange={set("blockedUsers")}
      />

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

      <UserIdTagInput
        id="voice-blocked-users"
        label="Blocked voice user IDs"
        hint="These users cannot trigger or interact with voice mode."
        value={form.voiceBlockedUserIds}
        onChange={set("voiceBlockedUserIds")}
      />
    </SettingsSection>
  );
}
