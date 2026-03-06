import {
  getMemorySettings,
  getReplyPermissions,
  getStartupSettings
} from "../settings/agentStack.ts";

export async function runStartupCatchup(runtime, settings) {
  const startup = getStartupSettings(settings);
  const replyPermissions = getReplyPermissions(settings);
  const memory = getMemorySettings(settings);
  if (!startup.catchupEnabled) return;
  if (!replyPermissions.allowReplies) return;

  const channels = runtime.getStartupScanChannels(settings);
  const lookbackMs = startup.catchupLookbackHours * 60 * 60_000;
  const maxMessages = startup.catchupMaxMessagesPerChannel;
  const maxRepliesPerChannel = startup.maxCatchupRepliesPerChannel;
  const now = Date.now();

  for (const channel of channels) {
    let repliesSent = 0;

    const messages = await runtime.hydrateRecentMessages(channel, maxMessages);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (repliesSent >= maxRepliesPerChannel) break;
      if (
        !message?.author ||
        String(message.author.id || "") === String(runtime.botUserId || "")
      ) continue;
      if (!message.guild || !message.channel) continue;
      if (!runtime.isChannelAllowed(settings, message.channelId)) continue;
      if (runtime.isUserBlocked(settings, message.author.id)) continue;

      const recentMessages = runtime.store.getRecentMessages(
        message.channelId,
        memory.promptSlice.maxRecentMessages
      );
      const addressSignal = await runtime.getReplyAddressSignal(settings, message, recentMessages);
      if (!addressSignal.triggered) continue;
      if (now - message.createdTimestamp > lookbackMs) continue;
      if (runtime.store.hasTriggeredResponse(message.id)) continue;
      if (
        runtime.hasStartupFollowupAfterMessage({
          messages,
          messageIndex: index,
          triggerMessageId: message.id
        })
      ) {
        continue;
      }
      const queued = runtime.enqueueReplyJob({
        message,
        source: "startup_catchup",
        forceRespond: true,
        addressSignal
      });
      if (queued) repliesSent += 1;
    }
  }
}
