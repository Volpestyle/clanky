type SessionListEntry = {
  id: string;
  type: string;
  status: string;
  lastUsedAt: number;
};

type SessionRegistryLike<TSession extends SessionLike = SessionLike> = {
  get: (sessionId: string) => TSession | null | undefined;
  list?: () => SessionListEntry[];
};

type SessionLike = {
  id: string;
  type?: string;
  status?: string;
  ownerUserId?: string | null;
  lastUsedAt?: number;
  getPromptStateHint?: () => string | null;
  cancel?: (reason?: string) => void;
};

type MinecraftSessionMatchOptions = {
  ownerUserId?: string | null;
  scopeKey?: string | null;
};

function isActiveMinecraftStatus(status: string | undefined): boolean {
  return status === "idle" || status === "running";
}

function isMinecraftSession<TSession extends SessionLike>(session: TSession | null | undefined): session is TSession {
  return Boolean(session?.id) && session?.type === "minecraft" && isActiveMinecraftStatus(session?.status);
}

function sessionMatchesScope(sessionId: string, scopeKey: string | null | undefined): boolean {
  if (!scopeKey) return true;
  return sessionId.startsWith(`minecraft:${scopeKey}:`);
}

function listActiveMinecraftSessions<TSession extends SessionLike>(registry: SessionRegistryLike<TSession> | null | undefined): TSession[] {
  if (!registry || typeof registry.list !== "function") return [];
  const sessions: TSession[] = [];
  for (const entry of registry.list()) {
    if (entry.type !== "minecraft" || !isActiveMinecraftStatus(entry.status)) continue;
    const session = registry.get(entry.id);
    if (!isMinecraftSession(session)) continue;
    session.lastUsedAt = Number(session.lastUsedAt || entry.lastUsedAt || 0);
    sessions.push(session);
  }
  return sessions.sort((left, right) => Number(right.lastUsedAt || 0) - Number(left.lastUsedAt || 0));
}

export function buildMinecraftSessionScopeKey({
  guildId,
  channelId
}: {
  guildId?: string | null;
  channelId?: string | null;
}): string {
  return `${guildId || "dm"}:${channelId || "dm"}`;
}

export function resolveMinecraftSessionById<TSession extends SessionLike>(
  registry: SessionRegistryLike<TSession> | null | undefined,
  sessionId: string
): TSession | null {
  if (!registry || !sessionId) return null;
  const session = registry.get(sessionId);
  return isMinecraftSession(session) ? session : null;
}

export function isMinecraftSessionAuthorized(
  session: Pick<SessionLike, "ownerUserId"> | null | undefined,
  ownerUserId?: string | null
): boolean {
  return !session?.ownerUserId || session.ownerUserId === ownerUserId;
}

export function findReusableMinecraftSession<TSession extends SessionLike>(
  registry: SessionRegistryLike<TSession> | null | undefined,
  { ownerUserId, scopeKey }: MinecraftSessionMatchOptions = {}
): TSession | null {
  const activeSessions = listActiveMinecraftSessions(registry);
  if (ownerUserId) {
    const scopedOwned = activeSessions.find((session) => session.ownerUserId === ownerUserId && sessionMatchesScope(session.id, scopeKey));
    if (scopedOwned) return scopedOwned;
    return activeSessions.find((session) => session.ownerUserId === ownerUserId) ?? null;
  }
  if (scopeKey) {
    return activeSessions.find((session) => !session.ownerUserId && sessionMatchesScope(session.id, scopeKey)) ?? null;
  }
  return activeSessions.find((session) => !session.ownerUserId) ?? null;
}

export function getMinecraftSessionPromptHint<TSession extends SessionLike>(
  session: TSession | null | undefined
): string | null {
  return typeof session?.getPromptStateHint === "function"
    ? session.getPromptStateHint()
    : null;
}

export function findConflictingMinecraftSession<TSession extends SessionLike>(
  registry: SessionRegistryLike<TSession> | null | undefined,
  { ownerUserId, scopeKey }: MinecraftSessionMatchOptions = {}
): TSession | null {
  const activeSessions = listActiveMinecraftSessions(registry);
  if (ownerUserId) {
    const scopedConflict = activeSessions.find(
      (session) => session.ownerUserId && session.ownerUserId !== ownerUserId && sessionMatchesScope(session.id, scopeKey)
    );
    if (scopedConflict) return scopedConflict;
    return activeSessions.find((session) => session.ownerUserId && session.ownerUserId !== ownerUserId) ?? null;
  }
  if (scopeKey) {
    return activeSessions.find((session) => sessionMatchesScope(session.id, scopeKey)) ?? null;
  }
  return activeSessions[0] ?? null;
}
