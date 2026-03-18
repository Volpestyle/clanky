import type { SessionLatency, VoiceEvent } from "../../hooks/useVoiceSSE";

export type LaneId =
  | "capture"
  | "asr"
  | "decision"
  | "generate"
  | "output"
  | "bargein"
  | "music"
  | "thought";

export type LaneConfig = {
  id: LaneId;
  label: string;
  color: string;
  patterns: RegExp[];
};

export type ClassifiedEvent = {
  event: VoiceEvent;
  lane: LaneId;
  ts: number;
};

export type Anomaly = {
  id: string;
  type: "warn" | "danger" | "info";
  label: string;
  description: string;
  at: string;
  eventIndex: number | null;
};

export type FlightLog = {
  id: string;
  sessionId: string;
  mode: string;
  startedAt: string;
  endedAt: string;
  eventCount: number;
  participantCount: number;
  durationLabel: string;
  events: VoiceEvent[];
  latency: SessionLatency;
};

export type TurnStageStatus = "passed" | "failed" | "skipped" | "pending";

export type TurnStage = {
  id: string;
  label: string;
  status: TurnStageStatus;
  detail: string;
  meta: Record<string, unknown>;
  event: ClassifiedEvent | null;
};

export type ReconstructedTurn = {
  id: number;
  startTs: number;
  endTs: number;
  speaker: string;
  transcript: string;
  outcome: "responded" | "denied" | "dropped" | "interrupted" | "pending";
  outcomeReason: string;
  stages: TurnStage[];
  events: ClassifiedEvent[];
};
