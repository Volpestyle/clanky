import React from "react";
import { SettingsSection } from "../SettingsSection";
import { UserIdTagInput } from "../UserIdTagInput";
import { SETTINGS_NUMERIC_CONSTRAINTS } from "../../../../src/settings/settingsConstraints.ts";

function WorkerAuthBadge({ worker, form }: { worker: string; form: Record<string, unknown> }) {
  const authed =
    worker === "claude_code" ? form.providerAuthClaudeCode :
    worker === "codex_cli" ? form.providerAuthCodexCli :
    worker === "codex" ? form.providerAuthCodex :
    false;
  if (authed) return null;
  return (
    <span className="status-msg error" style={{ fontSize: "0.7rem", marginLeft: 6, display: "inline" }}>
      NO AUTH
    </span>
  );
}

export function CodeAgentSettingsSection({ id, form, set, validationError = "" }) {
  const provider = String(form.codeAgentProvider || "auto").trim().toLowerCase();
  const showClaudeModel = provider === "claude-code" || provider === "auto";
  const showCodexModel = provider === "codex" || provider === "auto";
  const showCodexCliModel = provider === "codex-cli" || provider === "auto";

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
          <UserIdTagInput
            id="code-agent-allowed-users"
            label="Allowed user IDs"
            hint="Discord user IDs that can trigger code_task."
            value={form.codeAgentAllowedUserIds}
            onChange={set("codeAgentAllowedUserIds")}
          />
          {validationError && (
            <p className="status-msg error" role="status">
              {validationError}
            </p>
          )}

          <div className="split">
            <div>
              <label htmlFor="code-agent-provider">Provider</label>
              <select
                id="code-agent-provider"
                value={form.codeAgentProvider}
                onChange={set("codeAgentProvider")}
              >
                <option value="auto">Auto (preset/default)</option>
                <option value="claude-code">Claude Code (local)</option>
                <option value="codex-cli">Codex CLI (local)</option>
                <option value="codex">Codex API (remote)</option>
              </select>
            </div>
            <div>
              <label htmlFor="code-agent-max-parallel">Max parallel tasks</label>
              <input
                id="code-agent-max-parallel"
                type="number"
                min={SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.maxParallelTasks.min}
                max={SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.maxParallelTasks.max}
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
                placeholder="gpt-5.4"
              />
            </div>
          )}

          {showCodexCliModel && (
            <div className="field">
              <label htmlFor="code-agent-codex-cli-model">Codex CLI model</label>
              <input
                id="code-agent-codex-cli-model"
                type="text"
                value={form.codeAgentCodexCliModel}
                onChange={set("codeAgentCodexCliModel")}
                placeholder="gpt-5.4"
              />
            </div>
          )}

          <div className="split">
            <div>
              <label htmlFor="code-agent-max-per-hour">Max tasks/hour</label>
              <input
                id="code-agent-max-per-hour"
                type="number"
                min={SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.maxTasksPerHour.min}
                max={SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.maxTasksPerHour.max}
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
              placeholder="Leave empty for this repo root"
            />
            <p className="status-msg" role="status">
              Local workers treat this as a git repo path and spin up a disposable worktree branch instead of editing the live checkout.
            </p>
          </div>

          <h4 className="text-xs text-muted-foreground tracking-wider mt-4 mb-2">ASYNC DISPATCH</h4>
          <div className="toggles">
            <label>
              <input
                type="checkbox"
                checked={Boolean(form.codeAgentAsyncDispatchEnabled)}
                onChange={set("codeAgentAsyncDispatchEnabled")}
              />
              Enable async code task dispatch
            </label>
          </div>
          {Boolean(form.codeAgentAsyncDispatchEnabled) && (
            <>
              <div className="field">
                <label htmlFor="code-agent-async-threshold">Async threshold (ms)</label>
                <input
                  id="code-agent-async-threshold"
                  type="number"
                  min={SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.asyncDispatchThresholdMs.min}
                  max={SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.asyncDispatchThresholdMs.max}
                  step="1000"
                  value={form.codeAgentAsyncDispatchThresholdMs}
                  onChange={set("codeAgentAsyncDispatchThresholdMs")}
                />
                <p className="status-msg" role="status">
                  Set to <code>0</code> to always dispatch in background.
                </p>
              </div>
              <div className="toggles">
                <label>
                  <input
                    type="checkbox"
                    checked={Boolean(form.codeAgentAsyncProgressReportsEnabled)}
                    onChange={set("codeAgentAsyncProgressReportsEnabled")}
                  />
                  Enable periodic progress reports
                </label>
              </div>
              {Boolean(form.codeAgentAsyncProgressReportsEnabled) && (
                <div className="split">
                  <div>
                    <label htmlFor="code-agent-async-progress-interval">Progress interval (ms)</label>
                    <input
                      id="code-agent-async-progress-interval"
                      type="number"
                      min={SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.asyncDispatchProgressIntervalMs.min}
                      max={SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.asyncDispatchProgressIntervalMs.max}
                      step="1000"
                      value={form.codeAgentAsyncProgressIntervalMs}
                      onChange={set("codeAgentAsyncProgressIntervalMs")}
                    />
                  </div>
                  <div>
                    <label htmlFor="code-agent-async-max-reports">Max reports per task</label>
                    <input
                      id="code-agent-async-max-reports"
                      type="number"
                      min={SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.asyncDispatchMaxReportsPerTask.min}
                      max={SETTINGS_NUMERIC_CONSTRAINTS.agentStack.devTeam.asyncDispatchMaxReportsPerTask.max}
                      step="1"
                      value={form.codeAgentAsyncMaxReportsPerTask}
                      onChange={set("codeAgentAsyncMaxReportsPerTask")}
                    />
                  </div>
                </div>
              )}
            </>
          )}

          <h4 className="text-xs text-muted-foreground tracking-wider mt-4 mb-2">DEV TEAM ROLES</h4>
          <div className="split">
            <div>
              <label htmlFor="code-agent-role-design">
                Design
                <WorkerAuthBadge worker={String(form.codeAgentRoleDesign)} form={form} />
              </label>
              <select
                id="code-agent-role-design"
                value={form.codeAgentRoleDesign}
                onChange={set("codeAgentRoleDesign")}
              >
                <option value="claude_code">Claude Code</option>
                <option value="codex_cli">Codex CLI</option>
                <option value="codex">Codex API</option>
              </select>
            </div>
            <div>
              <label htmlFor="code-agent-role-implementation">
                Implementation
                <WorkerAuthBadge worker={String(form.codeAgentRoleImplementation)} form={form} />
              </label>
              <select
                id="code-agent-role-implementation"
                value={form.codeAgentRoleImplementation}
                onChange={set("codeAgentRoleImplementation")}
              >
                <option value="claude_code">Claude Code</option>
                <option value="codex_cli">Codex CLI</option>
                <option value="codex">Codex API</option>
              </select>
            </div>
          </div>
          <div className="split">
            <div>
              <label htmlFor="code-agent-role-review">
                Review
                <WorkerAuthBadge worker={String(form.codeAgentRoleReview)} form={form} />
              </label>
              <select
                id="code-agent-role-review"
                value={form.codeAgentRoleReview}
                onChange={set("codeAgentRoleReview")}
              >
                <option value="claude_code">Claude Code</option>
                <option value="codex_cli">Codex CLI</option>
                <option value="codex">Codex API</option>
              </select>
            </div>
            <div>
              <label htmlFor="code-agent-role-research">
                Research
                <WorkerAuthBadge worker={String(form.codeAgentRoleResearch)} form={form} />
              </label>
              <select
                id="code-agent-role-research"
                value={form.codeAgentRoleResearch}
                onChange={set("codeAgentRoleResearch")}
              >
                <option value="claude_code">Claude Code</option>
                <option value="codex_cli">Codex CLI</option>
                <option value="codex">Codex API</option>
              </select>
            </div>
          </div>
        </>
      )}
    </SettingsSection>
  );
}
