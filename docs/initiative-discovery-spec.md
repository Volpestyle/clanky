# Initiative Creative Discovery

## Purpose

The discovery subsystem enriches discovery posts with fresh external content by fetching, filtering, and ranking candidate links from configured sources. This enables discovery channels to surface timely topics and real links instead of generating content purely from the model's training data.

## Design Properties

- Initiative posts include real links and timely topics when discovery is enabled.
- Persistent shared-link dedupe prevents repeat posts of the same URL.
- All controls are exposed through the dashboard settings UI with no code changes required.

## Runtime Behavior

1. On each discovery cycle that is due, `DiscoveryService.collect()` gathers candidate links from enabled sources.
2. Candidates are filtered by freshness window and repost-avoid window.
3. Highest-scoring candidates are injected into the discovery-post prompt as optional inspiration.
4. The bot generates one standalone message; link inclusion is probabilistic via `discovery.linkChancePercent` and bounded by `discovery.maxLinksPerPost`.
5. Any links actually posted are recorded in the `shared_links` table for dedupe on later cycles.

## Supported Sources

- Reddit hot feed (`r/...`)
- Hacker News top stories
- YouTube channel RSS
- Generic RSS feeds
- X handles via Nitter RSS (optional)

## Ranking Heuristics

- Source quality weight
- Topic overlap with recent channel messages and preferred topics
- Freshness decay
- Optional popularity boost
- Configurable randomness factor

## Safety and Guardrails

- HTTP/HTTPS only.
- Local/private hostnames blocked (`localhost`, RFC1918 IP ranges).
- Tracking query params stripped from URLs.
- Optional NSFW filtering.
- Hard caps on source fetch size and prompt candidate count.

## Dashboard Controls

Under `Autonomous Initiative Posts -> Creative Discovery`:

- `discovery.enabled`: master toggle.
- `discovery.linkChancePercent`: probability that a discovery post should include links.
- `discovery.maxLinksPerPost`: upper bound on links per post.
- `discovery.maxCandidatesForPrompt`: number of candidates injected into the prompt.
- `discovery.freshnessHours`: maximum age of candidate content.
- `discovery.dedupeHours`: dedupe cooldown after posting a link.
- `discovery.randomness`: randomness factor applied during ranking.
- `discovery.sourceFetchLimit`: per-source fetch cap.
- Source toggles and source lists (subreddits, YouTube channel IDs, RSS feeds, X handles, Nitter base URL).
- Preferred topics.

## Data Model

`shared_links` table:

- `url` (PK)
- `first_shared_at`
- `last_shared_at`
- `share_count`
- `source`

## Observability

`discovery_post` action metadata includes:

- Discovery enablement flag
- Required-link flag
- Topic seeds
- Candidate and selected counts
- Used links
- Source reports and errors

## Tuning Guidance

- Recommended starting point: discovery enabled with `linkChancePercent` around `65-80`.
- `maxLinksPerPost=1-2` avoids spammy channel behavior.
- Freshness window between `48-120` hours, adjusted based on channel velocity.
