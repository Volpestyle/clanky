import { DEFAULT_SETTINGS, type Settings } from "../../settings/settingsSchema.ts";
import {
  normalizeBoolean,
  normalizeInt,
  normalizeStringList
} from "./primitives.ts";

export function normalizePermissionsSection(section: Settings["permissions"]): Settings["permissions"] {
  const replies = section.replies;
  const devTasks = section.devTasks;

  return {
    replies: {
      allowReplies: normalizeBoolean(replies.allowReplies, DEFAULT_SETTINGS.permissions.replies.allowReplies),
      allowUnsolicitedReplies: normalizeBoolean(
        replies.allowUnsolicitedReplies,
        DEFAULT_SETTINGS.permissions.replies.allowUnsolicitedReplies
      ),
      allowReactions: normalizeBoolean(
        replies.allowReactions,
        DEFAULT_SETTINGS.permissions.replies.allowReactions
      ),
      replyChannelIds: normalizeStringList(replies.replyChannelIds, 200, 60),
      allowedChannelIds: normalizeStringList(replies.allowedChannelIds, 200, 60),
      blockedChannelIds: normalizeStringList(replies.blockedChannelIds, 200, 60),
      blockedUserIds: normalizeStringList(replies.blockedUserIds, 200, 60),
      maxMessagesPerHour: normalizeInt(
        replies.maxMessagesPerHour,
        DEFAULT_SETTINGS.permissions.replies.maxMessagesPerHour,
        0,
        500
      ),
      maxReactionsPerHour: normalizeInt(
        replies.maxReactionsPerHour,
        DEFAULT_SETTINGS.permissions.replies.maxReactionsPerHour,
        0,
        500
      )
    },
    devTasks: {
      allowedUserIds: normalizeStringList(devTasks.allowedUserIds, 200, 60)
    }
  };
}
