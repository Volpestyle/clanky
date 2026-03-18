import { SettingsSection } from "../SettingsSection";
import { BROWSER_LLM_PROVIDER_OPTIONS, LlmProviderOptions } from "./LlmProviderOptions";
import {
  BROWSER_RUNTIME_SELECTION_OPTIONS,
  OPENAI_COMPUTER_USE_CLIENT_OPTIONS,
  getEffectiveBrowserRuntime
} from "../../settingsFormModel";

export function ResearchBrowsingSettingsSection({
  id,
  form,
  set,
  setBrowserLlmProvider,
  selectBrowserLlmPresetModel,
  browserLlmModelOptions,
  selectedBrowserLlmPresetModel
}) {
  const searchEnabled = Boolean(form.webSearchEnabled);
  const browserEnabled = Boolean(form.browserEnabled);
  const nativeSearchRuntime = form.stackResolvedResearchRuntime === "openai_native_web_search";
  const effectiveBrowserRuntime = getEffectiveBrowserRuntime(form);
  const nativeBrowserRuntime = effectiveBrowserRuntime === "openai_computer_use";
  const browserRuntimeSelection = String(form.browserRuntimeSelection || "inherit").trim().toLowerCase();
  const runtimeSummary =
    browserEnabled
      ? browserRuntimeSelection === "inherit"
        ? `${effectiveBrowserRuntime} (preset)`
        : `${effectiveBrowserRuntime} (override)`
      : "";

  return (
    <SettingsSection id={id} title="Research & Browsing" active={searchEnabled || browserEnabled}>
      <div className="rb-tools">
        <div className={`rb-tool${searchEnabled ? " rb-tool-on" : ""}`}>
          <span className="rb-tool-name">web_search</span>
          <span className="rb-tool-desc">Discovery and current facts. Searches the web and returns ranked results.</span>
        </div>
        <div className={`rb-tool${searchEnabled ? " rb-tool-on" : ""}`}>
          <span className="rb-tool-name">web_scrape</span>
          <span className="rb-tool-desc">Read a known URL. Extracts text from a page the model already has a link to.</span>
        </div>
        <div className={`rb-tool${browserEnabled ? " rb-tool-on" : ""}`}>
          <span className="rb-tool-name">browser_browse</span>
          <span className="rb-tool-desc">Full browser agent. JavaScript rendering, multi-step browsing, screenshots.</span>
        </div>
      </div>

      <div className="toggles">
        <label>
          <input type="checkbox" checked={searchEnabled} onChange={set("webSearchEnabled")} />
          Enable web search + page scraping
        </label>
        <label>
          <input type="checkbox" checked={browserEnabled} onChange={set("browserEnabled")} />
          Enable browser agent
        </label>
        {browserEnabled && (
          <>
            <label>
              <input type="checkbox" checked={form.browserHeaded} onChange={set("browserHeaded")} />
              Show browser window on this machine (debug)
            </label>
            <div style={{ marginTop: "0.5rem" }}>
              <label htmlFor="browser-profile">Browser profile path</label>
              <input
                id="browser-profile"
                type="text"
                value={form.browserProfile}
                onChange={set("browserProfile")}
                placeholder="~/.clanky/browser-profile"
                style={{ width: "100%" }}
              />
              <p className="status-msg info" style={{ marginTop: "0.25rem" }}>
                Persistent Chromium profile directory. Log in to sites once with headed mode, then all future sessions inherit cookies and auth state.
                Clear to use ephemeral sessions with no saved state.
              </p>
            </div>
          </>
        )}
      </div>

      {(searchEnabled || browserEnabled) && (
        <details className="vps-advanced-card">
          <summary className="vps-advanced-summary">
            <span className="vps-advanced-arrow">&#x25B8;</span>
            <span>Runtime &amp; rate limits</span>
            <span className="vps-advanced-summary-copy">
              {searchEnabled && String(form.stackResolvedResearchRuntime || "")}
              {searchEnabled && browserEnabled && " \u00B7 "}
              {browserEnabled && runtimeSummary}
            </span>
          </summary>
          <div className="vps-advanced-body">
            {searchEnabled && (
              <>
                <h4>Web Search</h4>
                <p className="status-msg info" style={{ marginTop: 0 }}>
                  Resolved runtime: {form.stackResolvedResearchRuntime}
                </p>
                <div className="split">
                  <div>
                    <label htmlFor="web-search-per-hour">Max searches/hour</label>
                    <input
                      id="web-search-per-hour"
                      type="number"
                      min="1"
                      max="120"
                      value={form.webSearchPerHour}
                      onChange={set("webSearchPerHour")}
                    />
                  </div>
                </div>

                {nativeSearchRuntime ? (
                  <>
                    <div className="split">
                      <div>
                        <label htmlFor="web-search-openai-location">Approximate user location</label>
                        <input
                          id="web-search-openai-location"
                          type="text"
                          value={form.webSearchOpenAiUserLocation}
                          onChange={set("webSearchOpenAiUserLocation")}
                          placeholder="San Francisco, CA, US"
                        />
                      </div>
                    </div>
                    <div>
                      <label htmlFor="web-search-openai-domains">Allowed domains (comma or newline list)</label>
                      <textarea
                        id="web-search-openai-domains"
                        value={form.webSearchOpenAiAllowedDomains}
                        onChange={set("webSearchOpenAiAllowedDomains")}
                        rows={3}
                        placeholder={"openai.com\nplatform.openai.com"}
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <div className="toggles">
                      <label>
                        <input
                          type="checkbox"
                          checked={form.webSearchSafeMode}
                          onChange={set("webSearchSafeMode")}
                        />
                        SafeSearch enabled
                      </label>
                    </div>
                    <div className="split">
                      <div>
                        <label htmlFor="web-search-results">Search results/query</label>
                        <input
                          id="web-search-results"
                          type="number"
                          min="1"
                          max="10"
                          value={form.webSearchMaxResults}
                          onChange={set("webSearchMaxResults")}
                        />
                      </div>
                      <div>
                        <label htmlFor="web-search-pages">Result pages to inspect</label>
                        <input
                          id="web-search-pages"
                          type="number"
                          min="0"
                          max="5"
                          value={form.webSearchMaxPages}
                          onChange={set("webSearchMaxPages")}
                        />
                      </div>
                    </div>
                    <div className="split">
                      <div>
                        <label htmlFor="web-search-chars">Max chars/page extract</label>
                        <input
                          id="web-search-chars"
                          type="number"
                          min="350"
                          max="24000"
                          value={form.webSearchMaxChars}
                          onChange={set("webSearchMaxChars")}
                        />
                      </div>
                      <div>
                        <label htmlFor="web-search-recency-days">Default recency days</label>
                        <input
                          id="web-search-recency-days"
                          type="number"
                          min="1"
                          max="365"
                          value={form.webSearchRecencyDaysDefault}
                          onChange={set("webSearchRecencyDaysDefault")}
                        />
                      </div>
                    </div>
                    <div className="split">
                      <div>
                        <label htmlFor="web-search-provider-order">Provider order (comma or newline list)</label>
                        <input
                          id="web-search-provider-order"
                          type="text"
                          value={form.webSearchProviderOrder}
                          onChange={set("webSearchProviderOrder")}
                          placeholder="brave,serpapi"
                        />
                      </div>
                      <div>
                        <label htmlFor="web-search-concurrent-fetches">Max concurrent fetches</label>
                        <input
                          id="web-search-concurrent-fetches"
                          type="number"
                          min="1"
                          max="10"
                          value={form.webSearchMaxConcurrentFetches}
                          onChange={set("webSearchMaxConcurrentFetches")}
                        />
                      </div>
                    </div>
                  </>
                )}
              </>
            )}

            {browserEnabled && (
              <div id="sec-browser">
                <h4>Browser Agent</h4>
                <p className="status-msg info" style={{ marginTop: 0 }}>
                  Runtime on save: {effectiveBrowserRuntime}
                </p>
                <div className="split">
                  <div>
                    <label htmlFor="browser-runtime-selection">Browser runtime</label>
                    <select
                      id="browser-runtime-selection"
                      value={form.browserRuntimeSelection}
                      onChange={set("browserRuntimeSelection")}
                    >
                      {BROWSER_RUNTIME_SELECTION_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                          {option === "inherit"
                            ? "Use preset default"
                            : option === "openai_computer_use"
                              ? "OpenAI computer use"
                              : "Local browser agent"}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {!nativeBrowserRuntime && (
                  <div className="split">
                    <div>
                      <label htmlFor="browser-llm-provider">Provider</label>
                      <select
                        id="browser-llm-provider"
                        value={form.browserLlmProvider}
                        onChange={setBrowserLlmProvider}
                      >
                        <LlmProviderOptions options={BROWSER_LLM_PROVIDER_OPTIONS} />
                      </select>
                    </div>
                    <div>
                      <label htmlFor="browser-llm-model-preset">Model ID</label>
                      <select
                        id="browser-llm-model-preset"
                        value={selectedBrowserLlmPresetModel}
                        onChange={selectBrowserLlmPresetModel}
                      >
                        {browserLlmModelOptions.map((modelId) => (
                          <option key={modelId} value={modelId}>
                            {modelId}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}

                {nativeBrowserRuntime && (
                  <>
                    <div className="split">
                      <div>
                        <label htmlFor="browser-openai-computer-use-client">Client auth</label>
                        <select
                          id="browser-openai-computer-use-client"
                          value={form.browserOpenAiComputerUseClient}
                          onChange={set("browserOpenAiComputerUseClient")}
                        >
                          {OPENAI_COMPUTER_USE_CLIENT_OPTIONS.map((option) => (
                            <option key={option} value={option}>
                              {option === "auto"
                                ? "Auto (prefer OpenAI API)"
                                : option === "openai-oauth"
                                  ? "OpenAI OAuth"
                                  : "OpenAI API key"}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div className="split">
                      <div>
                        <label htmlFor="browser-openai-computer-use-model">OpenAI computer use model</label>
                        <input
                          id="browser-openai-computer-use-model"
                          type="text"
                          value={form.browserOpenAiComputerUseModel}
                          onChange={set("browserOpenAiComputerUseModel")}
                          placeholder="gpt-5.4"
                        />
                      </div>
                    </div>
                    <div>
                      <p className="status-msg info">
                        OpenAI computer use keeps the browser tool available even when the main orchestrator uses Claude or another provider.
                      </p>
                    </div>
                  </>
                )}

                <div className="split">
                  <div>
                    <label htmlFor="browser-max-per-hour">Max browse calls/hour</label>
                    <input
                      id="browser-max-per-hour"
                      type="number"
                      min="1"
                      max="60"
                      value={form.browserMaxPerHour}
                      onChange={set("browserMaxPerHour")}
                    />
                  </div>
                  <div>
                    <label htmlFor="browser-max-steps">Max steps/task</label>
                    <input
                      id="browser-max-steps"
                      type="number"
                      min="1"
                      max="30"
                      value={form.browserMaxSteps}
                      onChange={set("browserMaxSteps")}
                    />
                  </div>
                </div>
                <div className="split">
                  <div>
                    <label htmlFor="browser-step-timeout">Step timeout (ms)</label>
                    <input
                      id="browser-step-timeout"
                      type="number"
                      min="5000"
                      max="120000"
                      step="1000"
                      value={form.browserStepTimeoutMs}
                      onChange={set("browserStepTimeoutMs")}
                    />
                  </div>
                  <div>
                    <label htmlFor="browser-session-timeout">Session timeout (ms)</label>
                    <input
                      id="browser-session-timeout"
                      type="number"
                      min="30000"
                      max="600000"
                      step="1000"
                      value={form.browserSessionTimeoutMs}
                      onChange={set("browserSessionTimeoutMs")}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        </details>
      )}
    </SettingsSection>
  );
}
