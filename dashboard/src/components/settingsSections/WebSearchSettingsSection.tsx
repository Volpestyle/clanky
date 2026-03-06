import React from "react";
import { SettingsSection } from "../SettingsSection";

export function WebSearchSettingsSection({ id, form, set }) {
  const nativeRuntime = form.stackResolvedResearchRuntime === "openai_native_web_search";
  return (
    <SettingsSection id={id} title="Web Search Runtime" active={form.webSearchEnabled}>
      <div className="toggles">
        <label>
          <input
            type="checkbox"
            checked={form.webSearchEnabled}
            onChange={set("webSearchEnabled")}
          />
          Enable live web search for replies
        </label>
      </div>

      {form.webSearchEnabled && (
        <>
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

          {nativeRuntime ? (
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
                  placeholder="openai.com&#10;platform.openai.com"
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
    </SettingsSection>
  );
}
