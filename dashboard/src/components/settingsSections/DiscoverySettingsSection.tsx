import React from "react";
import { SettingsSection } from "../SettingsSection";
import { Collapse } from "../Collapse";
import { rangeStyle } from "../../utils";

export function DiscoverySettingsSection({
  id,
  form,
  set,
  showDiscoveryAdvanced,
  showDiscoveryImageControls,
  showDiscoveryVideoControls,
  discoveryImageModelOptions,
  discoveryVideoModelOptions
}) {
  return (
    <SettingsSection id={id} title="Discovery Posts & Media" active={form.discoveryEnabled}>
      <div className="toggles">
        <label>
          <input
            type="checkbox"
            checked={form.discoveryEnabled}
            onChange={set("discoveryEnabled")}
          />
          Enable discovery posting
        </label>
        {showDiscoveryAdvanced && (
          <label>
            <input
              type="checkbox"
              checked={form.discoveryStartupPost}
              onChange={set("discoveryStartupPost")}
            />
            Post on startup when due
          </label>
        )}
        {showDiscoveryAdvanced && (
          <label>
            <input
              type="checkbox"
              checked={form.discoveryImageEnabled}
              onChange={set("discoveryImageEnabled")}
            />
            Allow discovery image posts
          </label>
        )}
        {showDiscoveryAdvanced && (
          <label>
            <input
              type="checkbox"
              checked={form.discoveryVideoEnabled}
              onChange={set("discoveryVideoEnabled")}
            />
            Allow discovery video posts
          </label>
        )}
        <label>
          <input
            type="checkbox"
            checked={form.replyImageEnabled}
            onChange={set("replyImageEnabled")}
          />
          Allow images in replies
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.replyVideoEnabled}
            onChange={set("replyVideoEnabled")}
          />
          Allow videos in replies
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.replyGifEnabled}
            onChange={set("replyGifEnabled")}
          />
          Allow GIFs in replies
        </label>
      </div>

      <Collapse open={showDiscoveryAdvanced}>
        <div className="split">
          <div>
            <label htmlFor="discovery-posts-per-day">Max discovery posts/day</label>
            <input
              id="discovery-posts-per-day"
              type="number"
              min="0"
              max="100"
              value={form.discoveryPostsPerDay}
              onChange={set("discoveryPostsPerDay")}
            />
          </div>
          <div>
            <label htmlFor="discovery-min-minutes">Min minutes between discovery posts</label>
            <input
              id="discovery-min-minutes"
              type="number"
              min="5"
              max="1440"
              value={form.discoveryMinMinutes}
              onChange={set("discoveryMinMinutes")}
            />
          </div>
        </div>

        <div className="split">
          <div>
            <label htmlFor="discovery-pacing-mode">Discovery pacing mode</label>
            <select
              id="discovery-pacing-mode"
              value={form.discoveryPacingMode}
              onChange={set("discoveryPacingMode")}
            >
              <option value="even">Even pacing (strict)</option>
              <option value="spontaneous">Spontaneous (randomized)</option>
            </select>
          </div>
          <div>
            <label htmlFor="discovery-spontaneity">
              Spontaneity: <strong>{form.discoverySpontaneity}%</strong>
            </label>
            <input
              id="discovery-spontaneity"
              type="range"
              min="0"
              max="100"
              step="1"
              value={form.discoverySpontaneity}
              onChange={set("discoverySpontaneity")}
              style={rangeStyle(form.discoverySpontaneity)}
            />
          </div>
        </div>
      </Collapse>

      <Collapse open={showDiscoveryImageControls}>
        <div className="split">
          <div>
            <label htmlFor="max-images-per-day">Max generated images/24h</label>
            <input
              id="max-images-per-day"
              type="number"
              min="0"
              max="200"
              value={form.maxImagesPerDay}
              onChange={set("maxImagesPerDay")}
            />
          </div>
          <div>
            <label htmlFor="discovery-simple-image-model">Simple image model</label>
            <select
              id="discovery-simple-image-model"
              value={form.discoverySimpleImageModel}
              onChange={set("discoverySimpleImageModel")}
            >
              {discoveryImageModelOptions.map((modelId) => (
                <option key={modelId} value={modelId}>
                  {modelId}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="split">
          <div>
            <label htmlFor="discovery-complex-image-model">Complex image model</label>
            <select
              id="discovery-complex-image-model"
              value={form.discoveryComplexImageModel}
              onChange={set("discoveryComplexImageModel")}
            >
              {discoveryImageModelOptions.map((modelId) => (
                <option key={modelId} value={modelId}>
                  {modelId}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="discovery-allowed-image-models">Allowed image models (comma/newline list)</label>
            <textarea
              id="discovery-allowed-image-models"
              rows={3}
              value={form.discoveryAllowedImageModels}
              onChange={set("discoveryAllowedImageModels")}
            />
          </div>
        </div>
      </Collapse>

      <Collapse open={showDiscoveryVideoControls}>
        <div className="split">
          <div>
            <label htmlFor="max-videos-per-day">Max generated videos/24h</label>
            <input
              id="max-videos-per-day"
              type="number"
              min="0"
              max="120"
              value={form.maxVideosPerDay}
              onChange={set("maxVideosPerDay")}
            />
          </div>
          <div>
            <label htmlFor="discovery-video-model">Video model</label>
            <select
              id="discovery-video-model"
              value={form.discoveryVideoModel}
              onChange={set("discoveryVideoModel")}
            >
              {discoveryVideoModelOptions.map((modelId) => (
                <option key={modelId} value={modelId}>
                  {modelId}
                </option>
              ))}
            </select>
          </div>
        </div>

        <label htmlFor="discovery-allowed-video-models">Allowed video models (comma/newline list)</label>
        <textarea
          id="discovery-allowed-video-models"
          rows={3}
          value={form.discoveryAllowedVideoModels}
          onChange={set("discoveryAllowedVideoModels")}
        />
      </Collapse>

      {form.replyGifEnabled && (
        <div className="split">
          <div>
            <label htmlFor="max-gifs-per-day">Max GIF lookups/24h</label>
            <input
              id="max-gifs-per-day"
              type="number"
              min="0"
              max="300"
              value={form.maxGifsPerDay}
              onChange={set("maxGifsPerDay")}
            />
          </div>
          <div />
        </div>
      )}

      <Collapse open={showDiscoveryAdvanced}>
        <h4>External Discovery</h4>
        <div className="toggles">
          <label>
            <input
              type="checkbox"
              checked={form.discoveryExternalEnabled}
              onChange={set("discoveryExternalEnabled")}
            />
            Enable external discovery inputs
          </label>
          {form.discoveryExternalEnabled && (
            <label>
              <input
                type="checkbox"
                checked={form.discoveryAllowNsfw}
                onChange={set("discoveryAllowNsfw")}
              />
              Allow NSFW discovery items
            </label>
          )}
        </div>

        {form.discoveryExternalEnabled && (
          <>
            <div className="split">
              <div>
                <label htmlFor="discovery-link-chance">Posts with links (%)</label>
                <input
                  id="discovery-link-chance"
                  type="number"
                  min="0"
                  max="100"
                  value={form.discoveryLinkChance}
                  onChange={set("discoveryLinkChance")}
                />
              </div>
              <div>
                <label htmlFor="discovery-max-links">Max links per post</label>
                <input
                  id="discovery-max-links"
                  type="number"
                  min="1"
                  max="4"
                  value={form.discoveryMaxLinks}
                  onChange={set("discoveryMaxLinks")}
                />
              </div>
            </div>

            <div className="split">
              <div>
                <label htmlFor="discovery-max-candidates">Candidates for prompt</label>
                <input
                  id="discovery-max-candidates"
                  type="number"
                  min="1"
                  max="12"
                  value={form.discoveryMaxCandidates}
                  onChange={set("discoveryMaxCandidates")}
                />
              </div>
              <div>
                <label htmlFor="discovery-fetch-limit">Fetch limit per source</label>
                <input
                  id="discovery-fetch-limit"
                  type="number"
                  min="2"
                  max="30"
                  value={form.discoveryFetchLimit}
                  onChange={set("discoveryFetchLimit")}
                />
              </div>
            </div>

            <div className="split">
              <div>
                <label htmlFor="discovery-freshness">Freshness window (hours)</label>
                <input
                  id="discovery-freshness"
                  type="number"
                  min="1"
                  max="336"
                  value={form.discoveryFreshnessHours}
                  onChange={set("discoveryFreshnessHours")}
                />
              </div>
              <div>
                <label htmlFor="discovery-dedupe">Avoid repost window (hours)</label>
                <input
                  id="discovery-dedupe"
                  type="number"
                  min="1"
                  max="1080"
                  value={form.discoveryDedupeHours}
                  onChange={set("discoveryDedupeHours")}
                />
              </div>
            </div>

            <label htmlFor="discovery-randomness">
              Discovery randomness: <strong>{form.discoveryRandomness}%</strong>
            </label>
            <input
              id="discovery-randomness"
              type="range"
              min="0"
              max="100"
              step="1"
              value={form.discoveryRandomness}
              onChange={set("discoveryRandomness")}
              style={rangeStyle(form.discoveryRandomness)}
            />

            <div className="toggles">
              <label>
                <input
                  type="checkbox"
                  checked={form.discoverySourceReddit}
                  onChange={set("discoverySourceReddit")}
                />
                Reddit
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={form.discoverySourceHackerNews}
                  onChange={set("discoverySourceHackerNews")}
                />
                Hacker News
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={form.discoverySourceYoutube}
                  onChange={set("discoverySourceYoutube")}
                />
                YouTube RSS
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={form.discoverySourceRss}
                  onChange={set("discoverySourceRss")}
                />
                RSS feeds
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={form.discoverySourceX}
                  onChange={set("discoverySourceX")}
                />
                X via Nitter RSS
              </label>
            </div>

            <label htmlFor="discovery-topics">Preferred topics (comma/newline)</label>
            <textarea
              id="discovery-topics"
              rows={2}
              value={form.discoveryPreferredTopics}
              onChange={set("discoveryPreferredTopics")}
            />

            {form.discoverySourceReddit && (
              <>
                <label htmlFor="discovery-reddit">Reddit subreddits</label>
                <textarea
                  id="discovery-reddit"
                  rows={2}
                  value={form.discoveryRedditSubs}
                  onChange={set("discoveryRedditSubs")}
                />
              </>
            )}

            {form.discoverySourceYoutube && (
              <>
                <label htmlFor="discovery-youtube">YouTube channel IDs</label>
                <textarea
                  id="discovery-youtube"
                  rows={2}
                  value={form.discoveryYoutubeChannels}
                  onChange={set("discoveryYoutubeChannels")}
                />
              </>
            )}

            {form.discoverySourceRss && (
              <>
                <label htmlFor="discovery-rss">RSS feed URLs</label>
                <textarea
                  id="discovery-rss"
                  rows={3}
                  value={form.discoveryRssFeeds}
                  onChange={set("discoveryRssFeeds")}
                />
              </>
            )}

            {form.discoverySourceX && (
              <>
                <label htmlFor="discovery-x-handles">X handles</label>
                <textarea
                  id="discovery-x-handles"
                  rows={2}
                  value={form.discoveryXHandles}
                  onChange={set("discoveryXHandles")}
                />

                <label htmlFor="discovery-nitter">Nitter base URL (for X RSS)</label>
                <input
                  id="discovery-nitter"
                  type="text"
                  value={form.discoveryXNitterBase}
                  onChange={set("discoveryXNitterBase")}
                />
              </>
            )}
          </>
        )}
      </Collapse>
    </SettingsSection>
  );
}
