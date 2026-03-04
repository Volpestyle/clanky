# clanker conk

A Discord bot that lives in your server as a genuine participant, not a command-response machine but a personality with tools.

The core idea: give an LLM brain a growing set of capabilities (voice, browsing, memory, web search, media generation) and let it compose them naturally through conversation. You don't invoke features with slash commands (though you can). You talk to the bot in voice or text and it figures out which tools to chain together to do what you're asking.

Ask it to check your GitHub issues? It can browse the page and summarize them. Ask it what song is playing in a stream it's watching? It can look at the screen, search the web, and queue it up. No rigid workflows, the brain orchestrates.

## Capabilities

**Communication**
- Text chat with natural reply decisions (not just @mention responses)
- Voice chat via OpenAI Realtime, Gemini Live, xAI, or ElevenLabs — the bot joins Discord voice channels and talks
- Stream watching with live screen-share vision and commentary

**Tools the Brain Can Use**
- Web search (Brave, SerpApi) with page inspection
- Headless browser agent for navigating and interacting with websites
- Persistent memory system (append-only journals + curated facts + vector search)
- Image generation (GPT Image, Grok Imagine)
- Video generation (Grok Imagine Video)
- GIF search (GIPHY)
- Claude Code agent for coding tasks (file editing, git, PRs) — allowed users only
- Music playback with queue management (yt-dlp + ffmpeg)
- MCP servers for extensibility

**Autonomy**
- Initiative posts on its own schedule — finds interesting content from Reddit, Hacker News, YouTube, RSS feeds
- Startup catchup — reads what it missed while offline and jumps back in
- Natural-language scheduled automations

**Infrastructure**
- Dashboard UI for settings, permissions, logs, memory, cost tracking
- Optional public HTTPS via Cloudflare Quick Tunnel
- Structured runtime logs with Loki/Grafana support
- SQLite persistence with vector embeddings
- Multi-provider LLM support (OpenAI, Anthropic, xAI, Google, Claude Code CLI)

## Setup

```bash
cp .env.example .env
bun install
```

### Required

- `DISCORD_TOKEN`
- At least one LLM provider key: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `GOOGLE_API_KEY`, and/or `ELEVENLABS_API_KEY`

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

For voice features, install `ffmpeg` and `yt-dlp` on the host.
For the optional `claude-code` brain provider, ensure `claude` CLI is on `PATH`.

### Provider Notes

- `XAI_API_KEY` — Grok text models, `voice_agent` mode, Grok Imagine media generation
- `OPENAI_API_KEY` — `openai_realtime` voice mode, STT pipeline mode
- `GOOGLE_API_KEY` — `gemini_realtime` voice mode
- `ELEVENLABS_API_KEY` — `elevenlabs_realtime` voice mode
- `ANTHROPIC_API_KEY` — Anthropic models, Claude Code brain sessions
- Stream-watch vision resolves providers in order: `anthropic` → `xai` → `claude-code`

## Discord Bot Permissions

Required intents: `Guilds`, `GuildMessages`, `GuildMessageReactions`, `MessageContent`, `GuildVoiceStates`

Recommended permissions: View Channels, Send Messages, Read Message History, Add Reactions, Connect, Speak, Use Soundboard

## Run

```bash
bun run start
```

Builds the React dashboard, then starts bot + dashboard together.

- Dashboard: `http://localhost:8787` (or configured `DASHBOARD_PORT`)
- Configure everything through the dashboard: persona, permissions, LLM provider/model, voice settings, reply/discovery behavior, memory, and more

### Keep It Running

```bash
bun add --global pm2
pm2 start "bun run start" --name clanker-conk
pm2 save && pm2 startup
```

Disable host sleep for always-on behavior.

### Public HTTPS (Optional)

```bash
PUBLIC_HTTPS_ENABLED=true
```

Spawns a Cloudflare Quick Tunnel automatically. Enables remote screen-share ingest and public share links.

### Local Loki Logs (Optional)

```bash
bun run logs:loki:up   # start Loki + Grafana
bun run start
```

Grafana at `http://localhost:3000` — query `{job="clanker_runtime"}`. Details in `docs/logs.md`.

## Docs

| Doc | Description |
|-----|-------------|
| `docs/technical-architecture.md` | System architecture, data model, runtime flows |
| `docs/clanker-activity.md` | Text activity model: direct replies, reply/lurk channels, thought loop, discovery |
| `docs/agent-code.md` | Claude Code orchestrator design and implementation |
| `docs/agent-browser.md` | Browser agent spec |
| `docs/realtime-voice-agent-spec.md` | Voice architecture and tool strategy |
| `docs/claude-code-brain-session-mode.md` | Claude Code as LLM brain provider |
| `docs/memory-system.md` | Memory system design |
| `docs/initiative-discovery-spec.md` | Discovery post content sourcing |
| `docs/voice-provider-abstraction.md` | Voice provider swappability |
| `docs/public-https-entrypoint-spec.md` | Public HTTPS tunnel |
| `docs/screen-share-link-spec.md` | Screen share flow |
| `docs/e2e-test-spec.md` | Test suites |
| `docs/replay-test-suite.md` | Replay test harness |
| `docs/logs.md` | Structured logging and Loki setup |

## Notes

- Runtime data stored in `./data/clanker.db`
- Memory journals: `memory/YYYY-MM-DD.md` (append-only)
- Curated memory: `memory/MEMORY.md` (periodically distilled from journals)
- English-only heuristic fast paths exist for specific detections (wake words, music intents, memory cleanup) — core LLM routing handles any language
