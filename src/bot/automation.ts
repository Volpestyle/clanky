import { clamp } from "../utils.ts";

const AUTOMATION_SCHEDULE_KINDS = new Set(["daily", "interval", "once"]);

const MAX_AUTOMATION_TITLE_LEN = 90;
const MAX_AUTOMATION_INSTRUCTION_LEN = 360;

export function normalizeAutomationTitle(rawTitle, fallback = "scheduled task") {
  const text = String(rawTitle || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_AUTOMATION_TITLE_LEN);
  if (text) return text;
  return String(fallback || "scheduled task")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_AUTOMATION_TITLE_LEN);
}

export function normalizeAutomationInstruction(rawInstruction) {
  const text = String(rawInstruction || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_AUTOMATION_INSTRUCTION_LEN);
  return text || "";
}

export function buildAutomationMatchText({ title = "", instruction = "" }) {
  return `${String(title || "").trim()} ${String(instruction || "").trim()}`
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}

export function normalizeAutomationSchedule(raw, { nowMs = Date.now(), allowPastOnce = false } = {}) {
  if (!raw || typeof raw !== "object") return null;

  const kind = String(raw.kind || "")
    .trim()
    .toLowerCase();
  if (!AUTOMATION_SCHEDULE_KINDS.has(kind)) return null;

  if (kind === "daily") {
    const hour = clamp(Math.floor(Number(raw.hour)), 0, 23);
    const minute = clamp(Math.floor(Number(raw.minute ?? 0)), 0, 59);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return { kind, hour, minute };
  }

  if (kind === "interval") {
    const everyMinutes = clamp(Math.floor(Number(raw.everyMinutes)), 1, 7 * 24 * 60);
    if (!Number.isFinite(everyMinutes) || everyMinutes < 1) return null;
    return { kind, everyMinutes };
  }

  const parsedAt = Date.parse(String(raw.atIso || "").trim());
  if (!Number.isFinite(parsedAt)) return null;
  if (!allowPastOnce && parsedAt < nowMs - 15_000) return null;
  return { kind: "once", atIso: new Date(parsedAt).toISOString() };
}

export function resolveInitialNextRunAt({ schedule, nowMs = Date.now(), runImmediately = false }) {
  if (!schedule || typeof schedule !== "object") return null;
  if (runImmediately) return new Date(nowMs).toISOString();

  if (schedule.kind === "daily") {
    const nextMs = resolveNextDailyRunMs(schedule, nowMs);
    return Number.isFinite(nextMs) ? new Date(nextMs).toISOString() : null;
  }

  if (schedule.kind === "interval") {
    const everyMs = Number(schedule.everyMinutes) * 60_000;
    if (!Number.isFinite(everyMs) || everyMs < 60_000) return null;
    return new Date(nowMs + everyMs).toISOString();
  }

  if (schedule.kind === "once") {
    const atMs = Date.parse(String(schedule.atIso || ""));
    if (!Number.isFinite(atMs)) return null;
    return new Date(atMs).toISOString();
  }

  return null;
}

export function resolveFollowingNextRunAt({ schedule, previousNextRunAt = null, runFinishedMs = Date.now() }) {
  if (!schedule || typeof schedule !== "object") return null;

  if (schedule.kind === "once") return null;

  if (schedule.kind === "daily") {
    const nextMs = resolveNextDailyRunMs(schedule, runFinishedMs + 1000);
    return Number.isFinite(nextMs) ? new Date(nextMs).toISOString() : null;
  }

  if (schedule.kind === "interval") {
    const everyMs = Number(schedule.everyMinutes) * 60_000;
    if (!Number.isFinite(everyMs) || everyMs < 60_000) return null;

    const baseMs = Number.isFinite(Date.parse(String(previousNextRunAt || "")))
      ? Date.parse(String(previousNextRunAt || ""))
      : runFinishedMs;

    let nextMs = baseMs + everyMs;
    if (!Number.isFinite(nextMs)) return null;
    if (nextMs <= runFinishedMs) {
      const behindMs = runFinishedMs - nextMs;
      const steps = Math.floor(behindMs / everyMs) + 1;
      nextMs += everyMs * steps;
    }
    return new Date(nextMs).toISOString();
  }

  return null;
}

export function formatAutomationSchedule(schedule) {
  if (!schedule || typeof schedule !== "object") return "unknown schedule";

  if (schedule.kind === "daily") {
    const hour = clamp(Math.floor(Number(schedule.hour)), 0, 23);
    const minute = clamp(Math.floor(Number(schedule.minute)), 0, 59);
    return `daily at ${formatHourMinute(hour, minute)}`;
  }

  if (schedule.kind === "interval") {
    const everyMinutes = clamp(Math.floor(Number(schedule.everyMinutes)), 1, 7 * 24 * 60);
    if (everyMinutes % 60 === 0) {
      const hours = everyMinutes / 60;
      return hours === 1 ? "every 1 hour" : `every ${hours} hours`;
    }
    return everyMinutes === 1 ? "every 1 minute" : `every ${everyMinutes} minutes`;
  }

  if (schedule.kind === "once") {
    const atMs = Date.parse(String(schedule.atIso || ""));
    if (!Number.isFinite(atMs)) return "once";
    return `once at ${new Date(atMs).toLocaleString()}`;
  }

  return "unknown schedule";
}

export function getLocalTimeZoneLabel() {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return String(zone || "local time");
}

function resolveNextDailyRunMs(schedule, referenceMs) {
  const hour = clamp(Math.floor(Number(schedule.hour)), 0, 23);
  const minute = clamp(Math.floor(Number(schedule.minute)), 0, 59);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return NaN;

  const reference = new Date(referenceMs);
  const next = new Date(referenceMs);
  next.setSeconds(0, 0);
  next.setHours(hour, minute, 0, 0);

  if (next.getTime() <= reference.getTime()) {
    next.setDate(next.getDate() + 1);
  }

  return next.getTime();
}

function formatHourMinute(hour, minute) {
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  });
}
