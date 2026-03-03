# clanker_conk

AI-powered Discord bot persona (default name: **clanker conk**).

Features:
- Random human-like interactions in allowed channels.
- Standalone initiative posts stay restricted to `initiativeChannelIds`; reply turns may also post channel-level comments when a turn is not directly addressed.
- Initiative scheduler with `even` or `spontaneous` pacing modes.
- Natural-language scheduled automations (create/list/pause/resume/delete) with persistent runs.
- Creative discovery for initiative posts (Reddit, Hacker News, YouTube RSS, RSS feeds, optional X via Nitter).
- OpenAI, Anthropic, Grok (xAI), or Claude Code CLI support (runtime-configurable).
- Optional live web search for replies (Brave primary, SerpApi fallback), including page inspection from top results.
- Optional model-directed GIF replies via GIPHY search.
- Optional Grok Imagine image/video generation for complex visuals and clips.
- Video link understanding for YouTube/TikTok/embedded video links (captions first, optional ASR fallback, optional keyframes).
- NL-controlled Discord voice sessions (join/leave/status) with session limits and runtime guards.
- Voice runtime mode selector: `voice_agent` (xAI realtime), `openai_realtime` (OpenAI Realtime), `gemini_realtime` (Gemini Live API), `elevenlabs_realtime` (ElevenLabs Agents websocket), or `stt_pipeline` (STT/TTS pipeline mode).
- Stream-watch voice controls (`watch_stream`, `stop_watching_stream`, `stream_status`) with external frame ingest path.
- Model-directed screen-share link offers (`screenShareIntent`) with temporary browser capture links (localhost fallback or public HTTPS).
- Optional auto-managed public HTTPS dashboard entrypoint via Cloudflare Quick Tunnel.
- Dashboard UI for settings, permissions, logs, memory, and cost tracking.
- Dashboard automation visibility endpoints: `/api/automations` and `/api/automations/runs`.
- Two-layer memory with append-only daily logs and curated `memory/MEMORY.md` distillation.
- Structured runtime JSON action logs (stdout + file) with local Loki/Promtail/Grafana stack support.

## 1. Setup

```bash
cd /path/to/clanker_conk-master
cp .env.example .env
bun install
```

Populate `.env`:
- `DISCORD_TOKEN`: the bot token.
- `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, and/or `ELEVENLABS_API_KEY`.
- Optional for `claude-code` provider: `claude` CLI available on `PATH` in the same runtime environment that starts the bot.
- `XAI_API_KEY`: required for Grok text models and `voice_agent` mode, also used for Grok Imagine media generation, and required for stream-watch speech output in `voice_agent`.
- `OPENAI_API_KEY`: required for `voice.openaiRealtime` mode and `voice.sttPipeline` mode.
- Stream-watch vision fallback for `voice_agent` resolves configured providers in this order: `anthropic` → `xai` → `claude-code`.
- `GOOGLE_API_KEY`: required for `voice.geminiRealtime` mode and stream-watch commentary when VC mode is `gemini_realtime`.
- `ELEVENLABS_API_KEY`: required for `voice.elevenLabsRealtime` mode.
- `XAI_BASE_URL`: optional xAI API base URL override (default `https://api.x.ai/v1`).
- Optional for live web search: `BRAVE_SEARCH_API_KEY` (primary) and/or `SERPAPI_API_KEY` (fallback).
- Optional for model-directed GIF replies: `GIPHY_API_KEY` (and optional `GIPHY_RATING`, default `pg-13`).
- Optional bind host for dashboard/API (defaults to loopback only): `DASHBOARD_HOST` (default `127.0.0.1`).
- Optional structured runtime logs for local debugging/Loki:
  - `RUNTIME_STRUCTURED_LOGS_ENABLED` (default `true`)
  - `RUNTIME_STRUCTURED_LOGS_STDOUT` (default `true`)
  - `RUNTIME_STRUCTURED_LOGS_FILE_PATH` (default `data/logs/runtime-actions.ndjson`)
- Required for private dashboard/admin API access when public HTTPS is enabled: `DASHBOARD_TOKEN` (sent as `x-dashboard-token`).
- Optional for public tunnel stream-ingest access: `PUBLIC_API_TOKEN` (sent as `x-public-api-token`).
- Optional for auto public HTTPS entrypoint:
  - `PUBLIC_HTTPS_ENABLED=true`
  - optional `PUBLIC_HTTPS_TARGET_URL` (defaults to `http://127.0.0.1:${DASHBOARD_PORT}`)
  - optional `PUBLIC_HTTPS_CLOUDFLARED_BIN` (defaults to `cloudflared`)
  - optional `PUBLIC_SHARE_SESSION_TTL_MINUTES` (default `12`, clamp `2..30`)
  - if disabled, screen-share links still work locally via `http://127.0.0.1:${DASHBOARD_PORT}/share/<token>` on the machine running the bot
- Optional but recommended for richer video understanding: install `ffmpeg` and `yt-dlp` on the host system.

## 2. Discord bot permissions

Required intents:
- `Guilds`
- `GuildMessages`
- `GuildMessageReactions`
- `MessageContent`
- `GuildVoiceStates` (required when voice mode is enabled)

Recommended bot permissions in server:
- View Channels
- Send Messages
- Read Message History
- Add Reactions
- Connect (voice)
- Speak (voice)
- Use Soundboard (voice soundboard features)
- Use External Sounds (only if `voice.soundboard.allowExternalSounds=true`)

## 3. Run

```bash
bun run start
```

`start` builds the React dashboard and then starts bot + dashboard together.
- Dashboard URL: `http://localhost:8787` (or the configured `DASHBOARD_PORT` value)
- Public HTTPS status: `GET /api/public-https` and in `/api/stats -> runtime.publicHttps`

## 3.1 Public HTTPS Entrypoint (Cloudflare Quick Tunnel, optional for remote users)

Install `cloudflared` and set:

```bash
PUBLIC_HTTPS_ENABLED=true
```

Then start the app normally (`bun run start`). The app will spawn:

```bash
cloudflared tunnel --url http://127.0.0.1:<DASHBOARD_PORT> --no-autoupdate
```

When tunnel bootstrap succeeds, the public URL appears in:
- dashboard metrics (`Public HTTPS`)
- `/api/public-https`
- action stream (`public_https_entrypoint_ready`)

Public/private gating defaults:
- Tunnel ingress remains allowlisted and authenticated; dashboard/admin routes stay private.
- Canonical route-gating and auth behavior: `docs/public-https-entrypoint-spec.md`.

## 3.2 Keep It Running Locally

- If the host machine is asleep, the bot is paused. Disable host sleep for always-on behavior.
- Running the bot under a process supervisor ensures it restarts after crashes or reboots.

Example with PM2:

```bash
bun add --global pm2
pm2 start "bun run start" --name clanker-conk
pm2 save
pm2 startup
```

Windows host sleep settings (for WSL users):
- Set **Sleep** to **Never** while plugged in.
- Allow display-off if needed; only system sleep needs to be disabled.

## 3.3 Local Loki Runtime Logs

```bash
bun run logs:loki:up
bun run start
```

- Grafana: `http://localhost:3000` (`admin` / `admin`)
- Default Loki query: `{job="clanker_runtime"}`
- Full setup details: `docs/logs.md`

## 4. Configure in dashboard

Use dashboard to:
- `botName` and persona/prompt behavior.
- Unsolicited reply eagerness separately for initiative vs non-initiative channels, plus reaction eagerness.
- Allowed/blocked channels and users.
- Reply/initiative/reaction permission toggles.
- Standalone-post channel IDs (dedicated bot channels).
- Initiative pacing (`even` or `spontaneous`) and spontaneity.
- Discovery source mix, link frequency, freshness, dedupe window, and topic/source lists.
- Live web search limits (hourly cap, provider order, recency, results/query, pages inspected, and extraction settings).
- Model-directed GIF replies and GIF lookup budget.
- Allowed image/video generation models, simple/complex image routing models, and per-24h media budgets.
- LLM provider and model selection.
- Optional dedicated provider/model for reply follow-up regenerations (web/memory lookup passes).
- Voice runtime mode (`voice_agent`, `openai_realtime`, `gemini_realtime`, or `elevenlabs_realtime`) and provider-specific realtime settings (`voice.elevenLabsRealtime.agentId` is required for ElevenLabs mode). Legacy/stored `stt_pipeline` settings are handled in normalization and runtime-only mode paths.
- Stream-watch ingest guardrails; `/api/voice/stream-ingest/frame` for external relay (`DASHBOARD_TOKEN` or `PUBLIC_API_TOKEN`) or tokenized `/api/voice/share-session/:token/frame`.
- Accumulated API spend tracking.
- Bot actions and memory inspection.

## 5. Notes

- This project stores runtime data in `./data/clanker.db`.
- `memory/YYYY-MM-DD.md` grows append-only with user-message journal entries.
- `memory/MEMORY.md` is periodically curated from durable facts plus recent daily logs.
- Personality is intentionally slangy and playful but constrained by explicit limitations.
- Supported language handling note:
  - Core admission/intent routing is LLM-driven, so non-English input can still be handled there.
  - English-only heuristic fast paths remain for specific detections and are intentionally limited to reduce false positives:
    - `src/voice/voiceDecisionRuntime.ts`: `EN_LOW_SIGNAL_GUARD_TOKENS` (`yo/hi/sup/ey/oi/oy/ha`) and question-word regex (`who/what/when/where/why/how/...`).
    - `src/directAddressConfidence.ts`: `EN_GENERIC_NAME_TOKENS`.
    - `src/voice/voiceSessionHelpers.ts`: wake/vocative heuristics around `EN_VOCATIVE_GREETING_TOKENS`, `EN_VOCATIVE_IGNORE_TOKENS`, `resolvePrimaryWakeToken`, and `resolveMergedWakeToken`.
    - `src/voice/voiceSessionManager.ts`: music intent regexes (`EN_MUSIC_STOP_VERB_RE`, `EN_MUSIC_CUE_RE`, `EN_MUSIC_PLAY_VERB_RE`, `EN_MUSIC_PLAY_QUERY_RE`) and related cleaning regexes in `extractMusicPlayQuery`.
    - `src/memory/memoryHelpers.ts`: English phrase-based memory text cleanup and instruction-like filters (`cleanFactForMemory`, `isInstructionLikeFactText`).
    - `src/botHelpers.ts`: `EN_WEB_SEARCH_OPTOUT_RE` (`do not/search/no ... google/search/look up`).

## 6. Technical Docs

- Architecture and flow diagrams: `docs/technical-architecture.md`
- Claude Code brain session mode: `docs/claude-code-brain-session-mode.md`
- Memory system source of truth: `docs/memory-system.md`
- Replay harness guide (flooding + authoring): `docs/replay-test-suite.md`
- Voice test suites (golden + E2E): `docs/e2e-test-spec.md`
- Initiative creative discovery: `docs/initiative-discovery-spec.md`
- Public HTTPS entrypoint: `docs/public-https-entrypoint-spec.md`
- Screen-share link flow: `docs/screen-share-link-spec.md`
- Runtime logs + local Loki: `docs/logs.md`
