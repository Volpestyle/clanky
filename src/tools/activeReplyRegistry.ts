export type ReplyKind = "text-reply" | "voice-generation" | "voice-tool" | "sub-agent";

export interface ActiveReply {
  id: string;
  scopeKey: string;
  kind: ReplyKind;
  abortController: AbortController;
  startedAt: number;
  toolNames: string[];
}

let activeReplyCounter = 0;
let lastRegistryTimestamp = 0;

function nextRegistryTimestamp() {
  const now = Date.now();
  lastRegistryTimestamp = Math.max(lastRegistryTimestamp + 1, now);
  return lastRegistryTimestamp;
}

function normalizeScopeKey(scopeKey: string) {
  const normalized = String(scopeKey || "").trim();
  if (!normalized) {
    throw new Error("missing_active_reply_scope_key");
  }
  return normalized;
}

export function buildTextReplyScopeKey({
  guildId,
  channelId
}: {
  guildId?: string | null;
  channelId?: string | null;
}) {
  const normalizedGuildId = String(guildId || "dm").trim() || "dm";
  const normalizedChannelId = String(channelId || "dm").trim() || "dm";
  return `text:${normalizedGuildId}:${normalizedChannelId}`;
}

export function buildVoiceReplyScopeKey(sessionId: string | null | undefined) {
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId) {
    throw new Error("missing_voice_reply_scope_key");
  }
  return `voice:${normalizedSessionId}`;
}

export class ActiveReplyRegistry {
  private readonly repliesByScope = new Map<string, Set<ActiveReply>>();
  private readonly abortCutoffs = new Map<string, number>();

  begin(scopeKey: string, kind: ReplyKind, toolNames: string[] = []): ActiveReply {
    const normalizedScopeKey = normalizeScopeKey(scopeKey);
    const startedAt = nextRegistryTimestamp();
    activeReplyCounter += 1;
    const reply: ActiveReply = {
      id: `${normalizedScopeKey}:${startedAt}:${activeReplyCounter}`,
      scopeKey: normalizedScopeKey,
      kind,
      abortController: new AbortController(),
      startedAt,
      toolNames: Array.isArray(toolNames)
        ? toolNames.map((entry) => String(entry || "").trim()).filter(Boolean)
        : []
    };
    const existingReplies = this.repliesByScope.get(normalizedScopeKey) || new Set<ActiveReply>();
    existingReplies.add(reply);
    this.repliesByScope.set(normalizedScopeKey, existingReplies);
    return reply;
  }

  abortAll(scopeKey: string, reason = "Reply cancelled by user") {
    const normalizedScopeKey = normalizeScopeKey(scopeKey);
    const replies = this.repliesByScope.get(normalizedScopeKey);
    if (!replies?.size) return 0;

    let abortedCount = 0;
    for (const reply of replies) {
      abortedCount += 1;
      try {
        reply.abortController.abort(reason);
      } catch {
        // ignore
      }
    }

    this.abortCutoffs.set(normalizedScopeKey, nextRegistryTimestamp());
    this.repliesByScope.delete(normalizedScopeKey);
    return abortedCount;
  }

  clear(reply: ActiveReply | null | undefined): void {
    if (!reply) return;
    const replies = this.repliesByScope.get(reply.scopeKey);
    if (!replies) return;
    replies.delete(reply);
    if (replies.size <= 0) {
      this.repliesByScope.delete(reply.scopeKey);
    }
  }

  has(scopeKey: string) {
    const normalizedScopeKey = normalizeScopeKey(scopeKey);
    return Boolean(this.repliesByScope.get(normalizedScopeKey)?.size);
  }

  isStale(scopeKey: string, startedAt: number) {
    const normalizedScopeKey = normalizeScopeKey(scopeKey);
    const cutoff = this.abortCutoffs.get(normalizedScopeKey);
    if (!cutoff) return false;
    const normalizedStartedAt = Math.max(0, Number(startedAt || 0));
    if (!normalizedStartedAt) return false;
    return normalizedStartedAt < cutoff;
  }
}
