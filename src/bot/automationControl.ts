import {
  formatAutomationSchedule,
  resolveInitialNextRunAt
} from "./automation.ts";
import { normalizeSkipSentinel } from "./botHelpers.ts";
import { sanitizeBotText } from "../utils.ts";

const MAX_AUTOMATIONS_PER_GUILD = 90;
const MAX_AUTOMATION_LIST_ROWS = 10;

function queueAutomationCycle(runtime, {
  guildId = null,
  channelId = null,
  userId = null,
  trigger,
  automationId = null
}: {
  guildId?: string | null;
  channelId?: string | null;
  userId?: string | null;
  trigger: string;
  automationId?: number | null;
}) {
  runtime.maybeRunAutomationCycle().catch((error) => {
    runtime.store.logAction({
      kind: "bot_error",
      guildId,
      channelId,
      userId,
      content: `automation_cycle_trigger_${trigger}: ${String(error?.message || error)}`.slice(0, 2000),
      metadata: {
        trigger,
        automationId
      }
    });
  });
}

export function composeAutomationControlReply({ modelText, detailLines = [] }) {
  const cleanedModel = sanitizeBotText(normalizeSkipSentinel(modelText || ""), 500);
  const body = cleanedModel && cleanedModel !== "[SKIP]" ? cleanedModel : "";
  if (!body || body === "[SKIP]") return "";

  const extra = (Array.isArray(detailLines) ? detailLines : [])
    .map((line) => String(line || "").trim())
    .filter(Boolean)
    .slice(0, 8);
  if (!extra.length) return body;

  return sanitizeBotText(`${body}\n${extra.join("\n")}`, 1700);
}

export async function applyAutomationControlAction(runtime, { message, settings, automationAction }) {
  const operation = String(automationAction?.operation || "")
    .trim()
    .toLowerCase();
  const guildId = String(message.guildId || "").trim();
  if (!guildId) {
    return {
      handled: true,
      detailLines: [],
      metadata: {
        operation,
        ok: false,
        reason: "missing_guild_scope"
      }
    };
  }

  if (operation === "list") {
    const rows = runtime.store.listAutomations({
      guildId,
      statuses: ["active", "paused"],
      limit: MAX_AUTOMATION_LIST_ROWS
    });
    if (!rows.length) {
      return {
        handled: true,
        detailLines: [],
        metadata: {
          operation,
          ok: true,
          count: 0
        }
      };
    }

    const detailLines = rows.map((row) => formatAutomationListLine(row));
    return {
      handled: true,
      detailLines,
      metadata: {
        operation,
        ok: true,
        count: rows.length,
        automationIds: rows.map((row) => row.id)
      }
    };
  }

  if (operation === "create") {
    const instruction = String(automationAction?.instruction || "").trim();
    const schedule = automationAction?.schedule || null;
    if (!instruction || !schedule) {
      return {
        handled: true,
        detailLines: [],
        metadata: {
          operation,
          ok: false,
          reason: "missing_schedule_or_instruction"
        }
      };
    }

    const currentCount = runtime.store.countAutomations({
      guildId,
      statuses: ["active", "paused"]
    });
    if (currentCount >= MAX_AUTOMATIONS_PER_GUILD) {
      return {
        handled: true,
        detailLines: [],
        metadata: {
          operation,
          ok: false,
          reason: "automation_cap_reached",
          currentCount
        }
      };
    }

    const requestedChannelId = String(automationAction?.targetChannelId || "").trim();
    const targetChannelId = requestedChannelId || message.channelId;
    if (!runtime.isChannelAllowed(settings, targetChannelId)) {
      return {
        handled: true,
        detailLines: [],
        metadata: {
          operation,
          ok: false,
          reason: "target_channel_blocked",
          targetChannelId
        }
      };
    }

    const channel = runtime.client.channels.cache.get(String(targetChannelId));
    if (!channel || !channel.isTextBased?.() || typeof channel.send !== "function") {
      return {
        handled: true,
        detailLines: [],
        metadata: {
          operation,
          ok: false,
          reason: "target_channel_unavailable",
          targetChannelId
        }
      };
    }

    const nextRunAt = resolveInitialNextRunAt({
      schedule,
      nowMs: Date.now(),
      runImmediately: Boolean(automationAction?.runImmediately)
    });
    if (!nextRunAt) {
      return {
        handled: true,
        detailLines: [],
        metadata: {
          operation,
          ok: false,
          reason: "schedule_invalid"
        }
      };
    }

    const title = String(automationAction?.title || "").trim() || String(instruction).slice(0, 80);
    const created = runtime.store.createAutomation({
      guildId,
      channelId: String(channel.id),
      createdByUserId: message.author?.id || "unknown",
      createdByName: message.member?.displayName || message.author?.username || "unknown",
      title,
      instruction,
      schedule,
      nextRunAt
    });

    if (!created) {
      return {
        handled: true,
        detailLines: [],
        metadata: {
          operation,
          ok: false,
          reason: "create_failed"
        }
      };
    }

    runtime.store.logAction({
      kind: "automation_created",
      guildId,
      channelId: created.channel_id,
      userId: message.author?.id || null,
      content: `${created.title}: ${created.instruction}`.slice(0, 400),
      metadata: {
        automationId: created.id,
        schedule: created.schedule,
        nextRunAt: created.next_run_at
      }
    });

    queueAutomationCycle(runtime, {
      guildId,
      channelId: created.channel_id,
      userId: message.author?.id || null,
      trigger: "create",
      automationId: created.id
    });

    return {
      handled: true,
      detailLines: [formatAutomationListLine(created)],
      metadata: {
        operation,
        ok: true,
        automationId: created.id,
        runImmediately: Boolean(automationAction?.runImmediately)
      }
    };
  }

  if (operation === "pause" || operation === "resume" || operation === "delete") {
    const targetRows = resolveAutomationTargetsForControl(runtime, {
      guildId,
      channelId: message.channelId,
      operation,
      automationId: automationAction?.automationId,
      targetQuery: automationAction?.targetQuery
    });
    if (!targetRows.length) {
      return {
        handled: true,
        detailLines: [],
        metadata: {
          operation,
          ok: false,
          reason: "no_matching_automation",
          targetQuery: automationAction?.targetQuery || null,
          automationId: automationAction?.automationId || null
        }
      };
    }

    const nowMs = Date.now();
    const updatedRows = [];
    for (const row of targetRows) {
      if (operation === "pause") {
        const paused = runtime.store.setAutomationStatus({
          automationId: row.id,
          guildId,
          status: "paused",
          nextRunAt: null
        });
        if (paused) updatedRows.push(paused);
        continue;
      }

      if (operation === "resume") {
        const nextRunAt = resolveInitialNextRunAt({
          schedule: row.schedule,
          nowMs,
          runImmediately: false
        });
        if (!nextRunAt) continue;
        const resumed = runtime.store.setAutomationStatus({
          automationId: row.id,
          guildId,
          status: "active",
          nextRunAt
        });
        if (resumed) updatedRows.push(resumed);
        continue;
      }

      const deleted = runtime.store.setAutomationStatus({
        automationId: row.id,
        guildId,
        status: "deleted",
        nextRunAt: null
      });
      if (deleted) updatedRows.push(deleted);
    }

    if (!updatedRows.length) {
      return {
        handled: true,
        detailLines: [],
        metadata: {
          operation,
          ok: false,
          reason: "status_update_failed",
          targetCount: targetRows.length
        }
      };
    }

    runtime.store.logAction({
      kind: "automation_updated",
      guildId,
      channelId: message.channelId,
      userId: message.author?.id || null,
      content: `${operation}: ${updatedRows.map((row) => `#${row.id}`).join(", ")}`.slice(0, 400),
      metadata: {
        operation,
        updatedIds: updatedRows.map((row) => row.id),
        targetQuery: automationAction?.targetQuery || null
      }
    });

    if (operation === "resume") {
      queueAutomationCycle(runtime, {
        guildId,
        channelId: message.channelId,
        userId: message.author?.id || null,
        trigger: "resume",
        automationId: updatedRows[0]?.id || null
      });
    }

    return {
      handled: true,
      detailLines: updatedRows.map((row) => formatAutomationListLine(row)),
      metadata: {
        operation,
        ok: true,
        updatedIds: updatedRows.map((row) => row.id)
      }
    };
  }

  return false;
}

export function resolveAutomationTargetsForControl(
  runtime,
  { guildId, channelId, operation, automationId = null, targetQuery = "" }
) {
  const statuses = operation === "pause" ? ["active"] : operation === "resume" ? ["paused"] : ["active", "paused"];
  const normalizedQuery = String(targetQuery || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

  if (Number.isInteger(Number(automationId)) && Number(automationId) > 0) {
    const row = runtime.store.getAutomationById(Number(automationId), guildId);
    if (!row || !statuses.includes(row.status)) return [];
    return [row];
  }

  if (normalizedQuery) {
    const inChannel = runtime.store.findAutomationsByQuery({
      guildId,
      channelId,
      query: normalizedQuery,
      statuses,
      limit: 8
    });
    if (inChannel.length) return inChannel;

    return runtime.store.findAutomationsByQuery({
      guildId,
      query: normalizedQuery,
      statuses,
      limit: 8
    });
  }

  const fallback = runtime.store.getMostRecentAutomations({
    guildId,
    channelId,
    statuses,
    limit: 1
  });
  if (fallback.length) return fallback;

  return runtime.store.getMostRecentAutomations({
    guildId,
    statuses,
    limit: 1
  });
}

export function formatAutomationListLine(row) {
  const channelLabel = row?.channel_id ? `<#${row.channel_id}>` : "(unknown channel)";
  const scheduleLabel = formatAutomationSchedule(row?.schedule);
  const nextRunLabel = row?.next_run_at ? new Date(row.next_run_at).toLocaleString() : "paused";
  const title = String(row?.title || "scheduled task").slice(0, 80);
  const status = String(row?.status || "active");
  return `- #${row?.id} [${status}] ${title} | ${scheduleLabel} | next: ${nextRunLabel} | ${channelLabel}`;
}
