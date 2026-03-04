import { clamp } from "../utils.ts";

const DISCOVERY_TICK_MS = 60_000;

export function getDiscoveryPostingIntervalMs(settings) {
  const minByGap = settings.discovery.minMinutesBetweenPosts * 60_000;
  const perDay = Math.max(settings.discovery.maxPostsPerDay, 1);
  const evenPacing = Math.floor((24 * 60 * 60 * 1000) / perDay);
  return Math.max(minByGap, evenPacing);
}

export function getDiscoveryAverageIntervalMs(settings) {
  const perDay = Math.max(settings.discovery.maxPostsPerDay, 1);
  return Math.floor((24 * 60 * 60 * 1000) / perDay);
}

export function getDiscoveryPacingMode(settings) {
  return String(settings.discovery?.pacingMode || "even").toLowerCase() === "spontaneous"
    ? "spontaneous"
    : "even";
}

export function getDiscoveryMinGapMs(settings) {
  return Math.max(1, Number(settings.discovery?.minMinutesBetweenPosts || 0) * 60_000);
}

export function evaluateSpontaneousDiscoverySchedule({ settings, lastPostTs, elapsedMs, posts24h, minGapMs }) {
  const mode = "spontaneous";
  const spontaneity01 = clamp(Number(settings.discovery?.spontaneity) || 0, 0, 100) / 100;
  const maxPostsPerDay = Math.max(Number(settings.discovery?.maxPostsPerDay) || 1, 1);
  const averageIntervalMs = getDiscoveryAverageIntervalMs(settings);

  if (!lastPostTs || !Number.isFinite(elapsedMs)) {
    const chanceNow = 0.05 + spontaneity01 * 0.12;
    const roll = Math.random();
    return {
      shouldPost: roll < chanceNow,
      mode,
      trigger: roll < chanceNow ? "spontaneous_seed_post" : "spontaneous_seed_wait",
      chance: Number(chanceNow.toFixed(4)),
      roll: Number(roll.toFixed(4)),
      elapsedMs: null,
      requiredIntervalMs: averageIntervalMs
    };
  }

  const rampWindowMs = Math.max(averageIntervalMs - minGapMs, DISCOVERY_TICK_MS);
  const progress = clamp((elapsedMs - minGapMs) / rampWindowMs, 0, 1);
  const baseChance = 0.015 + spontaneity01 * 0.03;
  const peakChance = 0.1 + spontaneity01 * 0.28;
  const capPressure = clamp(posts24h / maxPostsPerDay, 0, 1);
  const capModifier = 1 - capPressure * 0.6;
  const chanceNow = clamp((baseChance + (peakChance - baseChance) * progress) * capModifier, 0.005, 0.6);
  const forceAfterMs = Math.max(minGapMs, Math.round(averageIntervalMs * (1.6 - spontaneity01 * 0.55)));

  if (elapsedMs >= forceAfterMs) {
    return {
      shouldPost: true,
      mode,
      trigger: "spontaneous_force_due",
      chance: Number(chanceNow.toFixed(4)),
      roll: null,
      elapsedMs,
      requiredIntervalMs: forceAfterMs
    };
  }

  const roll = Math.random();
  const shouldPost = roll < chanceNow;
  return {
    shouldPost,
    mode,
    trigger: shouldPost ? "spontaneous_roll_due" : "spontaneous_roll_wait",
    chance: Number(chanceNow.toFixed(4)),
    roll: Number(roll.toFixed(4)),
    elapsedMs,
    requiredIntervalMs: forceAfterMs
  };
}

export function evaluateDiscoverySchedule({ settings, startup, lastPostTs, elapsedMs, posts24h }) {
  const mode = getDiscoveryPacingMode(settings);
  const minGapMs = getDiscoveryMinGapMs(settings);

  if (startup && !settings.discovery.postOnStartup) {
    return {
      shouldPost: false,
      mode,
      trigger: "startup_disabled"
    };
  }

  if (!startup && lastPostTs && Number.isFinite(elapsedMs) && elapsedMs < minGapMs) {
    return {
      shouldPost: false,
      mode,
      trigger: "min_gap_block",
      elapsedMs,
      requiredIntervalMs: minGapMs
    };
  }

  if (startup && !lastPostTs) {
    return {
      shouldPost: true,
      mode,
      trigger: "startup_bootstrap"
    };
  }

  if (mode === "even") {
    const requiredIntervalMs = getDiscoveryPostingIntervalMs(settings);
    const due = !lastPostTs || !Number.isFinite(elapsedMs) || elapsedMs >= requiredIntervalMs;
    return {
      shouldPost: due,
      mode,
      trigger: due ? "even_due" : "even_wait",
      elapsedMs,
      requiredIntervalMs
    };
  }

  if (startup && lastPostTs && Number.isFinite(elapsedMs) && elapsedMs < minGapMs) {
    return {
      shouldPost: false,
      mode,
      trigger: "startup_min_gap_block",
      elapsedMs,
      requiredIntervalMs: minGapMs
    };
  }

  return evaluateSpontaneousDiscoverySchedule({
    settings,
    lastPostTs,
    elapsedMs,
    posts24h,
    minGapMs
  });
}

export function pickDiscoveryChannel({ settings, client, isChannelAllowed }) {
  const ids = settings.discovery.channelIds
    .map((id) => String(id).trim())
    .filter(Boolean);
  if (!ids.length) return null;

  const shuffled = ids
    .map((id) => ({ id, sortKey: Math.random() }))
    .sort((a, b) => a.sortKey - b.sortKey)
    .map((item) => item.id);

  for (const id of shuffled) {
    const channel = client.channels.cache.get(id);
    if (!channel || !channel.isTextBased?.() || typeof channel.send !== "function") continue;
    if (!isChannelAllowed(settings, channel.id)) continue;
    return channel;
  }

  return null;
}
