import {
  getReplyPermissions
} from "../settings/agentStack.ts";
import type { Settings } from "../settings/settingsSchema.ts";

function normalizeIds(values: Iterable<string>) {
  return [...values].map((value) => String(value));
}

export function isUserBlocked(settings: Settings, userId: string) {
  const blockedUserIds = normalizeIds(getReplyPermissions(settings).blockedUserIds);
  return blockedUserIds.includes(String(userId));
}

export function isChannelAllowed(settings: Settings, channelId: string) {
  const id = String(channelId);
  const permissions = getReplyPermissions(settings);
  const blockedChannelIds = normalizeIds(permissions.blockedChannelIds);
  const allowedChannelIds = normalizeIds(permissions.allowedChannelIds);

  if (blockedChannelIds.includes(id)) {
    return false;
  }

  if (allowedChannelIds.length === 0) {
    return true;
  }

  return allowedChannelIds.includes(id);
}

export function isReplyChannel(settings: Settings, channelId: string) {
  const id = String(channelId);
  const replyChannelIds = normalizeIds(getReplyPermissions(settings).replyChannelIds);
  if (!replyChannelIds.length) return false;
  return replyChannelIds.includes(id);
}
