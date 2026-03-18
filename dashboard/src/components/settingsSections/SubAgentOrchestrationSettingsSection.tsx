import { SettingsSection } from "../SettingsSection";

export function SubAgentOrchestrationSettingsSection({ id, form, set }) {
  return (
    <SettingsSection id={id} title="Sub-Agent Orchestration">
      <p className="hint">
        Configure how the brain orchestrates interactive multi-turn sub-agent sessions.
      </p>

      <div className="split">
        <div>
          <label htmlFor="subagent-idle-timeout">Session idle timeout (ms)</label>
          <input
            id="subagent-idle-timeout"
            type="number"
            min="10000"
            max="1800000"
            step="10000"
            value={form.subAgentSessionIdleTimeoutMs}
            onChange={set("subAgentSessionIdleTimeoutMs")}
          />
        </div>
        <div>
          <label htmlFor="subagent-max-sessions">Max concurrent sessions</label>
          <input
            id="subagent-max-sessions"
            type="number"
            min="1"
            max="50"
            value={form.subAgentMaxConcurrentSessions}
            onChange={set("subAgentMaxConcurrentSessions")}
          />
        </div>
      </div>
    </SettingsSection>
  );
}
