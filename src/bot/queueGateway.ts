import { clamp, sleep } from "../utils.ts";
import { type ReplyAddressSignal } from "./replyAdmission.ts";
import type { QueueGatewayRuntime } from "./botContext.ts";
import {
  getActivitySettings,
  getMemorySettings,
  getReplyPermissions
} from "../settings/agentStack.ts";
import { buildRuntimeDecisionCorrelation } from "../services/runtimeCorrelation.ts";

const REPLY_QUEUE_RATE_LIMIT_WAIT_MS = 15_000;
const REPLY_QUEUE_SEND_RETRY_BASE_MS = 2_500;
const REPLY_QUEUE_SEND_MAX_RETRIES = 2;
const REPLY_QUEUE_COALESCE_EDGE_GRACE_MS = 250;
const GATEWAY_STALE_MS = 2 * 60_000;
const GATEWAY_RECONNECT_BASE_DELAY_MS = 5_000;
const GATEWAY_RECONNECT_MAX_DELAY_MS = 60_000;

type ReplyCoalesceWaitOptions = {
  nowMs?: number;
  allowEdgeGrace?: boolean;
  edgeGraceMs?: number;
};

type ReplyQueueMessage = {
  id?: string;
  guildId?: string;
  channelId?: string;
  guild?: unknown;
  channel?: unknown;
  createdTimestamp?: number;
  author?: {
    id?: string;
  } | null;
};

type ReplyQueueAddressSignal = {
  direct: boolean;
  inferred: boolean;
  triggered: boolean;
  reason: string;
  confidence: number;
  threshold: number;
  confidenceSource: ReplyAddressSignal["confidenceSource"];
};

type ReplyQueueJob = {
  message?: ReplyQueueMessage;
  addressSignal?: Partial<ReplyQueueAddressSignal> | null;
  forceRespond?: boolean;
  attempts?: number;
  source?: string;
  performanceSeed?: Record<string, unknown> | null;
};

type ReplyQueueRateLimitRuntime = Pick<QueueGatewayRuntime, "lastBotMessageAt" | "canSendMessage">;

type ReplyQueueStorageRuntime = {
  replyQueues: Map<string, ReplyQueueJob[]>;
  replyQueuedMessageIds: Set<string>;
};

export function getReplyQueueWaitMs(
  bot: ReplyQueueRateLimitRuntime,
  settings: Record<string, unknown>
) {
  const activity = getActivitySettings(settings);
  const permissions = getReplyPermissions(settings);
  const cooldownMs = activity.minSecondsBetweenMessages * 1000;
  const elapsed = Date.now() - bot.lastBotMessageAt;
  const cooldownWaitMs = Math.max(0, cooldownMs - elapsed);
  if (cooldownWaitMs > 0) return cooldownWaitMs;
  if (!bot.canSendMessage(permissions.maxMessagesPerHour)) {
    return REPLY_QUEUE_RATE_LIMIT_WAIT_MS;
  }
  return 0;
}

function getReplyCoalesceWindowMs(settings: Record<string, unknown>) {
  const activity = getActivitySettings(settings);
  const seconds = clamp(Number(activity.replyCoalesceWindowSeconds) || 0, 0, 20);
  return Math.floor(seconds * 1000);
}

function getReplyCoalesceMaxMessages(settings: Record<string, unknown>) {
  const activity = getActivitySettings(settings);
  return clamp(Number(activity.replyCoalesceMaxMessages) || 1, 1, 20);
}

function getReplyCoalesceWaitMs(
  settings: Record<string, unknown>,
  message: ReplyQueueMessage | null | undefined,
  options: ReplyCoalesceWaitOptions = {}
) {
  const windowMs = getReplyCoalesceWindowMs(settings);
  if (windowMs <= 0) return 0;
  const nowMs = Number(options?.nowMs);
  const currentMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const createdAtRaw = Number(message?.createdTimestamp);
  const createdAt = Number.isFinite(createdAtRaw) && createdAtRaw > 0 ? createdAtRaw : currentMs;
  const ageMs = currentMs - createdAt;
  const waitMs = Math.max(0, windowMs - ageMs);
  if (waitMs > 0) return waitMs;
  if (!options?.allowEdgeGrace) return 0;

  const edgeGraceMs = clamp(
    Number(options?.edgeGraceMs ?? REPLY_QUEUE_COALESCE_EDGE_GRACE_MS),
    0,
    1_000
  );
  if (edgeGraceMs <= 0) return 0;

  const overrunMs = ageMs - windowMs;
  if (overrunMs >= edgeGraceMs) return 0;

  return Math.max(0, edgeGraceMs - overrunMs);
}

export function dequeueReplyJob(bot: ReplyQueueStorageRuntime, channelId: string) {
  const queue = bot.replyQueues.get(channelId);
  if (!queue?.length) return null;

  const job = queue.shift();
  if (job?.message?.id) {
    bot.replyQueuedMessageIds.delete(String(job.message.id));
  }

  if (!queue.length) {
    bot.replyQueues.delete(channelId);
  }

  return job;
}

export function dequeueReplyBurst(
  bot: ReplyQueueStorageRuntime,
  channelId: string,
  settings: Record<string, unknown>
) {
  const firstJob = dequeueReplyJob(bot, channelId);
  if (!firstJob) return [];

  const burst = [firstJob];
  const windowMs = getReplyCoalesceWindowMs(settings);
  const maxMessages = getReplyCoalesceMaxMessages(settings);
  if (windowMs <= 0 || maxMessages <= 1) return burst;

  const firstMessage = firstJob.message;
  const firstCreatedAtRaw = Number(firstMessage?.createdTimestamp);
  let lastAcceptedCreatedAt = Number.isFinite(firstCreatedAtRaw) && firstCreatedAtRaw > 0
    ? firstCreatedAtRaw
    : Date.now();

  while (burst.length < maxMessages) {
    const queue = bot.replyQueues.get(channelId);
    const candidate = queue?.[0];
    if (!candidate) break;

    const candidateMessage = candidate.message;
    if (!candidateMessage?.id) {
      dequeueReplyJob(bot, channelId);
      continue;
    }

    const candidateCreatedAtRaw = Number(candidateMessage.createdTimestamp);
    const candidateCreatedAt = Number.isFinite(candidateCreatedAtRaw) && candidateCreatedAtRaw > 0
      ? candidateCreatedAtRaw
      : lastAcceptedCreatedAt;
    if (Math.abs(candidateCreatedAt - lastAcceptedCreatedAt) > windowMs) break;

    const nextJob = dequeueReplyJob(bot, channelId);
    if (!nextJob) break;
    burst.push(nextJob);
    lastAcceptedCreatedAt = candidateCreatedAt;
  }

  return burst;
}

export function requeueReplyJobs(
  bot: ReplyQueueStorageRuntime,
  channelId: string,
  jobs: ReplyQueueJob[]
) {
  const validJobs = (jobs || []).filter((job) => job?.message?.id);
  if (!validJobs.length) return;

  const queue = bot.replyQueues.get(channelId) || [];
  queue.unshift(...validJobs);
  bot.replyQueues.set(channelId, queue);
  for (const job of validJobs) {
    bot.replyQueuedMessageIds.add(String(job.message.id));
  }
}

function normalizeConfidenceSource(
  value: unknown
): ReplyAddressSignal["confidenceSource"] {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "llm" || normalized === "direct" || normalized === "exact_name") {
    return normalized;
  }
  return "fallback";
}

function logReplyQueueGateRejected(
  bot: QueueGatewayRuntime,
  {
    channelId,
    queueDepth,
    head,
    message,
    reason,
    metadata = {}
  }: {
    channelId: string;
    queueDepth: number;
    head: ReplyQueueJob | null | undefined;
    message: ReplyQueueMessage | null | undefined;
    reason: string;
    metadata?: Record<string, unknown>;
  }
) {
  const createdAt = Number(message?.createdTimestamp);
  const ageMs = Number.isFinite(createdAt) && createdAt > 0
    ? Math.max(0, Date.now() - createdAt)
    : null;
  const source = String(head?.source || "").trim() || null;
  bot.store.logAction({
    kind: "text_runtime",
    guildId: String(message?.guildId || "").trim() || null,
    channelId: String(message?.channelId || channelId || "").trim() || null,
    messageId: String(message?.id || "").trim() || null,
    userId: String(message?.author?.id || "").trim() || null,
    content: "reply_queue_gate_rejected",
    metadata: {
      ...buildRuntimeDecisionCorrelation({
        botId: bot.client.user?.id || null,
        triggerMessageId: String(message?.id || "").trim() || null,
        source,
        stage: "queue",
        allow: false,
        reason
      }),
      queueDepth: Math.max(0, Number(queueDepth) || 0),
      source,
      attempts: Math.max(0, Number(head?.attempts) || 0),
      forceRespond: Boolean(head?.forceRespond),
      ageMs,
      ...metadata
    }
  });
}

export async function processReplyQueue(bot: QueueGatewayRuntime, channelId: string) {
  if (bot.replyQueueWorkers.has(channelId)) return;
  bot.replyQueueWorkers.add(channelId);

  try {
    while (!bot.isStopping) {
      const queue = bot.replyQueues.get(channelId);
      if (!queue?.length) break;

      const head = queue[0];
      const headMessage = head?.message;
      if (!headMessage?.id) {
        logReplyQueueGateRejected(bot, {
          channelId,
          queueDepth: queue.length,
          head,
          message: headMessage,
          reason: "invalid_queue_head"
        });
        dequeueReplyJob(bot, channelId);
        continue;
      }

      const settings = bot.store.getSettings();
      const permissions = getReplyPermissions(settings);
      const memory = getMemorySettings(settings);

      if (!permissions.allowReplies) {
        logReplyQueueGateRejected(bot, {
          channelId,
          queueDepth: queue.length,
          head,
          message: headMessage,
          reason: "replies_disabled"
        });
        dequeueReplyJob(bot, channelId);
        continue;
      }
      if (!headMessage.author || String(headMessage.author.id || "") === String(bot.client.user?.id || "")) {
        logReplyQueueGateRejected(bot, {
          channelId,
          queueDepth: queue.length,
          head,
          message: headMessage,
          reason: !headMessage.author ? "missing_author" : "self_message"
        });
        dequeueReplyJob(bot, channelId);
        continue;
      }
      if (!headMessage.guild || !headMessage.channel) {
        logReplyQueueGateRejected(bot, {
          channelId,
          queueDepth: queue.length,
          head,
          message: headMessage,
          reason: "message_context_missing"
        });
        dequeueReplyJob(bot, channelId);
        continue;
      }
      if (!bot.isChannelAllowed(settings, headMessage.channelId)) {
        logReplyQueueGateRejected(bot, {
          channelId,
          queueDepth: queue.length,
          head,
          message: headMessage,
          reason: "channel_blocked"
        });
        dequeueReplyJob(bot, channelId);
        continue;
      }
      if (bot.isUserBlocked(settings, headMessage.author.id)) {
        logReplyQueueGateRejected(bot, {
          channelId,
          queueDepth: queue.length,
          head,
          message: headMessage,
          reason: "user_blocked"
        });
        dequeueReplyJob(bot, channelId);
        continue;
      }
      if (bot.store.hasTriggeredResponse(headMessage.id)) {
        logReplyQueueGateRejected(bot, {
          channelId,
          queueDepth: queue.length,
          head,
          message: headMessage,
          reason: "duplicate_response_trigger"
        });
        dequeueReplyJob(bot, channelId);
        continue;
      }

      const coalesceAnchorMessage = queue[queue.length - 1]?.message || headMessage;
      const coalesceWaitMs = getReplyCoalesceWaitMs(settings, coalesceAnchorMessage);
      if (coalesceWaitMs > 0) {
        await sleep(Math.min(coalesceWaitMs, REPLY_QUEUE_RATE_LIMIT_WAIT_MS));
        continue;
      }
      if (queue.length <= 1) {
        const edgeGraceWaitMs = getReplyCoalesceWaitMs(settings, headMessage, {
          allowEdgeGrace: true
        });
        if (edgeGraceWaitMs > 0) {
          await sleep(Math.min(edgeGraceWaitMs, REPLY_QUEUE_RATE_LIMIT_WAIT_MS));
          continue;
        }
      }

      const waitMs = getReplyQueueWaitMs(bot, settings);
      if (waitMs > 0) {
        await sleep(Math.min(waitMs, REPLY_QUEUE_RATE_LIMIT_WAIT_MS));
        continue;
      }

      const burstJobs = dequeueReplyBurst(bot, channelId, settings);
      if (!burstJobs.length) continue;

      const latestJob = burstJobs[burstJobs.length - 1];
      const message = latestJob?.message;
      if (!message?.id) continue;

      const triggerMessageIds = [
        ...new Set(burstJobs.map((job) => String(job?.message?.id || "").trim()).filter(Boolean))
      ];

      const recentMessages = bot.store.getRecentMessages(
        message.channelId,
        memory.promptSlice.maxRecentMessages
      );
      const latestAddressSignal =
        latestJob.addressSignal || await bot.getReplyAddressSignal(settings, message, recentMessages);
      const addressSignal: ReplyQueueAddressSignal = {
        direct: Boolean(latestAddressSignal?.direct),
        inferred: Boolean(latestAddressSignal?.inferred),
        triggered: Boolean(latestAddressSignal?.triggered),
        reason: String(latestAddressSignal?.reason || "llm_decides"),
        confidence: Math.max(0, Math.min(1, Number(latestAddressSignal?.confidence) || 0)),
        threshold: Math.max(0.4, Math.min(0.95, Number(latestAddressSignal?.threshold) || 0.62)),
        confidenceSource: normalizeConfidenceSource(latestAddressSignal?.confidenceSource)
      };

      for (const burstJob of burstJobs) {
        const burstMessage = burstJob?.message;
        if (!burstMessage?.id) continue;
        const signal = burstJob.addressSignal || await bot.getReplyAddressSignal(settings, burstMessage, recentMessages);
        if (!signal) continue;
        if (signal.direct) addressSignal.direct = true;
        if (signal.inferred) addressSignal.inferred = true;
        if ((Number(signal.confidence) || 0) > addressSignal.confidence) {
          addressSignal.confidence = Math.max(0, Math.min(1, Number(signal.confidence) || 0));
          addressSignal.threshold = Math.max(0.4, Math.min(0.95, Number(signal.threshold) || addressSignal.threshold));
          addressSignal.confidenceSource = normalizeConfidenceSource(
            signal.confidenceSource || addressSignal.confidenceSource || "fallback"
          );
        }
        if (signal.triggered && !addressSignal.triggered) {
          addressSignal.triggered = true;
          addressSignal.reason = String(signal.reason || "direct");
        }
      }
      const forceRespond = burstJobs.some((job) => Boolean(job?.forceRespond));
      const source = burstJobs.length > 1
        ? `${latestJob.source || "message_event"}_coalesced`
        : latestJob.source || "message_event";
      const performanceSeed = latestJob?.performanceSeed || null;

      try {
        const sent = await bot.maybeReplyToMessage(message, settings, {
          forceRespond,
          source,
          addressSignal,
          recentMessages,
          triggerMessageIds,
          performanceSeed
        });

        if (!sent && forceRespond && !bot.isStopping && !bot.store.hasTriggeredResponse(message.id)) {
          const latestSettings = bot.store.getSettings();
          const latestPermissions = getReplyPermissions(latestSettings);
          if (
            latestPermissions.allowReplies &&
            bot.isChannelAllowed(latestSettings, message.channelId) &&
            !bot.isUserBlocked(latestSettings, message.author.id)
          ) {
            const retryWaitMs = getReplyQueueWaitMs(bot, latestSettings);
            if (retryWaitMs > 0) {
              requeueReplyJobs(bot, channelId, burstJobs);
              await sleep(Math.min(retryWaitMs, REPLY_QUEUE_RATE_LIMIT_WAIT_MS));
              continue;
            }
          }
        }
      } catch (error) {
        const maxAttempts = burstJobs.reduce(
          (max, job) => Math.max(max, Math.max(0, Number(job?.attempts) || 0)),
          0
        );
        if (maxAttempts < REPLY_QUEUE_SEND_MAX_RETRIES && !bot.isStopping) {
          const nextAttempt = maxAttempts + 1;
          for (const job of burstJobs) {
            job.attempts = Math.max(0, Number(job?.attempts) || 0) + 1;
          }
          requeueReplyJobs(bot, channelId, burstJobs);
          await sleep(REPLY_QUEUE_SEND_RETRY_BASE_MS * nextAttempt);
          continue;
        }

        bot.store.logAction({
          kind: "bot_error",
          guildId: message.guildId,
          channelId: message.channelId,
          messageId: message.id,
          userId: message.author?.id || null,
          content: `reply_queue_send_failed: ${String(error?.message || error)}`
        });
      }
    }
  } finally {
    bot.replyQueueWorkers.delete(channelId);
    if (!bot.isStopping && bot.replyQueues.get(channelId)?.length) {
      processReplyQueue(bot, channelId).catch((error) => {
        bot.store.logAction({
          kind: "bot_error",
          content: `reply_queue_restart: ${String(error?.message || error)}`
        });
      });
    }
  }
}

export async function ensureGatewayHealthy(bot: QueueGatewayRuntime) {
  if (bot.isStopping) return;
  if (bot.reconnectInFlight) return;
  if (!bot.hasConnectedAtLeastOnce) return;

  if (bot.client.isReady()) {
    bot.markGatewayEvent();
    return;
  }

  const elapsed = Date.now() - bot.lastGatewayEventAt;
  if (elapsed < GATEWAY_STALE_MS) return;

  await reconnectGateway(bot, `stale_gateway_${elapsed}ms`);
}

export function scheduleReconnect(bot: QueueGatewayRuntime, reason: string, delayMs: number) {
  if (bot.isStopping) return;
  if (bot.reconnectTimeout) return;

  bot.reconnectTimeout = setTimeout(() => {
    bot.reconnectTimeout = null;
    reconnectGateway(bot, reason).catch((error) => {
      bot.store.logAction({
        kind: "bot_error",
        userId: bot.client.user?.id,
        content: `gateway_reconnect_crash: ${String(error?.message || error)}`
      });
    });
  }, delayMs);
}

export async function reconnectGateway(bot: QueueGatewayRuntime, reason: string) {
  if (bot.isStopping) return;
  if (bot.reconnectInFlight) return;
  bot.reconnectInFlight = true;
  bot.markGatewayEvent();

  bot.store.logAction({
    kind: "bot_error",
    userId: bot.client.user?.id,
    content: `gateway_reconnect_start: ${reason}`
  });

  try {
    try {
      await bot.client.destroy();
    } catch {
      // ignore
    }
    await bot.client.login(bot.appConfig.discordToken);
    bot.markGatewayEvent();
    bot.reconnectAttempts = 0;
  } catch (error) {
    bot.reconnectAttempts += 1;
    const backoffDelay = Math.min(
      GATEWAY_RECONNECT_BASE_DELAY_MS * 2 ** Math.max(bot.reconnectAttempts - 1, 0),
      GATEWAY_RECONNECT_MAX_DELAY_MS
    );

    bot.store.logAction({
      kind: "bot_error",
      userId: bot.client.user?.id,
      content: `gateway_reconnect_failed: ${String(error?.message || error)}`,
      metadata: {
        attempt: bot.reconnectAttempts,
        nextRetryMs: backoffDelay
      }
    });

    scheduleReconnect(bot, "retry_after_reconnect_failure", backoffDelay);
  } finally {
    bot.reconnectInFlight = false;
  }
}
