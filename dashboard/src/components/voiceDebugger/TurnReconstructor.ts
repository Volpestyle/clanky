import type { VoiceEvent } from "../../hooks/useVoiceSSE";
import type { ClassifiedEvent, ReconstructedTurn, TurnStage } from "./types";

// Reconstruction window for grouping related runtime events into one turn.
const TURN_WINDOW_MS = 12_000;

function metaStr(evt: VoiceEvent, key: string): string {
  const meta = evt.metadata as Record<string, unknown> | undefined;
  const val = meta?.[key];
  return val !== undefined && val !== null ? String(val) : "";
}

function metaNum(evt: VoiceEvent, key: string): number | null {
  const meta = evt.metadata as Record<string, unknown> | undefined;
  const val = meta?.[key];
  return typeof val === "number" ? val : null;
}

function metaObj(evt: VoiceEvent): Record<string, unknown> {
  const meta = evt.metadata;
  return meta && typeof meta === "object" && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)
    : {};
}

function evtContent(ce: ClassifiedEvent): string {
  return typeof ce.event.content === "string" ? ce.event.content : ce.event.kind;
}

export function reconstructTurns(classified: ClassifiedEvent[]): ReconstructedTurn[] {
  const turns: ReconstructedTurn[] = [];

  // Find turn-start anchors: voice_activity_started or voice_turn_in kind
  const anchors: number[] = [];
  for (let i = 0; i < classified.length; i++) {
    const c = evtContent(classified[i]);
    if (
      c === "voice_activity_started" ||
      classified[i].event.kind === "voice_turn_in"
    ) {
      anchors.push(i);
    }
  }

  for (let ai = 0; ai < anchors.length; ai++) {
    const anchorIdx = anchors[ai];
    const anchor = classified[anchorIdx];
    const nextAnchorTs =
      ai + 1 < anchors.length
        ? classified[anchors[ai + 1]].ts
        : anchor.ts + TURN_WINDOW_MS;
    const windowEnd = Math.min(anchor.ts + TURN_WINDOW_MS, nextAnchorTs);

    // Gather all events in this turn's window
    const turnEvents: ClassifiedEvent[] = [];
    for (let j = anchorIdx; j < classified.length; j++) {
      if (classified[j].ts > windowEnd) break;
      turnEvents.push(classified[j]);
    }

    const speaker =
      metaStr(anchor.event, "speakerName") ||
      metaStr(anchor.event, "displayName") ||
      metaStr(anchor.event, "userId") ||
      "unknown";

    // -- Build stages --
    const stages: TurnStage[] = [];

    // 1. CAPTURE
    const promotionReason = metaStr(anchor.event, "promotionReason");
    const captureBytes = metaNum(anchor.event, "promotionBytes");
    const capturePeak = metaNum(anchor.event, "promotionPeak");
    const captureActive = metaNum(anchor.event, "promotionActiveSampleRatio");
    const captureDetail = [
      promotionReason ? `Via: ${promotionReason}` : null,
      captureBytes !== null ? `${captureBytes} bytes` : null,
      capturePeak !== null ? `Peak: ${capturePeak.toFixed(3)}` : null,
      captureActive !== null ? `Active: ${(captureActive * 100).toFixed(0)}%` : null,
    ]
      .filter(Boolean)
      .join("  ");

    stages.push({
      id: "capture",
      label: "Capture promoted",
      status: "passed",
      detail: captureDetail || "Audio captured",
      meta: metaObj(anchor.event),
      event: anchor,
    });

    // 2. ASR — look for final transcript or drop
    const asrFinal = turnEvents.find(
      (e) => evtContent(e) === "openai_realtime_asr_final_segment"
    );
    const turnDropped = turnEvents.find((e) =>
      evtContent(e).startsWith("voice_turn_dropped")
    );
    const turnSkipped = turnEvents.find((e) =>
      evtContent(e).startsWith("voice_turn_skipped")
    );

    let transcript = "";
    if (asrFinal) {
      transcript = metaStr(asrFinal.event, "transcript");
      const conf = metaNum(asrFinal.event, "confidence");
      stages.push({
        id: "asr",
        label: "ASR transcribed",
        status: "passed",
        detail: transcript
          ? `"${transcript.slice(0, 80)}${transcript.length > 80 ? "..." : ""}"${conf !== null ? `  Conf: ${conf.toFixed(2)}` : ""}`
          : "Transcription received",
        meta: metaObj(asrFinal.event),
        event: asrFinal,
      });
    } else if (turnDropped || turnSkipped) {
      const dropEvt = turnDropped ?? turnSkipped!;
      const dropReason =
        metaStr(dropEvt.event, "reason") || evtContent(dropEvt).replace("voice_turn_dropped_", "").replace("voice_turn_skipped_", "");
      stages.push({
        id: "asr",
        label: "ASR / Capture",
        status: "failed",
        detail: `Dropped: ${dropReason}`,
        meta: metaObj(dropEvt.event),
        event: dropEvt,
      });
      // Early exit — no further stages
      stages.push(
        { id: "decision", label: "Admission", status: "skipped", detail: "", meta: {}, event: null },
        { id: "generation", label: "Generation", status: "skipped", detail: "", meta: {}, event: null },
        { id: "output", label: "Output", status: "skipped", detail: "", meta: {}, event: null }
      );
      turns.push({
        id: turns.length,
        startTs: anchor.ts,
        endTs: (turnDropped ?? turnSkipped ?? anchor).ts,
        speaker,
        transcript: "",
        outcome: "dropped",
        outcomeReason: dropReason,
        stages,
        events: turnEvents,
      });
      continue;
    } else {
      stages.push({
        id: "asr",
        label: "ASR",
        status: "pending",
        detail: "No transcript event found in window",
        meta: {},
        event: null,
      });
    }

    // 3. ADDRESSING / ADMISSION
    const addressing = turnEvents.find(
      (e) => evtContent(e) === "voice_turn_addressing"
    );
    const decisionEvt = turnEvents.find(
      (e) =>
        evtContent(e) === "voice_runtime_event_decision" ||
        evtContent(e) === "voice_reply_classifier_debug"
    );
    const bargeInGate = turnEvents.find(
      (e) => evtContent(e) === "voice_barge_in_gate"
    );

    if (addressing || decisionEvt) {
      const evt = decisionEvt ?? addressing!;
      const allow = (metaObj(evt.event).allow as boolean | undefined) ?? null;
      const reason = metaStr(evt.event, "reason");
      const addrTarget = metaStr(evt.event, "talkingTo");
      const addrConf = metaNum(evt.event, "confidence") ?? metaNum(evt.event, "directedConfidence");

      if (allow === false) {
        stages.push({
          id: "decision",
          label: "Admission DENIED",
          status: "failed",
          detail: [
            reason ? `Reason: ${reason}` : null,
            addrTarget ? `Target: ${addrTarget}` : null,
            addrConf !== null ? `Confidence: ${addrConf.toFixed(2)}` : null,
          ]
            .filter(Boolean)
            .join("  "),
          meta: metaObj(evt.event),
          event: evt,
        });
        stages.push(
          { id: "generation", label: "Generation", status: "skipped", detail: "", meta: {}, event: null },
          { id: "output", label: "Output", status: "skipped", detail: "", meta: {}, event: null }
        );
        turns.push({
          id: turns.length,
          startTs: anchor.ts,
          endTs: evt.ts,
          speaker,
          transcript,
          outcome: "denied",
          outcomeReason: reason || "admission denied",
          stages,
          events: turnEvents,
        });
        continue;
      }

      stages.push({
        id: "decision",
        label: "Admission ALLOWED",
        status: "passed",
        detail: [
          reason ? `Reason: ${reason}` : null,
          addrTarget ? `Directed to: ${addrTarget}` : null,
          addrConf !== null ? `Confidence: ${addrConf.toFixed(2)}` : null,
        ]
          .filter(Boolean)
          .join("  "),
        meta: metaObj(evt.event),
        event: evt,
      });
    } else if (bargeInGate) {
      const allow = (metaObj(bargeInGate.event).allow as boolean | undefined) ?? null;
      const reason = metaStr(bargeInGate.event, "reason");
      stages.push({
        id: "decision",
        label: allow ? "Barge-in ALLOWED" : "Barge-in DENIED",
        status: allow ? "passed" : "failed",
        detail: reason ? `Reason: ${reason}` : "",
        meta: metaObj(bargeInGate.event),
        event: bargeInGate,
      });
      if (!allow) {
        stages.push(
          { id: "generation", label: "Generation", status: "skipped", detail: "", meta: {}, event: null },
          { id: "output", label: "Output", status: "skipped", detail: "", meta: {}, event: null }
        );
        turns.push({
          id: turns.length,
          startTs: anchor.ts,
          endTs: bargeInGate.ts,
          speaker,
          transcript,
          outcome: "denied",
          outcomeReason: reason || "barge-in denied",
          stages,
          events: turnEvents,
        });
        continue;
      }
    } else {
      stages.push({
        id: "decision",
        label: "Admission",
        status: "pending",
        detail: "No admission event in window",
        meta: {},
        event: null,
      });
    }

    // 4. GENERATION
    const genPrep = turnEvents.find(
      (e) => evtContent(e) === "voice_generation_prep_stage"
    );
    const genTimeout = turnEvents.find(
      (e) => evtContent(e) === "voice_generation_watchdog_timeout"
    );
    const thoughtDecision = turnEvents.find(
      (e) => evtContent(e) === "voice_thought_decision"
    );
    const instructionsUpdated = turnEvents.find(
      (e) => evtContent(e).includes("instructions_updated")
    );

    if (genTimeout) {
      stages.push({
        id: "generation",
        label: "Generation TIMEOUT",
        status: "failed",
        detail: `Watchdog fired after ${metaNum(genTimeout.event, "timeoutMs") ?? "?"}ms`,
        meta: metaObj(genTimeout.event),
        event: genTimeout,
      });
    } else if (genPrep || instructionsUpdated || thoughtDecision) {
      const evt = genPrep ?? instructionsUpdated ?? thoughtDecision!;
      stages.push({
        id: "generation",
        label: "Generation",
        status: "passed",
        detail: genPrep
          ? `Stage: ${metaStr(genPrep.event, "stage")} (${metaStr(genPrep.event, "state")})`
          : thoughtDecision
            ? `Thought: ${metaStr(thoughtDecision.event, "action")}`
            : "Instructions updated",
        meta: metaObj(evt.event),
        event: evt,
      });
    } else {
      stages.push({
        id: "generation",
        label: "Generation",
        status: "pending",
        detail: "No generation event in window",
        meta: {},
        event: null,
      });
    }

    // 5. OUTPUT
    const audioStarted = turnEvents.find(
      (e) =>
        evtContent(e) === "bot_audio_started" ||
        e.event.kind === "voice_turn_out"
    );
    const silentFallback = turnEvents.find(
      (e) =>
        evtContent(e) === "response_silent_fallback" ||
        evtContent(e) === "response_silent_hard_recovery"
    );
    const bargeIn = turnEvents.find(
      (e) => evtContent(e) === "voice_barge_in_suppression_cleared"
    );

    if (audioStarted) {
      stages.push({
        id: "output",
        label: "Audio playing",
        status: "passed",
        detail: bargeIn ? "Played (interrupted by barge-in)" : "Audio sent to channel",
        meta: metaObj(audioStarted.event),
        event: audioStarted,
      });
    } else if (silentFallback) {
      stages.push({
        id: "output",
        label: "Output SILENT",
        status: "failed",
        detail: `Silent: ${evtContent(silentFallback)}`,
        meta: metaObj(silentFallback.event),
        event: silentFallback,
      });
    } else {
      stages.push({
        id: "output",
        label: "Output",
        status: "pending",
        detail: "No output event in window",
        meta: {},
        event: null,
      });
    }

    // Determine outcome
    const lastFailed = [...stages].reverse().find((s) => s.status === "failed");
    const hasPending = stages.some((s) => s.status === "pending");

    let outcome: ReconstructedTurn["outcome"] = "responded";
    let outcomeReason = "";
    if (lastFailed) {
      outcome = bargeIn ? "interrupted" : "denied";
      outcomeReason = lastFailed.detail;
    } else if (hasPending) {
      outcome = "pending";
      outcomeReason = "Turn still in progress or events missing";
    } else {
      outcomeReason = "Full pipeline completed";
    }

    turns.push({
      id: turns.length,
      startTs: anchor.ts,
      endTs: turnEvents[turnEvents.length - 1].ts,
      speaker,
      transcript,
      outcome,
      outcomeReason,
      stages,
      events: turnEvents,
    });
  }

  return turns;
}
