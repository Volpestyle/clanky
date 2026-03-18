import type { FlightLog } from "./types";

// LocalStorage key used by the in-browser flight recorder cache.
const FLIGHT_LOG_STORAGE_KEY = "clanky_flight_logs";
// Keep only the most recent flight logs to cap storage growth.
const MAX_FLIGHT_LOGS = 3;
// Last-resort retention when localStorage quota is exhausted.
const FALLBACK_LOG_COUNT_WHEN_STORAGE_FULL = 1;

export function loadFlightLogs(): FlightLog[] {
  try {
    const raw = localStorage.getItem(FLIGHT_LOG_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as FlightLog[];
    return Array.isArray(parsed) ? parsed.slice(0, MAX_FLIGHT_LOGS) : [];
  } catch {
    return [];
  }
}

export function saveFlightLog(log: FlightLog) {
  const existing = loadFlightLogs();
  // Deduplicate by sessionId
  const filtered = existing.filter((l) => l.sessionId !== log.sessionId);
  const updated = [log, ...filtered].slice(0, MAX_FLIGHT_LOGS);
  try {
    localStorage.setItem(FLIGHT_LOG_STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // localStorage full — drop oldest
    try {
      localStorage.setItem(
        FLIGHT_LOG_STORAGE_KEY,
        JSON.stringify(updated.slice(0, FALLBACK_LOG_COUNT_WHEN_STORAGE_FULL))
      );
    } catch {
      // give up
    }
  }
}
