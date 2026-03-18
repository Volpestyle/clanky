import { SettingsSection } from "../SettingsSection";
import { Collapse } from "../Collapse";
import { rangeStyle } from "../../utils";

export function DiscoverySettingsSection({
  id,
  form,
  set,
  showDiscoveryFeedControls,
  showDiscoveryImageControls,
  showDiscoveryVideoControls,
  discoveryImageModelOptions,
  discoveryVideoModelOptions
}) {
  const sectionActive =
    form.discoveryFeedEnabled ||
    form.discoveryImageEnabled ||
    form.discoveryVideoEnabled ||
    form.replyImageEnabled ||
    form.replyVideoEnabled ||
    form.replyGifEnabled;

  return (
    <SettingsSection id={id} title="Initiative Feed & Media" active={sectionActive}>
      <div className="toggles">
        <label>
          <input
            type="checkbox"
            checked={form.discoveryFeedEnabled}
            onChange={set("discoveryFeedEnabled")}
          />
          Enable passive discovery feed inputs
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.discoveryImageEnabled}
            onChange={set("discoveryImageEnabled")}
          />
          Allow initiative image posts
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.discoveryVideoEnabled}
            onChange={set("discoveryVideoEnabled")}
          />
          Allow initiative video posts
        </label>
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

      <Collapse open={showDiscoveryImageControls}>
        <h4>Image Generation</h4>
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
        <h4>Video Generation</h4>
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

      <Collapse open={showDiscoveryFeedControls}>
        <h4>Passive Feed Inputs</h4>
        <p>These sources seed the initiative prompt. The agent decides whether to use them, where they fit, or whether to ignore them.</p>

        <div className="toggles">
          <label>
            <input
              type="checkbox"
              checked={form.discoveryAllowNsfw}
              onChange={set("discoveryAllowNsfw")}
            />
            Allow NSFW discovery items
          </label>
          <label>
            <input
              type="checkbox"
              checked={form.discoveryAllowSelfCuration}
              onChange={set("discoveryAllowSelfCuration")}
            />
            Allow bot self-curation of sources
          </label>
        </div>

        <div className="split">
          <div>
            <label htmlFor="discovery-max-links">Max links per initiative post</label>
            <input
              id="discovery-max-links"
              type="number"
              min="0"
              max="5"
              value={form.discoveryMaxLinks}
              onChange={set("discoveryMaxLinks")}
            />
          </div>
          <div>
            <label htmlFor="discovery-max-candidates">Feed candidates in prompt</label>
            <input
              id="discovery-max-candidates"
              type="number"
              min="1"
              max="20"
              value={form.discoveryMaxCandidates}
              onChange={set("discoveryMaxCandidates")}
            />
          </div>
        </div>

        <div className="split">
          <div>
            <label htmlFor="discovery-max-media-prompt-chars">Max media prompt chars</label>
            <input
              id="discovery-max-media-prompt-chars"
              type="number"
              min="100"
              max="2000"
              value={form.discoveryMaxMediaPromptChars}
              onChange={set("discoveryMaxMediaPromptChars")}
            />
          </div>
          <div>
            <label htmlFor="discovery-max-sources-per-type">Max sources per type</label>
            <input
              id="discovery-max-sources-per-type"
              type="number"
              min="1"
              max="50"
              value={form.discoveryMaxSourcesPerType}
              onChange={set("discoveryMaxSourcesPerType")}
            />
          </div>
        </div>

        <div className="split">
          <div>
            <label htmlFor="discovery-fetch-limit">Fetch limit per source</label>
            <input
              id="discovery-fetch-limit"
              type="number"
              min="1"
              max="50"
              value={form.discoveryFetchLimit}
              onChange={set("discoveryFetchLimit")}
            />
          </div>
          <div>
            <label htmlFor="discovery-freshness">Freshness window (hours)</label>
            <input
              id="discovery-freshness"
              type="number"
              min="1"
              max="720"
              value={form.discoveryFreshnessHours}
              onChange={set("discoveryFreshnessHours")}
            />
          </div>
        </div>

        <div className="split">
          <div>
            <label htmlFor="discovery-dedupe">Avoid repost window (hours)</label>
            <input
              id="discovery-dedupe"
              type="number"
              min="1"
              max="2160"
              value={form.discoveryDedupeHours}
              onChange={set("discoveryDedupeHours")}
            />
          </div>
          <div />
        </div>

        <label htmlFor="discovery-randomness">
          Feed randomness: <strong>{form.discoveryRandomness}%</strong>
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
      </Collapse>
    </SettingsSection>
  );
}
