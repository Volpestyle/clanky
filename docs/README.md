# Documentation Map

This directory has grown into a mix of canonical subsystem docs, provider notes,
operator runbooks, and older design/planning material. This file is the stable
entry point.

Use the docs in this order:

## Start Here

- [`../README.md`](../README.md) — repo setup, runtime identity, and the high-level product pitch
- [`architecture/overview.md`](architecture/overview.md) — the live runtime shape of Bun, `clankvox`, settings, tools, memory, and Discord integration
- [`architecture/relationship-model.md`](architecture/relationship-model.md) — product direction for community participation, owner-assistant depth, trusted collaborators, and capability tiers
- [`reference/settings.md`](reference/settings.md) — canonical settings contract and persistence model

## Capability Hubs

- [`capabilities/media.md`](capabilities/media.md) — the unified media surface: music, video, native screen watch, outbound publish, and browser visual context
- [`capabilities/browser.md`](capabilities/browser.md) — browser runtime behavior, `browser_browse`, persistent profiles for authenticated browsing, session continuation, cancellation, and headless visual capture
- [`capabilities/code.md`](capabilities/code.md) — code agent runtime and worker model
- [`capabilities/minecraft.md`](capabilities/minecraft.md) — embodied Minecraft runtime, session brain ownership, server selection, and current capability limits
- [`capabilities/memory.md`](capabilities/memory.md) — durable memory, journals, fact extraction, and retrieval

## Voice Deep Dives

- [`voice/voice-provider-abstraction.md`](voice/voice-provider-abstraction.md) — voice runtime overview and provider/runtime binding
- [`voice/voice-capture-and-asr-pipeline.md`](voice/voice-capture-and-asr-pipeline.md) — capture, VAD, ASR, and turn promotion
- [`voice/voice-client-and-reply-orchestration.md`](voice/voice-client-and-reply-orchestration.md) — voice session lifecycle, reply orchestration, and realtime ownership
- [`voice/voice-output-and-barge-in.md`](voice/voice-output-and-barge-in.md) — output state machine, interruption rules, and playback locks
- [`voice/music.md`](voice/music.md) — music playback, queue state, disambiguation, and output-lock interaction
- [`voice/screen-share-system.md`](voice/screen-share-system.md) — inbound screen-watch pipeline and how visual context reaches the brain
- [`voice/discord-streaming.md`](voice/discord-streaming.md) — Discord-native Go Live transport details for watch and self publish

## Behavior And Activity

- [`architecture/activity.md`](architecture/activity.md) — text + voice activity model and initiative behavior
- [`architecture/relationship-model.md`](architecture/relationship-model.md) — relationship tiers, capability classes, and ownership boundaries
- [`architecture/initiative.md`](architecture/initiative.md) — unified initiative/discovery cycle
- [`architecture/presence-and-attention.md`](architecture/presence-and-attention.md) — presence and shared-attention model
- [`architecture/presets.md`](architecture/presets.md) — preset-driven runtime selection and setting inheritance

## Operations

- [`operations/testing.md`](operations/testing.md) — canonical test commands
- [`operations/e2e.md`](operations/e2e.md) — selfbot + driver-bot validation harness
- [`operations/logging.md`](operations/logging.md) — structured logging, Loki/Grafana workflow, and incident debugging
- [`operations/multi-instance.md`](operations/multi-instance.md) — running multiple bot instances with shared Loki
- [`operations/public-https.md`](operations/public-https.md) — public HTTPS tunnel behavior
- [`operations/cancellation.md`](operations/cancellation.md) — shared cancellation behavior across text, voice, and tool loops

## Provider Notes

- [`providers/oauth.md`](providers/oauth.md) — local OAuth-backed provider lanes used by the repo
- [`providers/`](providers/) — upstream/provider reference snapshots and implementation notes (OpenAI, xAI, ElevenLabs). Useful when working on adapters; product/runtime truth still lives in the canonical architecture, capability, voice, and settings docs.

## Working Notes And Historical Material

- [`notes/`](notes/) — operator/developer notes, useful but not canonical
- [`log-dives/`](log-dives/) — incident postmortems, prompt snapshots, and debugging writeups
- [`tmp/`](tmp/) — work-in-progress specs, reviews, and design docs; not canonical and may intentionally lag implementation
- [`archive/`](archive/) — historical rollout notes and handoff docs retained for context

## Rules Of Thumb

- Product-level truth belongs in hub docs like [`capabilities/media.md`](capabilities/media.md), [`capabilities/minecraft.md`](capabilities/minecraft.md), and [`architecture/overview.md`](architecture/overview.md).
- Transport or pipeline internals belong in subsystem deep dives.
- Provider-specific material belongs under provider docs, not in product docs.
- Historical plans should not become the main source of truth after implementation lands.
- Run `bun run docs:check` after moving or editing docs so relative links do not silently drift.
