import { useCallback, useEffect, useRef, useState } from "react";

export type ActivitySSEStatus = "connecting" | "open" | "closed";

type ActivityAction = {
  id?: number;
  created_at?: string;
  createdAt?: string;
  guild_id?: string;
  guildId?: string;
  channel_id?: string;
  channelId?: string;
  message_id?: string;
  messageId?: string;
  user_id?: string;
  userId?: string;
  usd_cost?: number;
  usdCost?: number;
  kind?: string;
  content?: string;
  metadata?: unknown;
  [key: string]: unknown;
};

type ActivitySnapshot = {
  actions?: ActivityAction[];
  stats?: ActivityStats | null;
};

type ActivityStats = Record<string, unknown> & {
  runtime?: {
    isReady?: boolean;
    publicHttps?: {
      enabled?: boolean;
      publicUrl?: string;
      status?: string;
    };
    guildCount?: number;
    [key: string]: unknown;
  };
  stats?: {
    performance?: unknown;
    last24h?: Record<string, unknown>;
    dailyCost?: unknown;
    totalCostUsd?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

const MAX_ACTIONS = 220;
const RECONNECT_DELAY_MS = 3_000;

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeActivityAction(action: ActivityAction): ActivityAction {
  const createdAt = normalizeOptionalString(action.created_at) ?? normalizeOptionalString(action.createdAt);
  const guildId = normalizeOptionalString(action.guild_id) ?? normalizeOptionalString(action.guildId);
  const channelId = normalizeOptionalString(action.channel_id) ?? normalizeOptionalString(action.channelId);
  const messageId = normalizeOptionalString(action.message_id) ?? normalizeOptionalString(action.messageId);
  const userId = normalizeOptionalString(action.user_id) ?? normalizeOptionalString(action.userId);
  const usdCost = normalizeOptionalNumber(action.usd_cost ?? action.usdCost);

  return {
    ...action,
    created_at: createdAt,
    guild_id: guildId,
    channel_id: channelId,
    message_id: messageId,
    user_id: userId,
    usd_cost: usdCost
  };
}

export function useActivitySSE() {
  const [actions, setActions] = useState<ActivityAction[]>([]);
  const [stats, setStats] = useState<ActivityStats | null>(null);
  const [status, setStatus] = useState<ActivitySSEStatus>("connecting");
  const [lastSuccess, setLastSuccess] = useState<number | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const connect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    const es = new EventSource("/api/activity/events");
    esRef.current = es;
    setStatus("connecting");

    es.addEventListener("activity_snapshot", (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data) as ActivitySnapshot;
        setActions(
          Array.isArray(payload?.actions)
            ? payload.actions.slice(0, MAX_ACTIONS).map(normalizeActivityAction)
            : []
        );
        setStats(payload?.stats ?? null);
        setLastSuccess(Date.now());
      } catch {
        // ignore malformed payload
      }
    });

    es.addEventListener("action_event", (event: MessageEvent) => {
      try {
        const action = normalizeActivityAction(JSON.parse(event.data) as ActivityAction);
        setActions((previous) => {
          const actionId = Number(action?.id || 0);
          if (actionId > 0 && previous.some((row) => Number(row?.id || 0) === actionId)) {
            return previous;
          }
          const next = [action, ...previous];
          return next.length > MAX_ACTIONS ? next.slice(0, MAX_ACTIONS) : next;
        });
        setLastSuccess(Date.now());
      } catch {
        // ignore malformed payload
      }
    });

    es.addEventListener("stats_update", (event: MessageEvent) => {
      try {
        setStats(JSON.parse(event.data));
        setLastSuccess(Date.now());
      } catch {
        // ignore malformed payload
      }
    });

    es.onopen = () => {
      setStatus("open");
    };

    es.onerror = () => {
      es.close();
      setStatus("closed");
      reconnectTimerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      esRef.current?.close();
    };
  }, [connect]);

  return {
    actions,
    stats,
    status,
    lastSuccess
  };
}
