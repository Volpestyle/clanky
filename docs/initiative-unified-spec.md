# Unified Initiative System

> **Scope:** Unified text initiative cycle — merging the text thought loop and discovery engine into a single agent-autonomous posting system.
> Current activity model: [`clanker-activity.md`](clanker-activity.md)
> Voice thought engine (reference pattern): [`voice/voice-provider-abstraction.md`](voice/voice-provider-abstraction.md)
> Core principle: `AGENTS.md` — Agent Autonomy section

## Motivation

Three proactive activity systems operate at different levels of autonomy:

| System | What the agent decides | What the system decides for it |
|--------|----------------------|-------------------------------|
| Voice thought engine | Topic, wording, whether to speak, whether to refine | When to check (silence timer), probability (eagerness roll) |
| Text thought loop | What to say, whether to `[SKIP]` | Which channel (random shuffle), when to check (60s timer) |
| Discovery engine | What to write, media format | Which channel (random shuffle), when to post (schedule/probability), link inclusion (can be forced), what sources to follow |

The voice thought engine is the reference pattern — rich context in, agent decides everything creative. The unified initiative system brings that same autonomy to text:

1. **Context-aware channel selection.** The agent reasons about *where* to post. A human scans channels and picks the one where they have something to say — the agent should too.

2. **Autonomous curiosity over content scheduling.** The agent decides when it feels like sharing, which content interests it, and what topics to explore.

3. **Agent-owned link inclusion.** The model decides whether to include links, not a probability override.

4. **Eagerness as a probability gate.** `initiative.text.eagerness` controls what percentage of ticks consult the LLM.

5. **Community-driven source curation.** The bot develops interests based on what the community responds to.

## Design Principles

- The agent decides **what** to say, **where** to say it, and **whether** to say anything at all.
- Infrastructure handles **when to consult** the agent (timers, budgets, rate limits) and **what context to provide** (channel summaries, discovery candidates, memory, tools).
- Settings are cost/noise gates (budgets, cooldowns, eagerness probability) and social context (eagerness tier descriptions), not behavioral rules.
- Discovery candidates are things the agent *might find interesting*, not assignments to fulfill.
- The agent develops interests over time based on what the community responds to.

## Architecture: Unified Initiative Cycle

Merge the text thought loop and discovery engine into a single initiative cycle. One timer, one decision point, full agent autonomy.

```
Every 60 seconds (INITIATIVE_TICK_MS)
    │
    ▼
┌──────────────────────────────────────────┐
│  COST GATES (deterministic, no LLM)      │
│                                          │
│  - initiative.text.enabled?              │
│  - Daily budget remaining?               │
│  - Min gap since last post met?          │
│  - Rate limit (maxMessagesPerHour)?      │
│  - Eagerness probability roll?           │
│    (initiative.text.eagerness / 100)     │
└──────────────┬───────────────────────────┘
               │ (all pass)
               ▼
┌──────────────────────────────────────────┐
│  CONTEXT ASSEMBLY                        │
│                                          │
│  Channel summaries:                      │
│  - Last 3-5 messages per eligible channel│
│  - Activity level, time since last human │
│  - Time since bot last posted            │
│                                          │
│  Passive feed (pre-fetched):             │
│  - Discovery candidates from RSS, Reddit,│
│    HN, YouTube, X                        │
│  - Labeled as optional, not assignments  │
│                                          │
│  Feed source performance:                │
│  - Per-source stats (shared/total,       │
│    engagement, last used)                │
│                                          │
│  Community interest context:             │
│  - Memory facts about what resonates     │
│  - Recent engagement signals             │
│  - Adaptive directives                   │
└──────────────┬───────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────┐
│  AGENT DECISION (LLM tool loop)          │
│                                          │
│  Same bounded tool loop as the reply     │
│  pipeline — the model can call tools,    │
│  see results, reason, and iterate.       │
│                                          │
│  Bounded by:                             │
│  - Max tool steps (default 3)            │
│  - Max total tool calls (default 4)      │
│  - Timeout (default 30s)                 │
│                                          │
│  Example flow:                           │
│                                          │
│  Step 1: "Let me check if that Zelda    │
│    article is actually good"             │
│    → browser_browse(url)                 │
│                                          │
│  Step 2: "Eh, clickbait. Let me search  │
│    for Elden Ring DLC news instead"      │
│    → web_search("elden ring dlc 2026")  │
│                                          │
│  Step 3: "Found something great.        │
│    Posting in #gaming."                  │
│    → final output                        │
│                                          │
│  Or simply:                              │
│                                          │
│  Step 1: "Nothing interesting today."   │
│    → { skip: true }                      │
│                                          │
│  Available tools:                        │
│  - web_search (look things up)           │
│  - browser_browse (read pages in depth)  │
│  - memory_search (what do I know?)       │
│  - discovery_source_add/remove/list      │
│    (feed self-curation, if enabled)      │
│                                          │
│  Final output schema:                    │
│  {                                       │
│    skip: boolean,                        │
│    channelId: string | null,             │
│    text: string,                         │
│    mediaDirective: "none" | "image" |    │
│      "video" | "gif",                    │
│    mediaPrompt: string | null,           │
│    reason: string                        │
│  }                                       │
└──────────────┬───────────────────────────┘
               │ (not skip)
               ▼
┌──────────────────────────────────────────┐
│  DELIVERY                                │
│                                          │
│  - Resolve media if requested            │
│  - Sanitize text, resolve mentions       │
│  - Post to selected channel              │
│  - Record in message history             │
│  - Store engagement signal for interest  │
│    learning (async)                      │
└──────────────────────────────────────────┘
```

### Benefits of Unification

- **Discovery candidates are context, not assignments.** Optional material alongside channel activity, not a separate system that tells the bot to post.
- **One decision covers both "react to conversation" and "share something new."** The model might see an active discussion in #tech AND a relevant discovery link, and decide the link fits that conversation. Or it might see a quiet #memes channel and share a funny link to liven it up. Or it might `[SKIP]` everything.
- **Intelligent channel selection.** The model sees all eligible channels and their state, matching content to context.
- **Active curiosity.** With tools available in the initiative call, the model can go looking for things, not just react to what's been pre-fetched.
- **One timer, one prompt builder, one decision schema.**

### Separate Systems

- **Voice thought engine.** Voice operates in a fundamentally different runtime (active session, silence timers, realtime speech). It is the reference pattern.
- **Discovery source collection.** The background job that fetches links from Reddit, HN, RSS, YouTube, X. This is infrastructure, not agent behavior. It fills a passive feed that the initiative cycle draws from.
- **Media generation.** Image/video/GIF generation is a capability the agent can request via its output directive.

## Two Modes of Discovery

A real person discovers things two ways. The bot should too.

### Passive Feed (background, cheap)

The existing source collection infrastructure fetches content from configured sources (Reddit, HN, RSS, YouTube, X) on a background schedule. This is the bot's "timeline" — things that show up without effort.

These candidates are presented in the initiative prompt as optional material:

```
Things from your feed (share if any catch your eye):

1. "New benchmark shows Claude 4.6 outperforming on coding tasks"
   Source: Hacker News · 4h ago
   Link: https://...

2. "Hilarious bug where NPC walks through walls in new Zelda"
   Source: r/games · 2h ago
   Link: https://...

3. "Rust 2025 edition announced with async trait stabilization"
   Source: The Verge RSS · 8h ago
   Link: https://...
```

The model decides whether any are worth sharing, which channel they fit, and how to present them. **No link forcing** — if the model doesn't include a link, that's its decision.

### Active Curiosity (agent-driven, on-demand)

The initiative cycle gives the model access to `web_search` and `browser_browse`. This lets the bot follow its own curiosity:

- Community's been talking about the Elden Ring DLC → bot searches for latest news → shares what it finds
- Someone asked about a topic yesterday that the bot remembers → bot looks it up proactively → posts the answer
- Discovery feed has an interesting headline → bot browses the actual article to see if it's worth sharing → posts a genuine take instead of a blind reshare
- Discovery feed has nothing interesting this cycle → bot searches for something related to community interests → finds a gem
- Someone mentioned a game wiki → bot browses the page, reads about an obscure mechanic → shares a fun fact

`web_search` is for quick lookups — headlines, recent news, checking if something exists. `browser_browse` is for depth — reading an article, exploring a page, understanding content well enough to have a real opinion about it. The bot uses whichever fits the moment.

Active curiosity is bounded by the same cost gates as everything else — the eagerness probability roll means most ticks don't even reach the LLM, and the daily budget caps total posts. Tool calls are inside the initiative LLM call, same pattern as the reply pipeline's tool loop.

This is the key difference between "content scheduler" and "curious person." A scheduler delivers what it's given. A curious person goes looking for things that interest them, reads things that catch their eye, and shares what they genuinely find interesting.

## Community Interest Learning

The bot should develop a sense of what the server cares about — not from a static `preferredTopics` list, but from observation.

### How Interests Form

The bot already has durable memory (`memory_write`) and can observe engagement signals:

- **Post reactions.** When the bot shares something and it gets emoji reactions or reply threads, that's a signal. "Gaming content in #general gets engagement."
- **Conversation topics.** What do people talk about most? The bot sees recent messages across channels during each initiative cycle. Over time, recurring themes become durable memory facts.
- **Direct feedback.** If someone says "more posts like this!" or "stop posting tech stuff," the bot stores that as a directive or memory fact.

### How Interests Shape Discovery

Community interest facts are included in the initiative prompt alongside everything else:

```
What you know about this community's interests:
- Gaming content (especially Nintendo, Elden Ring) gets the most engagement
- Tech/AI news lands well in #tech but not #general
- The server has been talking about Rust a lot lately
- james mentioned wanting to see more music recommendations
```

The model naturally gravitates toward candidates and search queries that match. No hardcoded filtering — the model reasons about fit the same way a human community member would.

### Interest Evolution

Interests aren't static. The bot's memory evolves as the community does:

- New games come out → conversations shift → bot notices and adjusts
- A topic gets stale → engagement drops → bot deprioritizes it
- New members join with different interests → bot picks up on new themes

The memory system already supports this — facts can be updated, and old facts naturally age out of relevance. The initiative prompt includes recent facts, so the model's sense of community interests stays current.

### Feed Self-Curation

The bot manages its own feed subscriptions. The operator seeds initial sources and sets guardrails (which source types are enabled, max sources per type, content safety). Within those boundaries, the bot adds, removes, and adjusts sources based on what the community responds to.

This follows the same pattern as everything else: **operator controls the boundaries, agent operates freely within them.**

#### How It Works

The initiative cycle includes source management tools:

- `discovery_source_add` — subscribe to a new subreddit, RSS feed, YouTube channel, etc.
- `discovery_source_remove` — drop a source that isn't performing
- `discovery_source_list` — see current subscriptions (so the model knows its own state)

The model reasons about when to use them the same way it reasons about any other tool. It doesn't adjust sources every tick — it notices a pattern over time ("community loves indie games, I don't have any indie game sources") and acts on it when the insight is clear.

#### Source performance context

The initiative prompt includes source-level engagement stats so the model can reason about feed quality:

```
Your feed sources:
- r/technology — 0/8 candidates shared in last 2 weeks, 0 community engagement
- r/games — 5/6 candidates shared, 12 reactions total
- Hacker News — 3/10 candidates shared, 4 reactions
- The Verge RSS — 0/5 candidates shared in last 2 weeks
- r/IndieGaming — (added by you 3 days ago) 2/2 shared, 8 reactions
```

The model sees which sources are pulling their weight and which aren't. It can drop dead weight, double down on what works, or explore new sources based on community conversations.

#### What this looks like over time

**Week 1:** Operator seeds with r/technology, r/games, HN, The Verge RSS.

**Week 2:** Bot shares a few things. Gaming content gets engagement, Verge articles get ignored. Bot notices in memory: "gaming content resonates, Verge doesn't land."

**Week 3:** Bot adds r/IndieGaming (noticed the community loves indie games from conversations). Removes The Verge RSS (zero engagement in 2 weeks, logs the reason). Adds a Rust blog RSS feed (community talks about Rust constantly).

**Week 4:** Bot's feed reflects what the community actually cares about. Operator didn't have to touch anything. Every add/remove is logged with the bot's reasoning, visible in the action log.

#### Guardrails (operator-owned)

| Operator controls | Agent controls |
|---|---|
| Which source types are enabled (Reddit, HN, RSS, YouTube, X) | Which specific subreddits, feeds, channels within enabled types |
| Max sources per type (prevents unbounded growth) | Which sources to add or remove |
| Content safety flags (`allowNsfw`, blocked domains) | What topics to follow based on community interest |
| `discovery.allowSelfCuration` toggle (kill switch) | When to adjust sources |

Every source change is logged as an action with the model's reasoning. The operator can review the audit trail and override if the bot's taste drifts somewhere unwanted.

#### Fallback

If `discovery.allowSelfCuration` is false, source management tools aren't available. The bot still observes source performance via memory and can surface insights through operational messages: "The Verge RSS hasn't produced anything the community engaged with in weeks — might be worth swapping." The operator acts on it manually. This is the conservative path for operators who want to keep control of the feed.

## Channel-Aware Selection

Instead of random shuffle, the initiative prompt includes a brief summary of each eligible channel:

```
Eligible channels:

#general (text)
  Last human message: 8m ago — "anyone want to play tonight?" (user: james)
  Your last message: 2h ago
  Recent activity: 3 messages in the last hour

#tech (text)
  Last human message: 3h ago — quiet
  Your last message: yesterday
  Recent activity: idle

#memes (text)
  Last human message: 2m ago — active meme exchange
  Your last message: 5h ago
  Recent activity: 12 messages in the last hour
```

Channel summaries are cheap to build — we already have message history. This adds input tokens but no extra LLM call.

The model picks where to post based on fit: a discovery link about AI goes to #tech, a funny clip goes to #memes, a reaction to "anyone want to play?" goes to #general. Or `[SKIP]` if nothing feels right.

### Eligible Channels

The unified pool comes from the union of:
- `permissions.replyChannelIds` (thought loop eligible)
- `initiative.discovery.channelIds` (discovery eligible)

The model doesn't know which list a channel came from. It just sees channels and their context.

## Eagerness as Probability Gate

Wire `initiative.text.eagerness` the same way voice does:

```typescript
const eagerness = clamp(settings.initiative.text.eagerness, 0, 100);
const roll = Math.random() * 100;
if (roll >= eagerness) return; // Skip this tick
```

At eagerness 20 (default), only 20% of eligible ticks consult the LLM. At eagerness 100, every tick tries. The model still decides whether to post via `[SKIP]`.

The eagerness value is also included in the prompt as social mode context (same pattern as reply eagerness and voice eagerness), so the model calibrates its posting threshold accordingly.

## Prompt Structure

The initiative prompt gives the model everything it needs:

```
=== INITIATIVE MODE ===
You are {botName}. You have a moment to look around your Discord channels
and decide if you want to post something.

Persona: {flavor}
Social mode: {eagernessDescription}

=== CHANNELS ===
{channelSummaries}

=== YOUR FEED ===
{discoveryCandidates or "Nothing new in your feed right now."}

=== FEED SOURCES ===
{sourcePerformanceSummary}

=== WHAT THIS COMMUNITY IS INTO ===
{communityInterestFacts or "You're still getting to know this community."}

=== MEMORY ===
{relevantFacts}

=== ADAPTIVE DIRECTIVES ===
{directives}

=== CAPABILITIES ===
You can use web_search to look something up, or browser_browse to
read a page in depth — if you're curious about something or want to
check if a feed item is actually worth sharing.

You can request media (image, video, GIF) if the moment calls for it.

{if selfCurationEnabled}
You can manage your own feed:
- discovery_source_add: subscribe to a new subreddit, RSS feed, YouTube channel
- discovery_source_remove: drop a source that isn't working
- discovery_source_list: see your current subscriptions
{/if}

=== TASK ===
Look around. If something catches your eye — a conversation you can
add to, a feed item worth sharing, a topic you want to explore —
pick a channel and post. Otherwise, [SKIP] and check back later.

If you notice a source consistently isn't producing anything useful,
or the community's interests point toward sources you don't have yet,
you can adjust your feed.
```

## Settings

### Initiative Settings

The initiative cycle reads from a unified config. Discovery-specific source and media settings stay separate since they're infrastructure.

| Setting | Default | Description |
|---------|---------|-------------|
| `initiative.text.enabled` | `true` | Master toggle for text initiative |
| `initiative.text.eagerness` | `20` | Probability (0-100) of consulting the LLM each tick. Also passed as social context. |
| `initiative.text.minMinutesBetweenPosts` | `60` | Cooldown between any initiative post |
| `initiative.text.maxPostsPerDay` | `3` | Daily budget for initiative posts (thought + discovery combined) |
| `initiative.text.lookbackMessages` | `20` | Recent messages per channel for context |
| `initiative.text.execution` | inherit | Model/provider override for initiative LLM call |
| `initiative.text.allowActiveCuriosity` | `true` | Whether web_search and browser_browse are available during initiative |
| `initiative.text.maxToolSteps` | `3` | Max tool loop iterations per initiative cycle |
| `initiative.text.maxToolCalls` | `4` | Max total tool calls per initiative cycle |

### Discovery Settings

Source collection settings (`discovery.sources`, `discovery.redditSubreddits`, `discovery.rssFeeds`, etc.) seed the passive feed and define the infrastructure.

Media generation settings (`discovery.allowImagePosts`, `discovery.simpleImageModel`, etc.) control capabilities available to the agent.

Self-curation settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `discovery.allowSelfCuration` | `true` | Whether the bot can add/remove its own feed sources |
| `discovery.maxSourcesPerType` | `10` | Cap on sources per type (reddit, rss, youtube, etc.) to prevent unbounded growth |

### Legacy Setting Mapping

| Legacy Setting | Unified Equivalent |
|---------|--------|
| `initiative.discovery.enabled` | Covered by `initiative.text.enabled` — discovery candidates are context within the unified cycle. |
| `initiative.discovery.channelIds` | Part of the general eligible channel pool. |
| `initiative.discovery.pacingMode` | Handled by eagerness probability gate. |
| `initiative.discovery.spontaneity` | Handled by eagerness. |
| `initiative.discovery.maxPostsPerDay` | `initiative.text.maxPostsPerDay`. |
| `initiative.discovery.minMinutesBetweenPosts` | `initiative.text.minMinutesBetweenPosts`. |
| `initiative.discovery.linkChancePercent` | Agent decides link inclusion. |
| `initiative.discovery.postOnStartup` | Agent can post on the first eligible tick. |
| `initiative.text.maxThoughtsPerDay` | `initiative.text.maxPostsPerDay`. |
| `initiative.discovery.preferredTopics` | Interests come from community memory. |

## Engagement Feedback Loop

After the bot posts, the system observes engagement and feeds it back:

### Collection (async, background)

- **Reaction tracking.** When the bot's initiative posts receive emoji reactions, count and categorize them. Store as metadata on the action log.
- **Reply tracking.** When users reply to initiative posts, note the topic and sentiment. A reply thread means the post landed.
- **Absence tracking.** Posts that get zero engagement within an hour are also a signal — the topic or channel fit didn't resonate.

### Memory Integration

Periodically (or during the daily memory reflection if enabled), the system synthesizes engagement patterns into durable memory facts:

- "Posts about gaming news in #general get 3x more reactions than tech news"
- "The community ignored the last 3 RSS links from The Verge"
- "Sharing memes in #memes during evening hours gets the best engagement"

These facts enter the initiative prompt naturally via the community interest context section. The model adjusts without being told to — it reads the room.

### Source Quality Signal

Engagement data feeds directly into feed self-curation. The initiative prompt includes source-level performance stats (candidates shared, community engagement), so the model can:

- Drop sources whose candidates are consistently skipped or ignored
- Add new sources aligned with topics the community engages with
- Log reasoning for every change in the action audit trail

If self-curation is disabled, the model surfaces insights through operational messages instead, and the operator acts manually.

## Implementation Phases

### Phase 1: Foundation

1. **Wire text eagerness** — probability gate on the initiative tick
2. **Add channel summaries** — build per-channel context in the initiative prompt
3. **Add web_search to initiative** — tool available during the initiative LLM call

### Phase 2: Unified cycle

4. **Fold discovery candidates into initiative prompt** — present them as feed context
5. **Unified output schema** — channelId + text + media + skip in one structured output
6. **Agent-owned link inclusion** — model decides link inclusion
7. **Single timer** — one initiative cycle
8. **Consolidate settings** — unified pacing settings
9. **Keep `src/services/discovery.ts` focused on source collection** — posting stays in the unified initiative cycle

### Phase 3: Interest learning and self-curation

10. **Engagement tracking** — reaction/reply observation on initiative posts
11. **Community interest memory** — synthesize engagement into durable facts
12. **Source performance context** — per-source stats in initiative prompt
13. **Source management tools** — `discovery_source_add`, `discovery_source_remove`, `discovery_source_list`
14. **Self-curation guardrails** — `allowSelfCuration` toggle, `maxSourcesPerType` cap, action logging

Each phase is independently valuable.

## Key Source Files

| File | Role |
|------|------|
| `src/bot/initiativeEngine.ts` | Unified initiative cycle |
| `src/services/discovery.ts` | Source collection infrastructure |
| `src/bot.ts` | Initiative timer |
| `src/prompts/promptText.ts` | Initiative prompt builder |
| `src/voice/thoughtEngine.ts` | Voice thought engine (reference pattern) |
| `src/voice/voiceThoughtGeneration.ts` | Voice thought generation |
