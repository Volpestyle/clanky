import React from "react";
import { SettingsSection } from "../SettingsSection";

export function SubAgentOrchestrationSettingsSection({ id, form, set }) {
  return (
    <SettingsSection id={id} title="Sub-Agent Orchestration">
      <p className="hint">
        Configure how the brain orchestrates interactive multi-turn sub-agent sessions.
        Set different orchestration models per agent type (e.g. a more powerful model for code tasks).
        Leave model fields empty to use the default brain model.
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

      <h4>Code Agent Orchestration</h4>
      <div className="split">
        <div>
          <label htmlFor="subagent-code-orch-model">Orchestration model override</label>
          <input
            id="subagent-code-orch-model"
            type="text"
            value={form.subAgentCodeOrchestrationModel}
            onChange={set("subAgentCodeOrchestrationModel")}
            placeholder="Empty = use default brain model"
          />
        </div>
        <div>
          <label htmlFor="subagent-code-max-turns">Max session turns</label>
          <input
            id="subagent-code-max-turns"
            type="number"
            min="1"
            max="50"
            value={form.subAgentCodeMaxSessionTurns}
            onChange={set("subAgentCodeMaxSessionTurns")}
          />
        </div>
      </div>

      <h4>Browser Agent Orchestration</h4>
      <div className="split">
        <div>
          <label htmlFor="subagent-browser-orch-model">Orchestration model override</label>
          <input
            id="subagent-browser-orch-model"
            type="text"
            value={form.subAgentBrowserOrchestrationModel}
            onChange={set("subAgentBrowserOrchestrationModel")}
            placeholder="Empty = use default brain model"
          />
        </div>
        <div>
          <label htmlFor="subagent-browser-max-turns">Max session turns</label>
          <input
            id="subagent-browser-max-turns"
            type="number"
            min="1"
            max="50"
            value={form.subAgentBrowserMaxSessionTurns}
            onChange={set("subAgentBrowserMaxSessionTurns")}
          />
        </div>
      </div>
    </SettingsSection>
  );
}
