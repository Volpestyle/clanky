# clanky

An experimental Discord selfbot that lives in your server as a genuine participant, not a command-response machine but a personality with tools.

The core idea: give an LLM brain a growing set of capabilities (voice, browsing, memory, web search, media generation) and let it compose them naturally through conversation. You talk to the selfbot in voice or text and it figures out which tools to chain together to do what you're asking.

This fork is selfbot-first. The canonical control surfaces are natural conversation plus the private dashboard. Some legacy bot-oriented codepaths from `clanky` may still exist in the tree, but they are no longer the architectural center of the repo.

Clanky is Discord-centric and community-embedded first, but it is also a deeper personal assistant for the person running it. The intended product model is one socially real entity with relationship-based capability tiers: everyone in the community can use baseline shared abilities like conversation, web search, and music; explicitly approved collaborators can be granted higher-trust powers like code orchestration on shared or approved resources; and owner-only local/device powers stay with the operator's own Clanky instance.

Ask it to check your GitHub issues? It can browse the page and summarize them. Ask it what song is playing in a stream it's watching? It can look at the screen, search the web, and queue it up. No rigid workflows, the brain orchestrates.

## Capabilities

**Communication**
- Text chat with natural reply decisions (not just @mention responses)
- Voice chat via OpenAI Realtime, Gemini Live, xAI, or ElevenLabs — the selfbot joins Discord voice channels and talks
- Stream watching with live screen-share vision and commentary

**Tools the Brain Can Use**
- Web search (Brave, SerpApi) with page inspection
- Headless browser agents for navigating and interacting with websites (with optional persistent profile for authenticated browsing)
- Persistent memory system (append-only journals + curated facts + vector search)
- Image generation (GPT Image, Grok Imagine)
- Video generation (Grok Imagine Video)
- GIF search (GIPHY)
- Claude Code/Codex agents for coding tasks (file editing, git, PRs) — allowed users only, with local workers running in disposable git worktrees
- Music playback with queue management (yt-dlp + ffmpeg)
- MCP servers for extensibility

**Capability Tiers**
- Community capabilities for everyone in shared spaces: conversation, web search, page reading, media lookups, music playback, and community memory
- Trusted collaborator capabilities for explicitly approved users: deeper help on shared or approved resources, code orchestration, longer-running tasks, and richer scoped memory access
- Owner assistant capabilities for the person running this instance: private notifications, screenshots, clipboard, location, camera/share handoff, and other device-node actions
- Operator capabilities for dashboard admins: settings, permissions, dangerous actions, and runtime control

**Autonomy**
- Initiative posts on its own schedule — finds interesting content from Reddit, Hacker News, YouTube, RSS feeds
- Startup catchup — reads what it missed while offline and jumps back in
- Natural-language scheduled automations

**Infrastructure**
- Dashboard UI for settings, permissions, logs, memory, cost tracking
- Optional public HTTPS via Cloudflare Quick Tunnel
- Structured runtime logs with Loki/Grafana support
- SQLite persistence with vector embeddings
- Rust voice/media plane via `clankvox` for Discord audio, DAVE, RTP, and native stream receive
- Multi-provider model/runtime support (OpenAI, Anthropic, Claude OAuth, xAI, Google, Codex, Codex CLI, Claude Code)

## Tech Stack

- **Runtime:** Bun
- **Language:** TypeScript, Rust
- **Database:** SQLite
- **Frameworks/Libraries:** React, Hono, Discord.js
- **Media:** ffmpeg, yt-dlp

## Setup

```bash
cp .env.example .env
bun install
```

### Required

- `DISCORD_TOKEN` (`clanky_self` currently uses this legacy env name for the selfbot user token)
- At least one LLM provider credential: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `CLAUDE_OAUTH_REFRESH_TOKEN`, `OPENAI_OAUTH_REFRESH_TOKEN`, `GOOGLE_API_KEY`, and/or `ELEVENLABS_API_KEY`

### Optional

| Variable | Purpose |
|----------|---------|
| `BRAVE_SEARCH_API_KEY` | Primary web search |
| `SERPAPI_API_KEY` | Fallback web search |
| `GIPHY_API_KEY` | GIF replies |
| `DASHBOARD_HOST` | Dashboard bind address (default `127.0.0.1`) |
| `DASHBOARD_TOKEN` | Private dashboard/admin API auth |
| `PUBLIC_API_TOKEN` | Public tunnel stream-ingest auth |
| `PUBLIC_HTTPS_ENABLED` | Enable Cloudflare Quick Tunnel |
| `STREAM_LINK_FALLBACK` | Keep share-link screen-watch fallback enabled (default `true`) |

For voice features, install `ffmpeg` and `yt-dlp` on the host.
For optional local code-agent runtimes, ensure `claude` and/or `codex` CLI is on `PATH`.
Point the code-agent working directory at a git repo root or subdirectory; local workers execute inside disposable worktree branches instead of the live checkout.

### Browser Profile (Authenticated Browsing)

By default the browser agent starts with no cookies or login state. To let it browse as an authenticated user (YouTube recommendations, logged-in dashboards, etc.), set up a persistent Chromium profile:

```bash
bun run browser:login https://accounts.google.com   # opens headed browser — log in manually
agent-browser close                                   # close when done
```

The default profile path is `~/.clanky/browser-profile`, which is what `browser:login` uses. All future browser sessions automatically inherit your saved cookies and auth state. Re-run `bun run browser:login` to refresh expired sessions or log into additional sites.

See [`docs/capabilities/browser.md`](docs/capabilities/browser.md) for details.

### Provider Notes

- `XAI_API_KEY` — Grok text models, `voice_agent` mode, Grok Imagine media generation
- `OPENAI_API_KEY` — `openai_realtime` voice mode and OpenAI file-ASR/API-TTS voice overrides
- `OPENAI_OAUTH_REFRESH_TOKEN` — ChatGPT-authenticated OpenAI provider (`openai-oauth`)
- `GOOGLE_API_KEY` — `gemini_realtime` voice mode
- `ELEVENLABS_API_KEY` — `elevenlabs_realtime` voice mode
- `ANTHROPIC_API_KEY` — Anthropic models
- `CLAUDE_OAUTH_REFRESH_TOKEN` — Claude subscription-backed provider (`claude-oauth`)
- Stream-watch vision resolves providers in order: `claude-oauth` → `anthropic` → `xai`

## Discord Account Requirements

This fork assumes a real Discord user account used only for private experimentation.

- `DISCORD_TOKEN` should authenticate that user account.
- The runtime patches `discord.js` for user-session auth details: bare-token REST auth, `/gateway` discovery, desktop identify properties, and READY payload normalization when Discord omits `application` for user accounts.
- The account must already be present in the target server or DM/group call.
- The account needs whatever normal Discord permissions the room requires: view channels, send messages, connect, speak, and soundboard access where applicable.
- Bot-application setup is still relevant for driver bots in E2E tests, but not for the main runtime identity.

## Run

```bash
bun run start
```

Builds the React dashboard, then starts bot + dashboard together.

In this fork, that means the selfbot runtime plus dashboard together.

- Dashboard: `http://localhost:8787` (or configured `DASHBOARD_PORT`)
- Configure everything through the dashboard: persona, permissions, LLM provider/model, voice settings, reply/discovery behavior, memory, and more

### Keep It Running

```bash
bun add --global pm2
pm2 start "bun run start" --name clanky
pm2 save && pm2 startup
```

Disable host sleep for always-on behavior.

### Public HTTPS (Optional)

```bash
PUBLIC_HTTPS_ENABLED=true
```

Spawns a Cloudflare Quick Tunnel automatically. Enables remote screen-share ingest and public share links.

If you want native-only Discord Go Live watch with no share-link recovery path, set `STREAM_LINK_FALLBACK=false`.

### Local Loki Logs (Optional)

```bash
bun run logs:loki:up   # start Loki + Grafana
bun run start
```

Grafana at `http://localhost:3000` — query `{job="clanker_runtime"}`. Details in `docs/operations/logging.md`.

## Docs

| Doc | Description |
|-----|-------------|
| `docs/README.md` | Documentation map and canonical entry point into the docs tree |
| `docs/capabilities/media.md` | Unified media surface: music, video, screen watch, publish, and browser visual context |
| `docs/architecture/overview.md` | System architecture, data model, runtime flows |
| `docs/architecture/activity.md` | Text + voice activity model: direct replies, recent-window follow-ups, unified initiative, voice thought engine |
| `docs/architecture/relationship-model.md` | Product direction for community participation, owner-assistant depth, trusted collaborators, and capability ownership |
| `docs/architecture/initiative.md` | Unified text initiative cycle and discovery feed |
| `docs/architecture/presets.md` | Preset-driven stack/runtime settings |
| `docs/capabilities/code.md` | Code agent runtime (Claude Code, Codex CLI, Codex) |
| `docs/capabilities/browser.md` | Browser agent runtime, persistent profiles, authenticated browsing |
| `docs/voice/voice-provider-abstraction.md` | Voice pipeline stages, providers, and settings |
| `docs/voice/screen-share-system.md` | Screen share pipeline and frame reasoning flow |
| `docs/voice/discord-streaming.md` | Discord-native Go Live watch/publish transport details |
| `docs/archive/selfbot-stream-watch.md` | Historical selfbot-native Go Live watch plan and `clankvox` transport narrative |
| `docs/providers/oauth.md` | OAuth providers (`claude-oauth`, `openai-oauth`) |
| `docs/capabilities/memory.md` | Memory system design |
| `docs/operations/public-https.md` | Public HTTPS tunnel |
| `docs/operations/e2e.md` | E2E selfbot + driver-bot voice validation suites |
| `docs/operations/testing.md` | Test commands, live tests, and replay harnesses |
| `docs/operations/logging.md` | Structured logging and Loki setup |
| `docs/operations/multi-instance.md` | Running multiple bot instances with shared Loki |

Canonical specs live under `docs/architecture/`, `docs/capabilities/`, `docs/operations/`, `docs/providers/`, `docs/reference/`, and `docs/voice/`. Historical notes live under `docs/archive/` and `docs/tmp/`.

## Notes

- Runtime data stored in `./data/clanker.db`
- Memory journals: `memory/YYYY-MM-DD.md` (append-only)
- Curated memory: `memory/MEMORY.md` (periodically distilled from journals)
- English-only heuristic fast paths exist for specific detections (wake words, music intents, memory cleanup) — core LLM routing handles any language
