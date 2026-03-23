# Clanky Self Technical Architecture

This document explains the live runtime shape of the experimental selfbot: where core decisions happen, how settings flow through the system, and which modules own text, voice, memory, tools, persistence, and the Rust media plane.

Docs map: [`../README.md`](../README.md)
Unified media product surface: [`../capabilities/media.md`](../capabilities/media.md)
Product relationship tiers: [`relationship-model.md`](relationship-model.md)

For the `clankvox`-local transport/media docs, start at [`../../src/voice/clankvox/README.md`](../../src/voice/clankvox/README.md).

Canonical companion docs:

- [`../reference/settings.md`](../reference/settings.md)
- [`presence-and-attention.md`](presence-and-attention.md)
- [`activity.md`](activity.md)
- [`initiative.md`](initiative.md)
- [`../voice/voice-provider-abstraction.md`](../voice/voice-provider-abstraction.md)
- [`presets.md`](presets.md)

## 1. High-Level Components

Account/runtime model:

- one Discord user account is the primary runtime identity
- Bun owns gateway/session orchestration, prompts, tools, memory, and the dashboard
- `clankvox` is the Rust voice/media subprocess that owns Discord RTP, Opus, DAVE, music, TTS pacing, and native stream-watch media transport
- the product model is one Discord-native community entity: a deep personal assistant for the operator, and a higher-trust collaborator for explicitly approved others, not separate public/private bots

Code entrypoint:

- `src/app.ts`: bootstraps storage, services, the selfbot runtime, `clankvox`, and the dashboard server

Core runtime:

- `src/bot.ts`: Discord orchestration and scheduler entrypoints for the selfbot runtime
- `src/bot/*`: text reply admission, reply pipeline, ambient text initiative, automations, permissions, continuity, memory slices, and message history
- `src/settings/settingsSchema.ts`: canonical persisted settings schema
- `src/settings/agentStack.ts`: preset resolution and runtime binding helpers
- `src/settings/dashboardSettingsState.ts`: dashboard settings envelope (`intent`, `effective`, `bindings`)
- `src/settings/settingsIntent.ts`: intent minimization before persistence
- `src/store/settingsNormalization.ts`: settings normalization into the canonical shape
- `src/llm.ts`: provider/runtime abstraction for generation, embeddings, image/video generation, ASR, and TTS
- `src/memory/*`: durable memory extraction, storage, lookup, and reflection
- `src/services/discovery.ts`: passive feed collection for the unified initiative cycle
- `src/voice/*`: session lifecycle, capture, turn processing, voice-side admission, tool dispatch, output, and ambient voice thought delivery
- `src/voice/clankvox/*`: Rust media-plane subprocess for Discord voice transport, DAVE lifecycle, RTP/media parsing, and native screen-watch receive
- `src/tools/*`: shared text/voice tool schemas and execution wrappers
- `src/agents/*`: browser and code-agent runtimes
- `src/dashboard.ts` and `dashboard/src/*`: REST control plane and dashboard UI

Behaviorally, the selfbot is documented as one shared attention system with text and voice spokes. That attention layer is currently implemented across several modules rather than one single package: text reply admission and recent windows, initiative, voice reply admission, thought generation, and music/floor overlays.

Permissioning and capability depth are part of that same product shape: community-safe capabilities are broadly available in shared Discord contexts, higher-trust collaborator capabilities are intentionally gated for approved users and resources, and owner-only device powers stay local to the operator's instance. The product-level relationship model is documented in [`relationship-model.md`](relationship-model.md).

## 2. Runtime Lifecycle

![Runtime Lifecycle](../diagrams/runtime-lifecycle.png)
<!-- source: docs/diagrams/runtime-lifecycle.mmd -->

At a high level:

1. settings are loaded and normalized
2. Discord gateway events and schedulers enter `src/bot.ts`
3. shared conversational attention is shaped by direct address, recent engagement, and ambient cadence
4. active text turns route into immediate reply admission, ambient text falls through to the initiative cycle, and voice sessions route into their domain handlers
5. the LLM/tool layer is consulted only after deterministic guardrails pass
6. actions and messages are persisted back into SQLite and memory logs

Text and voice are separate transports under that shared attention layer. Music playback, wake latch, and barge-in are overlays on the voice side, not separate attention modes.

## 3. Tool Orchestration

The orchestrator is still tool-using and LLM-driven. The preset system resolves which external runtimes back those capabilities.

Shared tool schemas in `src/tools/sharedToolSchemas.ts` are concise capability contracts. The local non-MCP tool registry in `src/tools/toolRegistry.ts` is the central source of truth for which local tools exist on the reply and provider-native voice surfaces. Tool descriptions state what the tool does and the key contrast with nearby tools. Cross-modal tool-choice guidance lives in `src/prompts/toolPolicy.ts`; the text prompt, voice prompt, and provider-native realtime instructions all consume that shared policy and then add modality-specific constraints locally.

Core shared conversational tools:

- `conversation_search`
- `memory_write`
- `web_search`
- `web_scrape`
- `browser_browse`
- `code_task`
- media generation tools

Reply-loop conditional tools:

- `memory_search`
- `image_lookup`
- `start_screen_watch`

Voice-centric tools:

- `music_*`
- `play_soundboard`
- `join_voice_channel` / `leave_voice_channel`

Core routing:

- local tool registry: `src/tools/toolRegistry.ts`
- text: `src/tools/replyTools.ts`
- voice: `src/voice/voiceToolCallInfra.ts` and `src/voice/voiceToolCallDispatch.ts`
- browser tasks: `src/tools/browserTaskRuntime.ts`
- code tasks: `src/agents/codeAgent.ts`

Current voice dispatch modules:

- `src/voice/voiceToolCallMemory.ts`
- `src/voice/voiceToolCallMusic.ts`
- `src/voice/voiceToolCallWeb.ts`
- `src/voice/voiceToolCallAgents.ts`

Search runtime is resolved in `src/services/search.ts`:

- `openai_native_web_search`: hosted OpenAI Responses API lookup via the `web_search_preview` tool
- `local_external_search`: local provider-ordered search through Brave / SerpApi plus direct page-summary reads

There is no separate directive tool handler in the live architecture.

## 4. Settings Flow

The canonical settings contract now lives in [`../reference/settings.md`](../reference/settings.md).

At a high level:

- the store persists authored `intent`, not materialized runtime state
- normalization produces the fully resolved `effective` runtime object
- dashboard/runtime helpers are exposed as derived `bindings`
- dashboard saves use compare-and-swap on `settings.updated_at`
- persistence and live-session application are separate outcomes

![Settings Flow](../diagrams/settings-flow.png)
<!-- source: docs/diagrams/settings-flow.mmd -->

## 5. Persistence Model

Main runtime stores:

- `data/clanker.db`: SQLite database
- `memory/YYYY-MM-DD.md`: append-only daily logs
- `memory/MEMORY.md`: operator-facing memory snapshot

Important tables:

- `settings` (`key = 'runtime_settings'` stores authored settings intent; `updated_at` is the dashboard save version)
- `messages`
- `actions`
- `memory_facts`
- `memory_fact_vectors_native`
- `shared_links`
- `automations`
- `automation_runs`
- `response_triggers`

![Data Model](../diagrams/data-model.png)
<!-- source: docs/diagrams/data-model.mmd -->

## 6. Text Reply Flow

Entrypoint: Discord `messageCreate` handling in `src/bot.ts` for the selfbot user session.

This fork is message-first, but slash/app commands remain intentional fallback control surfaces for directly invoking capabilities when explicit operator control is useful. They complement the primary conversational surface rather than replacing it.

Main stages:

1. permission and channel checks
2. reply admission
3. continuity and memory assembly
4. LLM/tool loop
5. delivery and persistence

The user-facing activity model for these paths is documented in [`activity.md`](activity.md).

![Message Event Flow](../diagrams/message-event-flow.png)
<!-- source: docs/diagrams/message-event-flow.mmd -->

## 7. Voice Runtime

Voice is split into independent layers:

- capture and turn promotion
- transcription
- reply admission
- generation and tool ownership
- output / barge-in
- proactive voice thought generation

These layers are the voice spoke of the shared attention model. They decide how attention becomes audible in a room; they do not define a separate voice-only mind.

Transport ownership in this fork:

- Bun owns Discord session lifecycle, turn orchestration, tools, and settings application
- `clankvox` owns the Discord media plane: voice sockets, Opus/RTP, DAVE, queued audio output, and native Go Live stream receive/send
- the Go Live stream-server legs are documented as additional `clankvox` transport roles in [`../archive/selfbot-stream-watch.md`](../archive/selfbot-stream-watch.md) and [`../voice/discord-streaming.md`](../voice/discord-streaming.md)

Canonical public surfaces:

- transport/runtime: `agentStack.runtimeConfig.voice.*`
- conversation behavior: `voice.conversationPolicy.*`
- admission: `voice.admission.*`
- transcription: `voice.transcription.*`
- session limits: `voice.sessionLimits.*`
- proactive cadence: `initiative.voice.*`

Voice-specific docs:

- [`../voice/voice-provider-abstraction.md`](../voice/voice-provider-abstraction.md)
- [`../voice/voice-capture-and-asr-pipeline.md`](../voice/voice-capture-and-asr-pipeline.md)
- [`../voice/voice-client-and-reply-orchestration.md`](../voice/voice-client-and-reply-orchestration.md)
- [`../voice/voice-output-and-barge-in.md`](../voice/voice-output-and-barge-in.md)

## 8. Unified Initiative Flow

Ambient text delivery is owned by `src/bot/initiativeEngine.ts`.

The runtime splits responsibility like this:

- `permissions.replies.replyChannelIds`: canonical eligible initiative channel pool
- `initiative.text.*`: initiative cadence, budgets, and tool-loop limits
- `initiative.discovery.*`: feed collection, self-curation, and media infrastructure
- `src/services/discovery.ts`: gathers passive feed candidates

The model decides:

- whether to post now, hold a thought for later, or drop it
- which eligible channel fits
- whether to use tools
- whether to include links
- whether to request media

This is the text spoke's ambient delivery path. The corresponding voice spoke is the voice thought engine.

Canonical references:

- [`initiative.md`](initiative.md)
- [`activity.md`](activity.md)

## 9. Memory Model

Durable memory is centered on `memory_facts`.

Facts use dual scope:
- `scope='user'` for user-portable facts (`guild_id=NULL`, optional `user_id` owner)
- `scope='guild'` for server-specific lore/rules (`guild_id` required)

Current behavioral guidance model:

- `guidance` facts: always-on operating/persona guidance
- `behavioral` facts: retrieved by relevance

There is no separate directive store in the live runtime.

Relevant modules:

- `src/memory/memoryManager.ts`
- `src/memory/memoryToolRuntime.ts`
- `src/bot/memorySlice.ts`
- `src/prompts/promptText.ts`
- `src/prompts/promptVoice.ts`

## 10. Dashboard And Control Plane

The dashboard serves as the live control plane for:

- reading and writing settings
- inspecting memory
- inspecting actions and stats
- resetting to preset defaults
- viewing voice/session data

Key server entrypoints:

- `GET /api/settings`
- `PUT /api/settings`
- `POST /api/settings/preset-defaults`
- `GET /api/stats`
- `GET /api/actions`
- memory and voice history endpoints
- `DELETE /api/memory/guild` for confirmed community-memory purges within a guild

## 11. Latency-Critical Model Choices

The main levers that change cost and latency are:

- resolved orchestrator binding
- `interaction.replyGeneration.*` (temperature, max output tokens, reasoning effort)
- follow-up execution policy
- `agentStack.runtimeConfig.voice.runtimeMode`
- `agentStack.runtimeConfig.voice.generation`
- `voice.conversationPolicy.replyPath`
- `voice.admission.mode`

Voice classifier provider/model binding is resolved through preset defaults or `agentStack.overrides.voiceAdmissionClassifier`.

## 12. Action Log Kinds

Common action kinds include:

- `sent_reply`
- `sent_message`
- `reply_skipped`
- `initiative_post`
- `automation_post`
- `llm_call`
- `llm_error`
- `image_call`
- `video_call`
- `voice_error`

These power stats, diagnostics, and initiative/discovery feedback loops.
