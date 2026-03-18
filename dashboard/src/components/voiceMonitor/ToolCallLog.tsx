import { useEffect, useState } from "react";
import type { VoiceSession } from "../../hooks/useVoiceSSE";
import { Section } from "../ui";
import { relativeTime, snippet } from "./shared";

export function ToolCallLog({ session }: { session: VoiceSession }) {
  const calls = session.toolCalls;
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 2000);
    return () => clearInterval(id);
  }, []);

  if (!calls || calls.length === 0) return null;

  return (
    <Section title="Tool Calls" badge={calls.length} defaultOpen={false}>
      <div className="vm-toolcall-list">
        {calls
          .slice()
          .reverse()
          .map((call) => {
            const argsPreview = (() => {
              try {
                const raw = JSON.stringify(call.arguments);
                return raw.length > 80 ? raw.slice(0, 80) + "..." : raw;
              } catch {
                return "{}";
              }
            })();

            return (
              <div key={call.callId} className={`vm-toolcall-row ${call.success ? "" : "vm-toolcall-fail"}`}>
                <div className="vm-toolcall-header">
                  <span className={`vm-toolcall-dot ${call.success ? "vm-toolcall-ok" : "vm-toolcall-err"}`} />
                  <span className="vm-toolcall-name">{call.toolName}</span>
                  <span className={`vm-tool-chip ${call.toolType === "mcp" ? "vm-tool-mcp" : "vm-tool-fn"}`}>
                    {call.toolType}
                  </span>
                  {call.runtimeMs != null && (
                    <span className={`vm-toolcall-runtime ${call.runtimeMs > 3000 ? "vm-toolcall-slow" : ""}`}>
                      {call.runtimeMs}ms
                    </span>
                  )}
                  {call.startedAt && <span className="vm-toolcall-time">{relativeTime(call.startedAt)}</span>}
                </div>
                <div className="vm-toolcall-args">{argsPreview}</div>
                {call.error && <div className="vm-toolcall-error">{call.error}</div>}
                {call.outputSummary && !call.error && (
                  <div className="vm-toolcall-output">{snippet(call.outputSummary, 120)}</div>
                )}
              </div>
            );
          })}
      </div>
    </Section>
  );
}
