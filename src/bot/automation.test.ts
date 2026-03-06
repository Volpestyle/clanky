import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  formatAutomationSchedule,
  normalizeAutomationInstruction,
  normalizeAutomationSchedule,
  normalizeAutomationTitle,
  resolveFollowingNextRunAt,
  resolveInitialNextRunAt
} from "./automation.ts";

test("normalizeAutomationTitle and normalizeAutomationInstruction sanitize input", () => {
  const title = normalizeAutomationTitle("   giraffe   drop   ");
  const instruction = normalizeAutomationInstruction("  post   a  giraffe pic   every time ");

  assert.equal(title, "giraffe drop");
  assert.equal(instruction, "post a giraffe pic every time");
});

test("normalizeAutomationSchedule accepts daily schedule", () => {
  const schedule = normalizeAutomationSchedule({
    kind: "daily",
    hour: 13,
    minute: 5
  });

  assert.equal(schedule?.kind, "daily");
  assert.equal(schedule?.hour, 13);
  assert.equal(schedule?.minute, 5);
});

test("normalizeAutomationSchedule rejects stale once schedules", () => {
  const schedule = normalizeAutomationSchedule({
    kind: "once",
    atIso: "2001-01-01T00:00:00.000Z"
  });

  assert.equal(schedule, null);
});

test("resolveInitialNextRunAt computes future interval run", () => {
  const nowMs = Date.parse("2026-02-26T12:00:00.000Z");
  const schedule = normalizeAutomationSchedule({
    kind: "interval",
    everyMinutes: 30
  });

  const nextRunAt = resolveInitialNextRunAt({
    schedule,
    nowMs
  });

  assert.equal(nextRunAt, "2026-02-26T12:30:00.000Z");
});

test("resolveFollowingNextRunAt advances interval without drift", () => {
  const schedule = normalizeAutomationSchedule({
    kind: "interval",
    everyMinutes: 15
  });
  const nextRunAt = resolveFollowingNextRunAt({
    schedule,
    previousNextRunAt: "2026-02-26T12:15:00.000Z",
    runFinishedMs: Date.parse("2026-02-26T12:16:30.000Z")
  });

  assert.equal(nextRunAt, "2026-02-26T12:30:00.000Z");
});

test("formatAutomationSchedule returns readable interval label", () => {
  const label = formatAutomationSchedule({
    kind: "interval",
    everyMinutes: 120
  });

  assert.equal(label, "every 2 hours");
});
