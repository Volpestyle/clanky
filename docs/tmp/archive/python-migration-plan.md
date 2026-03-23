# Migration Plan: Bun/TypeScript → Python

## Why

- Python owns the local AI ecosystem: `transformers`, `ollama`, `llama-cpp-python`, `vllm`, `faster-whisper`, `sentence-transformers`, `torch`/`torchaudio`.
- Staying in TS means shelling out to Python processes for local inference, adding another IPC layer. Python eliminates that indirection.
- No meaningful performance loss: latency-sensitive paths are in Rust (clankvox) or external APIs. The orchestration layer is I/O-bound glue code.

## Performance: Bun vs Python

| Concern | Impact |
|---|---|
| **Raw event loop throughput** | Bun's event loop is faster than Python's asyncio. But the bottleneck is LLM API latency (hundreds of ms to seconds), not event loop speed. Doesn't matter. |
| **IPC audio hot path** | `_processStdoutChunk` parses binary frames from clankvox. Python handles this fine with `struct.unpack` — it's I/O-bound, not CPU-bound. Rust does the real work. |
| **Concurrent WebSocket connections** | Multiple realtime WS connections (OpenAI, Gemini, ElevenLabs, xAI). Python asyncio + `websockets` handles this well. No degradation. |
| **SQLite + sqlite-vec** | Python has excellent SQLite support (`sqlite3` stdlib, `apsw`). `sqlite-vec` has a Python package. No issue. |
| **Dashboard (Hono)** | Replace with FastAPI or Starlette. Equivalent or better. |
| **Startup time** | Python ~1-2s vs Bun ~200ms. Irrelevant for a long-running bot. |
| **Memory** | Python uses more. Negligible for a single bot instance. |

## Can TS Run Local LLMs?

Yes, technically — `node-llama-cpp`, Ollama HTTP, ONNX Runtime for Node, `transformers.js`. But TS can *call* local models via HTTP; it cannot be the *host* for local AI workloads. You'd always shell out to Python processes. If Python is the AI runtime anyway, having orchestration in Python removes an architectural seam.

## Current Architecture

| Layer | Owner |
|---|---|
| Realtime media transport (Opus, RTP, DAVE, 20ms ticks) | **Rust (clankvox)** |
| Everything else (Discord, LLM, tools, memory, dashboard) | **Bun/TS** |

IPC: JSON lines (Bun→Rust via stdin), binary-framed messages (Rust→Bun via stdout) with three priority lanes (control/audio/video).

**This boundary stays exactly the same.** Python talks to clankvox over the same stdin/stdout pipes.

## Guiding Principles

- **Bottom-up**: migrate leaf dependencies first, work toward the orchestrator.
- **Coexistence**: Python port on a separate branch; clean cutover when ready.
- **clankvox stays Rust**: same IPC protocol, new Python client.
- **Dashboard frontend stays React**: swap backend from Hono to FastAPI.
- **Break the `llm/` ↔ `voice/` circular dep** before porting either.

## Source Map (TS)

```
src/                          429 .ts files (112 tests)
├── voice/                    120 files  *** LARGEST ***
├── bot/                       51 files
├── store/                     34 files
├── services/                  22 files
├── llm/                       19 files
├── tools/                     13 files
├── prompts/                    9 files
├── agents/                     9 files
├── settings/                   8 files
├── memory/                     8 files
├── normalization/              5 files
├── selfbot/                    4 files
├── video/                      3 files
├── commands/                   3 files
├── app.ts                     entrypoint
├── bot.ts                     2,084 lines — main orchestrator
├── llm.ts                     789 lines — LLM facade
└── dashboard.ts               622 lines — HTTP server

dashboard/src/                 71 files — React SPA (stays as-is)
```

### Key Structural Issues to Resolve During Port

- **Circular dep: `llm/` ↔ `voice/`** — `llm/audioService.ts` imports from `voice/realtimeClientCore.ts`; voice imports from `llm/pricing.ts`, `llm/llmHelpers.ts`. Break by extracting realtime WS clients to shared infra.
- **God objects**: `bot.ts` (2,084 lines), `voiceSessionManager.ts` (7,900 lines), `memoryManager.ts` (1,884 lines). Decompose further during port.
- **`settings/agentStack.ts`** imported by 58+ files. Map to a dependency-injected settings service in Python.

## Phases

### Phase 0 — Scaffolding & Spike

- Python project structure (`pyproject.toml`, `uv` or `poetry`)
- Async runtime: `asyncio` (stdlib)
- Logging setup (structured JSON, mirroring current NDJSON format)
- Config loader (env vars, mirroring `config.ts`)
- CI: linting (`ruff`), type checking (`pyright` or `mypy`)
- **CRITICAL SPIKE**: test `discord.py-self` (or equivalent) — connect as selfbot, listen to messages, send a reply. If this fails, solve before committing to the port.

### Phase 1 — Pure Foundations

- `normalization/` — 5 files, pure functions, direct port
- `settings/settingsSchema.ts` — dataclasses/Pydantic models for settings types
- `settings/agentStack.ts` — settings resolution logic
- `store/` — SQLite persistence via `aiosqlite` + `sqlite-vec` Python bindings (34 files, cleanest boundary). Validate with unit tests against a test DB.

### Phase 2 — LLM Layer

- `llm/serviceShared.ts` — shared types as Pydantic models
- `llm/chatGeneration.ts` — Anthropic (`anthropic` pip), OpenAI (`openai` pip), xAI. Async streaming via native SDK support.
- `llm/toolLoopChat.ts` — multi-turn tool loop
- `llm/audioService.ts` — extract realtime WS client out of `voice/` into shared infra first
- `llm/embeddingService.ts` — OpenAI embeddings (or swap to local `sentence-transformers` immediately)
- `llm/mediaGeneration.ts` — image/video generation
- `llm/pricing.ts` — cost tracking
- `llm.ts` facade — unified `LLMService` class

**Milestone: can make LLM calls, stream responses, run tool loops from Python.**

### Phase 3 — Memory + Services

- `memory/` — MemoryManager, reflection cycles, vector search (deps: store + llm, both ported)
- `services/search.ts` — Brave/SerpAPI via `httpx`
- `services/gif.ts` — Giphy
- `services/BrowserManager.ts` — swap to `playwright` (Python native)
- `services/discovery.ts`, `services/runtimeActionLogger.ts`

### Phase 4 — Prompts + Tools + Agents

- `prompts/` — 9 files, pure string construction
- `tools/` — tool registry, schemas, browser runtime (deps: services + llm)
- `agents/` — code agent, browse agent, sub-agent session

### Phase 5 — Bot Core (Text)

- `bot/botContext.ts` — context types as dataclasses
- `bot/replyPipeline.ts` — full text reply pipeline
- `bot/replyAdmission.ts`, `permissions.ts`, `queueGateway.ts`
- `bot/messageHistory.ts`, `conversationContinuity.ts`, `memorySlice.ts`
- `bot/initiativeEngine.ts`, `automationEngine.ts`
- `bot/mediaAttachment.ts`, `imageAnalysis.ts`
- `bot.ts` — ClankerBot main class via `discord.py` (or `discord.py-self`)

**Milestone: text bot works end-to-end in Python. Voice not yet ported.**

### Phase 6 — Voice Orchestration

- `voice/clankvoxClient.ts` → Python clankvox IPC client (`asyncio.subprocess`, `struct.unpack` for binary framing). **Port first, test against real Rust binary.**
- `voice/captureManager.ts`, `turnProcessor.ts` — audio capture state machines
- `voice/voiceReplyDecision.ts`, `voiceReplyPipeline.ts` — voice reply logic
- Realtime WS clients → `websockets` pip package
- `voice/musicPlayer.ts`, `soundboardDirector.ts`
- `voice/voiceSessionManager.ts` — 7,900 lines. Port last, test heavily.

**Milestone: full bot (text + voice) running in Python.**

### Phase 7 — Dashboard Backend

- Swap Hono → FastAPI/Starlette
- Same REST API contract, React frontend unchanged
- SSE endpoints for live voice/activity streams

### Phase 8 — Local AI Integration (the payoff)

- Ollama integration (local LLM inference)
- Local ASR via `faster-whisper`
- Local embeddings via `sentence-transformers`
- Local TTS via `piper` or similar
- HuggingFace model loading for specialized tasks

## Cleanup Checklist

After each phase is validated and the Python equivalent is confirmed working:

- [ ] Remove the corresponding TS source files from `src/`
- [ ] Remove TS-only dependencies from `package.json` that are no longer needed
- [ ] Remove TS-only dev dependencies (`typescript`, `ts-morph`, etc.) once no TS remains
- [ ] Remove `tsconfig.json` and TS build scripts once fully migrated
- [ ] Remove Bun-specific workarounds (e.g., `setTimeout` clamp polyfill in `app.ts`)
- [ ] Remove `bun.lock` / `node_modules` once no TS remains
- [ ] Clean up any TS test files (`*.test.ts`) as their modules are ported — port critical tests to `pytest`, drop redundant/brittle ones
- [ ] Update `AGENTS.md` to reflect Python runtime (replace Bun references with Python/uv)
- [ ] Update `docs/operations/logging.md` if logging format or tooling changes
- [ ] Update all docs that reference TS-specific patterns, file paths, or commands
- [ ] Remove `dashboard/vite.config.ts` build config if dashboard backend moves to FastAPI (frontend Vite config stays)
- [ ] Audit for dead code: TS shims, backward-compat paths, unused exports that existed only for TS module boundaries
- [ ] Remove `scripts/` TS tooling scripts — replace with Python equivalents or `Makefile` targets
- [ ] Final sweep: `grep -r "bun " docs/` and `grep -r "\.ts" docs/` to catch stale references

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `discord.py-self` selfbot compat | Spike in Phase 0. If it fails, evaluate `selfcord` or raw gateway client. |
| 7,900-line voiceSessionManager | Port incrementally by sub-module. captureManager, turnProcessor, etc. are already factored out. |
| `llm/` ↔ `voice/` circular dep | Break before porting either. Extract realtime WS clients to `infra/realtime/`. |
| IPC protocol drift | Write a protocol spec doc + integration tests before porting the client. |
| Dashboard API contract | Keep same route signatures. Frontend doesn't care what backend language serves them. |
| Lost institutional knowledge in TS tests | Port critical E2E and business-logic tests to pytest. Drop unit tests that test implementation details. |

## First Move

Spike `discord.py-self` in a throwaway script on the migration branch. If selfbot gateway connection works, the whole plan is viable.
