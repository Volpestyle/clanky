import React from "react";
import { SettingsSection } from "../SettingsSection";

export function CodeAgentSettingsSection({ id, form, set }) {
  const provider = String(form.codeAgentProvider || "claude-code").trim().toLowerCase();
  const showClaudeModel = provider === "claude-code" || provider === "auto";
  const showCodexModel = provider === "codex" || provider === "auto";

  return (
    <SettingsSection id={id} title="Code Agent" active={form.codeAgentEnabled}>
      <div className="toggles">
        <label>
          <input
            type="checkbox"
            checked={form.codeAgentEnabled}
            onChange={set("codeAgentEnabled")}
          />
          Enable code agent
        </label>
      </div>

      {form.codeAgentEnabled && (
        <>
          <div className="field">
            <label htmlFor="code-agent-allowed-users">Allowed user IDs (one per line)</label>
            <textarea
              id="code-agent-allowed-users"
              rows={3}
              value={form.codeAgentAllowedUserIds}
              onChange={set("codeAgentAllowedUserIds")}
              placeholder="Discord user IDs that can trigger code_task"
            />
          </div>

          <div className="split">
            <div>
              <label htmlFor="code-agent-provider">Provider</label>
              <select
                id="code-agent-provider"
                value={form.codeAgentProvider}
                onChange={set("codeAgentProvider")}
              >
                <option value="claude-code">Claude Code (local)</option>
                <option value="codex">Codex (OpenAI)</option>
                <option value="auto">Auto (currently Claude Code)</option>
              </select>
            </div>
            <div>
              <label htmlFor="code-agent-max-parallel">Max parallel tasks</label>
              <input
                id="code-agent-max-parallel"
                type="number"
                min="1"
                max="10"
                value={form.codeAgentMaxParallelTasks}
                onChange={set("codeAgentMaxParallelTasks")}
              />
            </div>
          </div>

          {showClaudeModel && (
            <div className="field">
              <label htmlFor="code-agent-model">Claude model</label>
              <input
                id="code-agent-model"
                type="text"
                value={form.codeAgentModel}
                onChange={set("codeAgentModel")}
                placeholder="sonnet"
              />
            </div>
          )}

          {showCodexModel && (
            <div className="field">
              <label htmlFor="code-agent-codex-model">Codex model</label>
              <input
                id="code-agent-codex-model"
                type="text"
                value={form.codeAgentCodexModel}
                onChange={set("codeAgentCodexModel")}
                placeholder="codex-mini-latest"
              />
            </div>
          )}

          <div className="split">
            <div>
              <label htmlFor="code-agent-max-per-hour">Max tasks/hour</label>
              <input
                id="code-agent-max-per-hour"
                type="number"
                min="1"
                max="100"
                value={form.codeAgentMaxTasksPerHour}
                onChange={set("codeAgentMaxTasksPerHour")}
              />
            </div>
            <div>
              <label htmlFor="code-agent-max-turns">Max turns/task</label>
              <input
                id="code-agent-max-turns"
                type="number"
                min="1"
                max="200"
                value={form.codeAgentMaxTurns}
                onChange={set("codeAgentMaxTurns")}
              />
            </div>
          </div>

          <div className="split">
            <div>
              <label htmlFor="code-agent-timeout">Timeout (ms)</label>
              <input
                id="code-agent-timeout"
                type="number"
                min="10000"
                max="1800000"
                step="10000"
                value={form.codeAgentTimeoutMs}
                onChange={set("codeAgentTimeoutMs")}
              />
            </div>
            <div>
              <label htmlFor="code-agent-max-buffer">Max buffer (bytes)</label>
              <input
                id="code-agent-max-buffer"
                type="number"
                min="4096"
                max="10485760"
                step="1024"
                value={form.codeAgentMaxBufferBytes}
                onChange={set("codeAgentMaxBufferBytes")}
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="code-agent-default-cwd">Default working directory</label>
            <input
              id="code-agent-default-cwd"
              type="text"
              value={form.codeAgentDefaultCwd}
              onChange={set("codeAgentDefaultCwd")}
              placeholder="Leave empty for ../web (one level up)"
            />
          </div>
        </>
      )}
    </SettingsSection>
  );
}
