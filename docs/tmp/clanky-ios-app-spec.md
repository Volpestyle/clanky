# Clanky iOS App — Spec

Native SwiftUI observability cockpit for Clanky. Real-time visibility into everything the bot is doing: actions flowing, LLM thinking, voice sessions, tool calls, memory, screen watch — all streamed live through the Cloudflare tunnel.

Target: **iOS 26 / iPhone 17 Pro**

---

## Architecture

```
┌─────────────────────┐         ┌──────────────────────────────┐
│   Clanky iOS App    │  SSE    │  Clanky Backend               │
│                     │◄────────│  (Hono on Bun)                │
│  SwiftUI + Combine  │  REST   │  via Cloudflare Quick Tunnel  │
│  URLSession         │────────►│  https://*.trycloudflare.com  │
└─────────────────────┘         └──────────────────────────────┘
```

### Networking Layer

- **SSE Client**: Persistent `URLSession` streaming connections for real-time data
  - `/api/activity/events` — action stream + stats (3s interval)
  - `/api/voice/events` — voice session state (3s interval) + voice actions
- **REST Client**: On-demand requests for snapshots, memory, history, commands
- **Auth**: `x-dashboard-token` header on all requests
- **Reconnect**: Auto-reconnect on disconnect with exponential backoff (3s base)
- **Background**: `URLSessionConfiguration.background` for SSE persistence when app is backgrounded

### Connection Setup

On launch:
1. User enters tunnel URL + dashboard token (persisted in Keychain)
2. Health check: `GET /api/health`
3. Open both SSE streams
4. Fetch initial state: `/api/stats`, `/api/voice/state`

---

## Data Sources

### SSE Stream 1: Activity (`/api/activity/events`)

| Event | Payload | Cadence |
|-------|---------|---------|
| `activity_snapshot` | `{ actions: Action[], stats: Stats }` | On connect |
| `action_event` | Single `Action` | Real-time |
| `stats_update` | `Stats` object | Every 3s |

**Action shape:**
```swift
struct ClankyAction: Codable, Identifiable {
    let id: Int
    let created_at: String
    let guild_id: String?
    let channel_id: String?
    let message_id: String?
    let user_id: String?
    let kind: String          // 73 distinct kinds
    let content: String?
    let metadata: [String: AnyCodable]?
    let usd_cost: Double?
}
```

**73 Action Kinds** (grouped by domain):

| Domain | Kinds |
|--------|-------|
| **LLM** | `llm_call`, `llm_error`, `llm_tool_call` |
| **Voice** | `voice_session_start`, `voice_session_end`, `voice_turn_in`, `voice_turn_out`, `voice_runtime`, `voice_error`, `voice_warn`, `voice_info`, `voice_soundboard_play` |
| **ASR** | `asr_call`, `asr_error` |
| **TTS** | `tts_call`, `tts_error`, `speech` |
| **Text** | `sent_reply`, `reply_skipped`, `text_runtime`, `direct` |
| **Memory** | `memory_fact`, `memory_embedding_call`, `memory_embedding_error`, `memory_reflection_start`, `memory_reflection_complete`, `memory_reflection_error` |
| **Browser** | `browser_agent_session_turn`, `browser_agent_reasoning`, `browser_agent_final`, `browser_browse_call`, `browser_browse_failed`, `browser_tool_result`, `browser_tool_step`, `browser_session` |
| **Media** | `image_call`, `image_error`, `gif_call`, `gif_error`, `video_call`, `video_error`, `video_context_call`, `video_context_error`, `tiktok`, `youtube`, `url` |
| **Code** | `code_agent_call`, `code_agent_error` |
| **Discovery** | `discovery_feed_snapshot`, `search_call`, `search_error` |
| **Automation** | `automation_created`, `automation_updated`, `automation_post` |
| **Initiative** | `initiative_post`, `initiative_skip` |
| **System** | `bot_error`, `bot_warning`, `bot_runtime`, `daily`, `generic`, `interval`, `membership`, `effect`, `visualizer`, `stream_discovery` |

### SSE Stream 2: Voice (`/api/voice/events`)

| Event | Payload | Cadence |
|-------|---------|---------|
| `voice_state` | `{ activeCount, sessions: VoiceSession[] }` | Every 3s |
| `voice_event` | Single voice action | Real-time |

**VoiceSession** is the richest object — full shape below:

```swift
struct VoiceSession: Codable, Identifiable {
    var id: String { sessionId }
    let sessionId: String
    let guildId: String
    let voiceChannelId: String
    let textChannelId: String
    let startedAt: String
    let lastActivityAt: String
    let maxEndsAt: String?
    let inactivityEndsAt: String?
    let activeInputStreams: Int
    let activeCaptures: [ActiveCapture]
    let participantCount: Int
    let participants: [Participant]
    let membershipEvents: [MembershipEvent]
    let recentTurns: [VoiceTurn]
    let pendingDeferredTurns: Int
    let mode: String
    let botTurnOpen: Bool
    let playbackArm: PlaybackArm?
    let focusedSpeaker: FocusedSpeaker?
    let conversation: Conversation
    let promptState: PromptState?
    let lastGenerationContext: GenerationContext?
    let streamWatch: StreamWatch
    let asrSessions: [AsrSession]?
    let brainTools: [BrainTool]?
    let toolCalls: [ToolCall]?
    let mcpStatus: [McpServer]?
    let batchAsr: BatchAsr?
    let realtime: RealtimeProvider?
    let music: MusicState?
    let latency: SessionLatency?
    let soundboard: SoundboardState
}
```

### REST Endpoints (on-demand)

| Endpoint | Purpose |
|----------|---------|
| `GET /api/health` | Connection check |
| `GET /api/stats` | Runtime stats, cost, performance |
| `GET /api/actions?limit=N&kinds=X&sinceHours=N` | Historical actions |
| `GET /api/voice/state` | Voice state snapshot |
| `GET /api/voice/asr-sessions` | ASR transcription state |
| `GET /api/voice/tool-events` | Tool call events |
| `GET /api/voice/history/sessions` | Past voice sessions |
| `GET /api/voice/history/sessions/:id/events` | Session event replay |
| `GET /api/mcp/status` | MCP server connections |
| `GET /api/memory?guildId=X` | Memory markdown dump |
| `GET /api/memory/search?q=X&guildId=X` | Semantic fact search |
| `GET /api/memory/facts?guildId=X` | Browse all facts |
| `GET /api/memory/subjects?guildId=X` | Memory subjects |
| `GET /api/memory/reflections?guildId=X` | Reflection runs |
| `GET /api/memory/fact-profile?guildId=X&userId=Y` | Loaded fact profile |
| `POST /api/memory/runtime-snapshot` | Full context snapshot |
| `GET /api/agents/browser-sessions` | Browser agent history |
| `GET /api/automations?guildId=X` | Automations list |
| `GET /api/automations/runs?automationId=X` | Automation run history |
| `GET /api/public-https` | Tunnel state |
| `GET /api/guilds` | Discord guilds |
| `GET /api/guilds/:id/channels` | Guild channels |
| `POST /api/voice/join` | Command: join voice channel |
| `PUT /api/memory/facts/:id` | Edit a memory fact |
| `DELETE /api/memory/facts/:id` | Delete a memory fact |

---

## Screen Architecture

### Tab Bar (5 tabs)

```
┌─────┬─────┬─────┬─────┬─────┐
│PULSE│VOICE│BRAIN│MEMORY│ CMD │
└─────┴─────┴─────┴─────┴─────┘
```

---

### Tab 1: PULSE (Activity Feed)

The heartbeat of the app. Every action Clanky takes streams in real-time.

```
┌─────────────────────────────────────────┐
│ ● CONNECTED          $2.47 today   ↻    │
├─────────────────────────────────────────┤
│ ┌─ STATS BAR ─────────────────────────┐ │
│ │  142 actions   3 voice   12 LLM     │ │
│ │  0 errors      8 tools   2 memory   │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ┌─ FILTER CHIPS ──────────────────────┐ │
│ │ ALL  LLM  VOICE  TOOL  MEMORY  ERR │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ▼ LIVE FEED                             │
│ ┌─────────────────────────────────────┐ │
│ │ ◆ llm_call              2s ago     │ │
│ │   claude-opus-4-6 · 3 tools        │ │
│ │   1.2k in / 340 out · $0.008       │ │
│ │   ▸ tap to expand                  │ │
│ ├─────────────────────────────────────┤ │
│ │ ◇ voice_turn_in         5s ago     │ │
│ │   james: "hey clanky what's..."    │ │
│ ├─────────────────────────────────────┤ │
│ │ ◆ llm_tool_call         5s ago     │ │
│ │   web_search("latest rust news")   │ │
│ │   ✓ 1.2s                           │ │
│ ├─────────────────────────────────────┤ │
│ │ ◇ voice_turn_out        8s ago     │ │
│ │   "Here's what I found about..."   │ │
│ ├─────────────────────────────────────┤ │
│ │ ○ sent_reply            12s ago    │ │
│ │   #general · 240 chars             │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

**Behavior:**
- New actions animate in from top with spring physics
- Haptic tap (light) on each new action
- Haptic tap (medium) on errors
- Color-coded left accent per domain (voice=blue, LLM=purple, tool=green, error=red, memory=amber)
- Tap to expand: shows full `content`, `metadata`, prompts if available
- Filter chips toggle which action kinds appear
- Stats bar updates every 3s from stats_update SSE

**Expanded action detail (llm_call):**
```
┌─────────────────────────────────────────┐
│ ◆ llm_call                             │
│                                         │
│ PROVIDER    claude-oauth                │
│ MODEL       claude-opus-4-6             │
│ TOKENS      1,247 in / 340 out          │
│ CACHED      892 read / 0 write          │
│ COST        $0.0084                      │
│ STOP        end_turn                     │
│ TOOLS       web_search, memory_recall,  │
│             play_sound                   │
│ DURATION    2.1s                         │
│                                         │
│ ┌─ PROMPTS ───────────────────────────┐ │
│ │ ▸ System prompt (2.4k chars)       │ │
│ │ ▸ User prompt (180 chars)          │ │
│ │ ▸ Follow-up steps: 2              │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

---

### Tab 2: VOICE (Session Cockpit)

Live view into the active voice session. The command center.

```
┌─────────────────────────────────────────┐
│ VOICE SESSION                 01:23:45  │
│ #voice-chat · 4 participants            │
├─────────────────────────────────────────┤
│ ┌─ PARTICIPANTS ──────────────────────┐ │
│ │ 🔊 james          speaking 3.2s    │ │
│ │ ○  alex           idle             │ │
│ │ ○  sarah          idle             │ │
│ │ 🤖 clanky         listening        │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ┌─ ATTENTION ─────────────────────────┐ │
│ │ MODE: ACTIVE     FOCUSED: james    │ │
│ │ Last reply: 12s ago                │ │
│ │ Last address: 3s ago              │ │
│ │ Thought engine: idle               │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ┌─ LATENCY WATERFALL ────────────────┐ │
│ │ finalized→ASR     ██░░░  45ms     │ │
│ │ ASR→generation    ████░  120ms    │ │
│ │ generation→reply  ██████████ 890ms│ │
│ │ reply→audio       ███░░  80ms     │ │
│ │ ─────────────────────────         │ │
│ │ TOTAL                    1,135ms  │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ┌─ LIVE TRANSCRIPT ──────────────────┐ │
│ │ james: hey clanky what's the       │ │
│ │   latest on the rust compiler?     │ │
│ │ clanky: Here's what I found...     │ │
│ │ james: nice, can you also check... │ │
│ │ ▸ partial: "I was wonder..."       │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ┌─ TOOL CALLS ───────────────────────┐ │
│ │ ✓ web_search     1.2s   success   │ │
│ │ ✓ memory_recall  0.3s   success   │ │
│ │ ⟳ play_sound    ...    running    │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ┌─ MUSIC ────────────────────────────┐ │
│ │ ▶ "Midnight City" — M83           │ │
│ │   youtube · requested by james     │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ┌─ SCREEN WATCH ─────────────────────┐ │
│ │ ● ACTIVE · watching james          │ │
│ │ Frames: 142 · Last: 2s ago        │ │
│ │ Brain context: 6 notes             │ │
│ │                                     │ │
│ │ Latest notes:                      │ │
│ │ • User browsing Rust docs page    │ │
│ │ • Scrolling through trait impl    │ │
│ │ • Code editor visible, editing    │ │
│ │   src/main.rs                      │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ┌─ ASR SESSIONS ─────────────────────┐ │
│ │ james  ● connected  idle: 3.2s    │ │
│ │  partial: "I was wonder..."        │ │
│ │  pending: 2 chunks / 4.1kb        │ │
│ │ alex   ● connected  idle: 45s     │ │
│ │ sarah  ○ disconnected              │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ┌─ MCP SERVERS ──────────────────────┐ │
│ │ ● filesystem   4 tools  connected │ │
│ │ ● brave-search 1 tool   connected │ │
│ │ ○ slack        error: timeout     │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ┌─ REALTIME PROVIDER ────────────────┐ │
│ │ openai · 24kHz in / 24kHz out     │ │
│ │ session: sess_abc123               │ │
│ │ pending turns: 0  drain: no       │ │
│ │ last event: response.done 2s ago  │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

**Behavior:**
- All panels update every 3s from voice_state SSE
- Speaking indicators pulse with animation
- Latency waterfall uses horizontal bar chart with color gradient (green→yellow→red)
- Transcript scrolls to bottom, partial utterances shown in muted italic
- Tool calls show spinner while running, checkmark/X on complete
- Screen watch notes animate in as they're added
- "No active session" state shows recent session history list instead

---

### Tab 3: BRAIN (LLM Thinking)

Deep view into how Clanky is reasoning. Prompt inspection, model context, generation pipeline.

```
┌─────────────────────────────────────────┐
│ BRAIN                                   │
├─────────────────────────────────────────┤
│ ┌─ LAST GENERATION CONTEXT ──────────┐ │
│ │ SOURCE: voice_full_brain            │ │
│ │ MODE: ACTIVE  DIRECT: yes          │ │
│ │ SPEAKER: james                     │ │
│ │                                     │ │
│ │ TRANSCRIPT                         │ │
│ │ "hey clanky what's the latest..."  │ │
│ │                                     │ │
│ │ CONTEXT: 12 messages / 4.2k chars  │ │
│ │ ROSTER: james, alex, sarah         │ │
│ │                                     │ │
│ │ TOOLS AVAILABLE                    │ │
│ │ ● search ● memory ● soundboard    │ │
│ │ ● screen_share ● open_article     │ │
│ │                                     │ │
│ │ LLM CONFIG                         │ │
│ │ claude-oauth · claude-opus-4-6     │ │
│ │ temp: 0.7 · max: 2048             │ │
│ │                                     │ │
│ │ MEMORY FACTS LOADED                │ │
│ │ 3 user facts · 5 relevant facts   │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ┌─ PROMPT INSPECTOR ─────────────────┐ │
│ │ ▸ System Instructions    updated 5s│ │
│ │ ▸ Classifier Prompt      updated 5s│ │
│ │ ▸ Generation Prompt      updated 5s│ │
│ │ ▸ Bridge Prompt          updated 5s│ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ┌─ RECENT LLM CALLS ────────────────┐ │
│ │ (filtered from action feed)        │ │
│ │ ◆ claude-opus-4-6  3 tools  2.1s  │ │
│ │ ◆ gpt-4o           0 tools  0.8s  │ │
│ │ ◆ claude-opus-4-6  1 tool   1.5s  │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ┌─ TOOL CHAIN VISUALIZER ───────────┐ │
│ │                                     │ │
│ │ llm_call ──► web_search ──► llm    │ │
│ │              1.2s           ──►     │ │
│ │         ──► memory_recall   reply  │ │
│ │              0.3s                   │ │
│ │                                     │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ┌─ MODEL CONTEXT BUDGET ────────────┐ │
│ │ GENERATION                         │ │
│ │ Turns: 8/20 sent  Context: 4.2k   │ │
│ │ ████████░░░░░░░░░░░░  40%         │ │
│ │                                     │ │
│ │ CLASSIFIER                         │ │
│ │ Turns: 12/20       History: 2.1k   │ │
│ │ ████████████░░░░░░░░  60%         │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

**Behavior:**
- Prompt inspector: tap to expand full prompt text in a scrollable sheet
- Tool chain visualizer: animated flow diagram showing LLM → tool → LLM sequences
- Context budget bars animate as they change
- LLM calls list auto-filters from the action stream (kinds: llm_call, llm_error, llm_tool_call)

---

### Tab 4: MEMORY

Browse and search Clanky's durable fact store.

```
┌─────────────────────────────────────────┐
│ MEMORY                    142 facts     │
├─────────────────────────────────────────┤
│ ┌─ SEARCH ───────────────────────────┐ │
│ │ 🔍 Search facts...                 │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ┌─ SUBJECTS ─────────────────────────┐ │
│ │ james (34) · alex (22) · guild (18)│ │
│ │ sarah (12) · clanky (8) · ...      │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ▼ FACTS                                │
│ ┌─────────────────────────────────────┐ │
│ │ james · preference · 0.92          │ │
│ │ "Prefers concise responses without │ │
│ │  unnecessary preamble"             │ │
│ │ evidence: "stop being so verbose"  │ │
│ ├─────────────────────────────────────┤ │
│ │ james · knowledge · 0.85          │ │
│ │ "Senior developer, expert in Rust  │ │
│ │  and TypeScript"                   │ │
│ ├─────────────────────────────────────┤ │
│ │ guild · lore · 0.78               │ │
│ │ "Server is focused on game dev     │ │
│ │  and indie projects"               │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ┌─ REFLECTIONS ──────────────────────┐ │
│ │ Last run: 2h ago · 12 facts merged │ │
│ │ ▸ View reflection history          │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

**Behavior:**
- Semantic search powered by `/api/memory/search`
- Subject chips filter facts by person/entity
- Swipe to delete a fact
- Tap to edit (inline sheet with fact text, type, confidence slider)
- Pull to refresh memory markdown

---

### Tab 5: CMD (Command & Control)

Remote control for Clanky. Issue commands, view system status, configure.

```
┌─────────────────────────────────────────┐
│ COMMAND                                 │
├─────────────────────────────────────────┤
│ ┌─ CONNECTION ───────────────────────┐ │
│ │ ● CONNECTED                        │ │
│ │ https://abc-xyz.trycloudflare.com  │ │
│ │ Activity SSE: open                 │ │
│ │ Voice SSE: open                    │ │
│ │ Latency: 45ms                      │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ┌─ QUICK ACTIONS ────────────────────┐ │
│ │ ┌──────────┐  ┌──────────────────┐ │ │
│ │ │ JOIN     │  │ LEAVE VOICE     │ │ │
│ │ │ VOICE    │  │                  │ │ │
│ │ └──────────┘  └──────────────────┘ │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ┌─ SYSTEM STATUS ────────────────────┐ │
│ │ GUILDS: 3 connected                │ │
│ │ UPTIME: 4d 12h 33m                │ │
│ │ COST TODAY: $2.47                  │ │
│ │ ACTIONS (24h): 1,842               │ │
│ │ VOICE SESSIONS (24h): 7            │ │
│ │ TUNNEL: ready (pid 12345)          │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ┌─ GUILDS ───────────────────────────┐ │
│ │ ▸ The Workshop        142 members  │ │
│ │ ▸ Game Dev Crew       89 members   │ │
│ │ ▸ Test Server         12 members   │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ┌─ BROWSER AGENTS ──────────────────┐ │
│ │ ▸ 3 sessions (24h)                │ │
│ │   Last: research task · 12m ago   │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ┌─ AUTOMATIONS ──────────────────────┐ │
│ │ ▸ 5 active · 2 paused             │ │
│ │   Last post: 2h ago               │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ┌─ VOICE SESSION HISTORY ───────────┐ │
│ │ Today                              │ │
│ │ ▸ 01:23:45 · #voice · 4 people   │ │
│ │ ▸ 00:45:12 · #music · 2 people   │ │
│ │ Yesterday                          │ │
│ │ ▸ 02:10:33 · #voice · 6 people   │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

---

## iOS-Native Features

### Live Activities (Lock Screen)

When a voice session is active, show a Live Activity on the Lock Screen:

```
┌─────────────────────────────────────────┐
│ 🤖 Clanky · #voice-chat                │
│ 4 participants · ACTIVE · 01:23:45     │
│ Last: "Here's what I found about..."   │
└─────────────────────────────────────────┘
```

Update every SSE voice_state tick. End when session ends.

### Widgets (Home Screen)

**Small widget:** Connection status + action count + cost today
**Medium widget:** Last 3 actions with kind icons + voice session status
**Large widget:** Mini activity feed with last 8 actions

### Haptics

| Event | Haptic |
|-------|--------|
| New action (normal) | `.light` impact |
| Error action | `.medium` impact + `.warning` notification |
| Voice session start/end | `.success` notification |
| Tool call complete | `.light` impact |
| Direct address ("hey clanky") | `.heavy` impact |
| LLM call with tools | `.soft` impact |

### Notifications (Background)

When app is backgrounded, push local notifications for:
- Voice session start/end
- Errors (bot_error, llm_error)
- Direct address in voice
- Automation posts

---

## Design Language

**Aesthetic**: Bloomberg terminal meets iOS 26 liquid glass. Data-dense monospaced readouts,
thin borders, uppercase labels — rendered through translucent glass materials with organic depth.
Inspired by Alpha Arena / Nof1's financial dashboard aesthetic.

### Core Principles

1. **Monospaced everything** — SF Mono is the primary font for all data, values, labels
2. **Light translucent base** — iOS 26 `.glassEffect()` / liquid glass materials, not dark mode
3. **Thin 1px borders** — crisp hairline dividers, not chunky rounded cards
4. **Data density** — every pixel carries information, no decorative whitespace
5. **Red/green semantic coloring** — red for errors/negative, green for success/positive
6. **Uppercase tracking-wide headers** — "ACTIVE POSITIONS" not "Active Positions"
7. **Color-coded left accent strips** — thin 3px left border on action cards per domain
8. **Zero decoration** — no gradients, no drop shadows, no emoji. Let the glass do the work

### Color Palette (Action Domains)

Muted, sophisticated palette that works on translucent glass:

| Domain | Color | Hex | Usage |
|--------|-------|-----|-------|
| Voice | Slate Blue | `#475569` | Left accent + labels |
| LLM | Deep Purple | `#6D28D9` | Left accent + labels |
| Tool | Forest | `#059669` | Left accent + success values |
| Memory | Warm Gray | `#78716C` | Left accent + labels |
| Error | Signal Red | `#DC2626` | Left accent + error values + negative numbers |
| Text | Charcoal | `#374151` | Left accent + labels |
| Media | Rose | `#BE185D` | Left accent + labels |
| System | Light Gray | `#9CA3AF` | Left accent + muted labels |
| Browser | Indigo | `#4338CA` | Left accent + labels |
| Discovery | Dark Teal | `#0D9488` | Left accent + labels |
| Positive | Green | `#16A34A` | Positive values, success states |
| Negative | Red | `#DC2626` | Negative values, error states |

### Typography

All monospaced. This is a terminal, not a consumer app.

- **Panel headers**: SF Mono, 10pt, weight: medium, tracking: 0.12em, uppercase, `Color.secondary`
- **Metric values**: SF Mono, 24pt, weight: bold
- **Data labels**: SF Mono, 11pt, weight: regular, `Color.secondary`
- **Data values**: SF Mono, 13pt, weight: medium, `Color.primary`
- **Body/content**: SF Mono, 12pt, weight: regular
- **Timestamps**: SF Mono, 10pt, weight: regular, `Color.tertiary`
- **Tab labels**: SF Mono, 10pt, weight: semibold, uppercase

### Panels (Liquid Glass)

```swift
// Primary panel — translucent glass container
.glassEffect()
.clipShape(RoundedRectangle(cornerRadius: 8))
.overlay(
    RoundedRectangle(cornerRadius: 8)
        .strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.5)
)

// Panel header — thin bottom border separator
HStack {
    Text("PANEL LABEL")
        .font(.system(.caption2, design: .monospaced, weight: .medium))
        .tracking(1.2)
        .foregroundStyle(.secondary)
}
.padding(.horizontal, 12)
.padding(.vertical, 8)
// thin hairline below
Divider()
```

- Corner radius: 8pt (subtle, not bubbly)
- Padding: 12pt content area
- Border: 0.5pt hairline, primary color at 8% opacity
- No drop shadows — glass material handles depth

### Action Row Pattern

```
┌─┬────────────────────────────────────────┐
│▌│ LLM_CALL                     2s ago   │
│▌│ claude-opus-4-6 · 3 tools             │
│▌│ 1,247 in / 340 out         $0.0084   │
└─┴────────────────────────────────────────┘
 ^ 3px domain-colored left accent
```

- Left accent: 3px wide, domain color, full height
- Kind label: SF Mono, uppercase, bold
- Timestamp: right-aligned, muted
- Thin hairline between rows, not card separation

### Animations

Restrained — let the data speak:

- New action insertion: `.spring(response: 0.3, dampingFraction: 0.8)` (fast, minimal bounce)
- Stats counter changes: `.contentTransition(.numericText())` (iOS 17+ number morphing)
- Latency bars: `.animation(.easeInOut(duration: 0.3))` width transition
- Speaking indicators: subtle opacity pulse (1.0 → 0.6 → 1.0, 2s loop)
- Panel expand/collapse: `.spring(response: 0.3, dampingFraction: 0.9)` (snappy)
- Connection status dot: `.easeInOut(duration: 0.4)` color transition
- Glass material: system-managed translucency animations
- New items fade in: `.transition(.opacity.combined(with: .move(edge: .top)))`

### iOS 26 Liquid Glass Integration

- Tab bar: `.tabBarStyle(.liquidGlass)` — translucent glass tab bar
- Navigation bar: glass material toolbar
- Panels: `.glassEffect()` on all content containers
- Status bar area: glass material header strip
- The light, airy glass aesthetic contrasts beautifully with the dense monospaced data

---

## Project Structure

```
ClankyApp/
├── ClankyApp.swift                    // App entry, tab bar
├── Info.plist
├── Assets.xcassets/
│
├── Core/
│   ├── ClankyClient.swift             // REST + SSE networking
│   ├── SSEClient.swift                // Generic SSE parser + reconnect
│   ├── KeychainStore.swift            // Token + URL persistence
│   └── HapticEngine.swift             // Centralized haptic feedback
│
├── Models/
│   ├── ClankyAction.swift             // Action + ActionKind enum
│   ├── VoiceSession.swift             // Full voice session model
│   ├── Stats.swift                    // Runtime stats
│   ├── MemoryFact.swift               // Durable fact model
│   └── Connection.swift               // Connection state
│
├── Stores/
│   ├── ActivityStore.swift            // @Observable, manages action stream
│   ├── VoiceStore.swift               // @Observable, manages voice state
│   ├── MemoryStore.swift              // @Observable, manages memory facts
│   └── ConnectionStore.swift          // @Observable, manages connection
│
├── Views/
│   ├── Pulse/
│   │   ├── PulseTab.swift             // Activity feed
│   │   ├── ActionRow.swift            // Single action cell
│   │   ├── ActionDetail.swift         // Expanded action sheet
│   │   ├── StatsBar.swift             // Top stats summary
│   │   └── FilterChips.swift          // Action kind filter
│   │
│   ├── Voice/
│   │   ├── VoiceTab.swift             // Session cockpit
│   │   ├── ParticipantList.swift      // Speaking indicators
│   │   ├── LatencyWaterfall.swift     // Latency bar chart
│   │   ├── TranscriptFeed.swift       // Live transcript
│   │   ├── ToolCallList.swift         // Tool invocations
│   │   ├── ScreenWatchPanel.swift     // Screen watch state + notes
│   │   ├── MusicPanel.swift           // Now playing
│   │   ├── AsrSessionList.swift       // ASR connection state
│   │   ├── McpStatusPanel.swift       // MCP server health
│   │   └── RealtimePanel.swift        // Provider connection state
│   │
│   ├── Brain/
│   │   ├── BrainTab.swift             // LLM thinking view
│   │   ├── GenerationContext.swift    // Last generation snapshot
│   │   ├── PromptInspector.swift      // Expandable prompt viewer
│   │   ├── ToolChainVisualizer.swift  // Tool flow diagram
│   │   └── ContextBudget.swift        // Token/turn budget bars
│   │
│   ├── Memory/
│   │   ├── MemoryTab.swift            // Fact browser
│   │   ├── FactRow.swift              // Single fact cell
│   │   ├── FactEditor.swift           // Edit sheet
│   │   ├── SubjectChips.swift         // Subject filter
│   │   └── ReflectionHistory.swift    // Reflection runs
│   │
│   ├── Command/
│   │   ├── CommandTab.swift           // Control panel
│   │   ├── ConnectionPanel.swift      // Connection health
│   │   ├── QuickActions.swift         // Join/leave/etc
│   │   ├── GuildList.swift            // Server browser
│   │   ├── SessionHistory.swift       // Past voice sessions
│   │   └── AutomationList.swift       // Automations
│   │
│   ├── Setup/
│   │   └── SetupView.swift            // First-run: tunnel URL + token
│   │
│   └── Shared/
│       ├── PanelView.swift            // Reusable panel container
│       ├── StatusDot.swift            // Animated status indicator
│       ├── RelativeTimestamp.swift     // "3s ago" text
│       ├── DomainColor.swift          // Action kind → color mapping
│       └── MetricText.swift           // Animated number display
│
├── LiveActivity/
│   ├── ClankyWidgetBundle.swift
│   ├── VoiceSessionLiveActivity.swift
│   └── ClankyWidgets.swift            // Home screen widgets
│
└── Extensions/
    ├── Color+Domain.swift
    └── JSONDecoder+Clanky.swift
```

---

## Implementation Priority

### Phase 1: Foundation
1. SSE client + reconnect logic
2. ClankyClient (REST + auth)
3. Setup view (URL + token entry)
4. ActivityStore + PulseTab (live action feed)
5. Basic action row with domain colors

### Phase 2: Voice Cockpit
6. VoiceStore + VoiceTab
7. Participant list with speaking indicators
8. Latency waterfall
9. Live transcript feed
10. Tool call list

### Phase 3: Brain + Memory
11. BrainTab with generation context
12. Prompt inspector
13. MemoryTab with fact browser + search
14. Fact editing

### Phase 4: Command + Polish
15. CommandTab with system status
16. Quick actions (join voice)
17. Haptic engine integration
18. Animations and transitions

### Phase 5: iOS Extras
19. Live Activities for voice sessions
20. Home screen widgets
21. Background notifications
