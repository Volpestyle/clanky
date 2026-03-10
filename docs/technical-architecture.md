# Clanker Conk Technical Architecture

This document explains the live runtime shape of the bot: where core decisions happen, how settings flow through the system, and which modules own text, voice, memory, tools, and persistence.

Canonical companion docs:

- `docs/clanker-activity.md`
- `docs/initiative-unified-spec.md`
- `docs/voice/voice-provider-abstraction.md`
- `docs/preset-system-spec.md`

## 1. High-Level Components

Code entrypoint:

- `src/app.ts`: bootstraps storage, services, bot, and dashboard server

Core runtime:

- `src/bot.ts`: Discord orchestration and scheduler entrypoints
- `src/bot/*`: reply admission, reply pipeline, initiative, automations, permissions, continuity, memory slices, and message history
- `src/settings/settingsSchema.ts`: canonical persisted settings schema
- `src/settings/agentStack.ts`: preset resolution and runtime binding helpers
- `src/store/settingsNormalization.ts`: settings normalization into the canonical shape
- `src/llm.ts`: provider/runtime abstraction for generation, embeddings, image/video generation, ASR, and TTS
- `src/memory/*`: durable memory extraction, storage, lookup, and reflection
- `src/services/discovery.ts`: passive feed collection for the unified initiative cycle
- `src/voice/*`: session lifecycle, capture, turn processing, admission, tool dispatch, output, and thought engine
- `src/tools/*`: shared text/voice tool schemas and execution wrappers
- `src/agents/*`: browser and code-agent runtimes
- `src/dashboard.ts` and `dashboard/src/*`: REST control plane and dashboard UI

## 2. Runtime Lifecycle

![Runtime Lifecycle](diagrams/runtime-lifecycle.png)
<!-- source: docs/diagrams/runtime-lifecycle.mmd -->

At a high level:

1. settings are loaded and normalized
2. Discord events and schedulers enter `src/bot.ts`
3. text replies, initiative, automations, and voice sessions route into their domain handlers
4. the LLM/tool layer is consulted only after deterministic guardrails pass
5. actions and messages are persisted back into SQLite and memory logs

## 3. Tool Orchestration

The orchestrator is still tool-using and LLM-driven. The preset system resolves which external runtimes back those capabilities.

Shared tool schemas in `src/tools/sharedToolSchemas.ts` are concise capability contracts. Tool descriptions state what the tool does and the key contrast with nearby tools; longer routing policy and conversational guidance live in prompts and runtime docs.

Shared conversational tools:

- `conversation_search`
- `memory_write`
- `web_search`
- `browser_browse`
- `code_task`
- media generation tools

Text-only conversational tool:

- `memory_search`

Core routing:

- text: `src/tools/replyTools.ts`
- voice: `src/voice/voiceToolCalls.ts` and `src/voice/voiceToolCallDispatch.ts`
- browser tasks: `src/tools/browserTaskRuntime.ts`
- code tasks: `src/agents/codeAgent.ts`

Current voice dispatch modules:

- `src/voice/voiceToolCallMemory.ts`
- `src/voice/voiceToolCallMusic.ts`
- `src/voice/voiceToolCallWeb.ts`
- `src/voice/voiceToolCallAgents.ts`

Hosted OpenAI web lookup is implemented in `src/services/search.ts` through the Responses API `web_search_preview` tool.

There is no separate directive tool handler in the live architecture.

## 4. Settings Flow

Settings are written through the dashboard API, normalized in `normalizeSettings()`, and then read lazily at decision time.

Canonical top-level settings groups:

- `identity`
- `persona`
- `prompting`
- `permissions`
- `interaction`
- `agentStack`
- `memory`
- `memoryLlm`
- `initiative`
- `voice`
- `media`
- `music`
- `automations`

Preset-driven runtime surfaces:

- `agentStack.preset`
- `agentStack.overrides`
- `agentStack.runtimeConfig.research`
- `agentStack.runtimeConfig.browser`
- `agentStack.runtimeConfig.voice`
- `agentStack.runtimeConfig.devTeam`

Nested voice surfaces:

- `voice.conversationPolicy.*`
- `voice.admission.*`
- `voice.transcription.*`
- `voice.channelPolicy.*`
- `voice.sessionLimits.*`
- `initiative.voice.*`

Normalization responsibilities:

- clamp numeric ranges
- sanitize lists and strings
- normalize incoming settings into canonical nested fields
- apply preset defaults when canonical fields are absent

![Settings Flow](diagrams/settings-flow.png)
<!-- source: docs/diagrams/settings-flow.mmd -->

## 5. Persistence Model

Main runtime stores:

- `data/clanker.db`: SQLite database
- `memory/YYYY-MM-DD.md`: append-only daily logs
- `memory/MEMORY.md`: operator-facing memory snapshot

Important tables:

- `settings`
- `messages`
- `actions`
- `memory_facts`
- `memory_fact_vectors_native`
- `shared_links`
- `lookup_context`
- `automations`
- `automation_runs`
- `response_triggers`

![Data Model](diagrams/data-model.png)
<!-- source: docs/diagrams/data-model.mmd -->

## 6. Text Reply Flow

Entrypoint: Discord `messageCreate` handling in `src/bot.ts`.

Main stages:

1. permission and channel checks
2. reply admission
3. continuity and memory assembly
4. LLM/tool loop
5. optional follow-up passes
6. delivery and persistence

The user-facing activity model for these paths is documented in `docs/clanker-activity.md`.

![Message Event Flow](diagrams/message-event-flow.png)
<!-- source: docs/diagrams/message-event-flow.mmd -->

## 7. Voice Runtime

Voice is split into independent layers:

- capture and turn promotion
- transcription
- reply admission
- generation and tool ownership
- output / barge-in
- proactive voice thought generation

Canonical public surfaces:

- transport/runtime: `agentStack.runtimeConfig.voice.*`
- conversation behavior: `voice.conversationPolicy.*`
- admission: `voice.admission.*`
- transcription: `voice.transcription.*`
- session limits: `voice.sessionLimits.*`
- proactive cadence: `initiative.voice.*`

Voice-specific docs:

- `docs/voice/voice-provider-abstraction.md`
- `docs/voice/voice-capture-and-asr-pipeline.md`
- `docs/voice/voice-client-and-reply-orchestration.md`
- `docs/voice/voice-output-and-barge-in.md`

## 8. Unified Initiative Flow

Text proactivity is owned by `src/bot/initiativeEngine.ts`.

The runtime splits responsibility like this:

- `permissions.replies.replyChannelIds`: canonical eligible initiative channel pool
- `initiative.text.*`: initiative cadence, budgets, and tool-loop limits
- `initiative.discovery.*`: feed collection, self-curation, and media infrastructure
- `src/services/discovery.ts`: gathers passive feed candidates

The model decides:

- whether to post
- which eligible channel fits
- whether to use tools
- whether to include links
- whether to request media

Canonical references:

- `docs/initiative-unified-spec.md`
- `docs/clanker-activity.md`

## 9. Memory Model

Durable memory is centered on `memory_facts`.

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

## 11. Latency-Critical Model Choices

The main levers that change cost and latency are:

- resolved orchestrator binding
- `interaction.replyGeneration.*`
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
