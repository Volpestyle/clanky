import type { SessionLatency } from "../../hooks/useVoiceSSE";
import type { Anomaly, ClassifiedEvent } from "./types";

export function detectAnomalies(
  classified: ClassifiedEvent[],
  latency: SessionLatency
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  let idCounter = 0;

  // 1. Empty ASR after promotion
  for (let i = 0; i < classified.length - 1; i++) {
    const cur = classified[i];
    const next = classified[i + 1];
    if (
      cur.event.kind === "voice_activity_started" &&
      next.event.kind.startsWith("voice_turn_dropped") &&
      next.ts - cur.ts < 5000
    ) {
      anomalies.push({
        id: String(idCounter++),
        type: "warn",
        label: "Empty ASR",
        description: "Voice activity started but turn dropped with no transcript",
        at: cur.event.createdAt,
        eventIndex: i,
      });
    }
  }

  // 2. Output lock stuck (long gap between bot_audio_started events)
  const audioStarts = classified.filter(
    (e) => e.event.kind === "bot_audio_started"
  );
  for (let i = 1; i < audioStarts.length; i++) {
    const gap = audioStarts[i].ts - audioStarts[i - 1].ts;
    if (gap > 30_000) {
      anomalies.push({
        id: String(idCounter++),
        type: "danger",
        label: "Output Gap",
        description: `${Math.round(gap / 1000)}s gap between audio outputs`,
        at: audioStarts[i].event.createdAt,
        eventIndex: null,
      });
    }
  }

  // 3. High latency turns
  if (latency) {
    const avg = latency.averages.totalMs;
    for (const turn of latency.recentTurns) {
      if (
        turn.totalMs !== null &&
        avg !== null &&
        avg > 0 &&
        turn.totalMs > avg * 2
      ) {
        anomalies.push({
          id: String(idCounter++),
          type: "danger",
          label: "High Latency",
          description: `Turn took ${turn.totalMs}ms (avg ${Math.round(avg)}ms)`,
          at: turn.at,
          eventIndex: null,
        });
      }
    }
  }

  return anomalies;
}
