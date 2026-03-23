import { isConfiguredOwnerUserId } from "../config.ts";

export function isOwnerPrivateContext({
  guildId = null,
  actorUserId = null,
  explicit = false
}: {
  guildId?: string | null;
  actorUserId?: string | null;
  explicit?: boolean;
}) {
  if (explicit) return true;
  const normalizedGuildId = String(guildId || "").trim();
  if (normalizedGuildId) return false;
  const normalizedActorUserId = String(actorUserId || "").trim();
  if (!normalizedActorUserId) return false;
  return isConfiguredOwnerUserId(normalizedActorUserId);
}
