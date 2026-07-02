# Development Rules

## Style

- Keep responses and code comments concise and technical.
- Do not use emojis in commits, issues, PR comments, docs, or code.
- Do not commit unless explicitly asked.
- Do not preserve backwards-compatibility layers or legacy code paths by default. Remove old surfaces and update callers/docs to the current model unless the user explicitly asks for a migration shim.
- Before broad changes, read the relevant files in full.

## TypeScript

- Keep TypeScript strict and erasable for Node strip-only compatibility.
- Use top-level imports only. Do not use dynamic imports, inline imports, `import("pkg").Type`, `enum`, `namespace`, parameter properties, `import =`, or `export =`.
- Do not use `any` unless there is no reasonable typed alternative.
- Do not add single-line helper functions with a single call site.
- Check external API types in `node_modules` instead of guessing.

## Package Boundaries

- Use pnpm only. Do not add npm lockfiles or npm scripts.
- Keep the workspace `minimumReleaseAge`, `strictPeerDependencies`, `verifyStoreIntegrity`, and explicit `onlyBuiltDependencies` pnpm guards enabled unless the user explicitly approves changing supply-chain policy.
- `SPEC.md` is the canonical architecture. Clanky is an eve agent (conductor) on a terminal stage; Herdr is the current/default mux adapter, but the stage model stays mux-agnostic for future tmux/Zellij/etc. adapters. Before working on runtime behavior, channels, schedules, sessions, tools, or skills, use the Eve skill at `~/dev/eve/SKILL.md`, then read the bundled eve docs in `node_modules/eve/docs/` (start at `README.md`). Prefer published eve APIs over guesses.
- Keep package boundaries clean (target layout, SPEC.md §9):
  - `agent/` is the eve Clanky agent: `instructions.md`, `agent.ts`, `channels/`, `tools/`, `schedules/`, `skills/`, `lib/`.
  - `agent/lib/` owns memory, persona, and the stage/mux spawn-seam helpers.
  - `skills/` holds bundled Clanky operator/worker skills loaded from disk; `clanky-herdr-operator` is the coordinator-only fan-out protocol, and `clanky-herdr-worker` is the worker-side coordination protocol.
  - `.agents/skills/` holds repo-owned host-agent skills for developing and debugging this repo. `.claude/skills` and selected user skill roots may symlink here, but Clanky does not load these as bundled runtime skills.
- The free-will Discord gateway is agent-owned via `agent/channels/discord-gateway.ts` (`agent/channels/discord.ts` is only the HTTP Interactions baseline): Clanky holds the credential and the conversation. Inbound work that should be watched is surfaced as a visible stage pane through the spawn seam, never as a hidden in-process subagent.
- Do not fork muxes. Herdr is the current adapter, so use the vanilla `herdr` CLI/skill today; if a herdr-side feature is needed, upstream it to `ogulcancelik/herdr`. Future tmux/Zellij adapters should follow the same rule: adapt at Clanky's boundary or upstream generally useful mux features.
- All worker spawns funnel through the transcript-run wrapping seam (`wrapTranscriptArgv` in `agent/tools/herdr_spawn.ts`): the eve `herdr_spawn` tool, the operator `spawn.sh`, the TUI `/spawn` command, and the relay `start` op all resolve the transcript default from `CLANKY_WORKER_TRANSCRIPTS` (managed by `/harness transcripts on|off`) and launch under `clanky transcript-run` with pinned `HERDR_SESSION`/`CLANKY_HOME` when capture is enabled. A worker has a durable transcript only if launched through the seam with capture enabled or an explicit per-spawn transcript override. Never spawn a worker with raw `herdr agent start`/`agent.start`, and route every new spawn surface (TUI slash command, iOS button) through the seam, not raw mux commands.
- Pi's `@earendil-works/pi-tui` is Clanky's face UI toolkit: the face (`scripts/clanky.ts`) renders the public `eve/client` event stream through pi-tui components. eve stays the conductor/runtime brain underneath; pi is the presentation layer only — never the agent brain, the runtime conductor, or a performer (performers stay `clanky`/`claude`/`codex`/`opencode`). The local Pi checkout (`~/dev/pi`) also remains a source reference (e.g., Codex OAuth, SPEC.md §4.6).

## Sibling Repos (ClankVox & clanky-ios)

Two surfaces live in their own repos next to this one (`../clankvox`, `../clanky-ios`) and are wired in through eve channels here. Canonical detail is in SPEC.md; this is the orientation.

- **ClankVox** (`../clankvox`, Rust) is Clanky's Discord voice/media transport — the real-time audio plane the Node brain is too slow and unequipped to run itself. Inbound it emits the voice channel's PCM, which the realtime voice client consumes; the conversation lands as text turns in a dedicated voice presence session (same memory + persona). Outbound it takes Clanky's reply rendered to PCM (Realtime or ElevenLabs TTS) and sends it back to Discord, and it forwards Go Live stream credentials to decode others' screen shares or publish his own. We keep it a separate Rust binary so the media plane stays isolated and the brain's control loop stays latency-friendly. It fits as the control plane in `agent/lib/voice/*`, attached to the gateway's Discord client by `attachVoiceRuntime()` in `agent/channels/voice.ts`. Build it before first join with `pnpm clankvox:setup` (idempotent: installs the Rust toolchain if missing, builds + verifies the release binary); the join path resolves the prebuilt binary via `resolveClankvoxBinaryLocation` and never compiles inline. Overrides: `CLANKY_CLANKVOX_DIR` (source) / `CLANKY_CLANKVOX_BIN` (prebuilt). A missing binary faults the voice op rather than crashing the brain. See SPEC.md §5.3.
- **clanky-ios** (`../clanky-ios`, Xcode/`ClankyIOS.xcodeproj`) is the *window* — the native iOS app that reaches the always-on Mac over the tailnet so you can see and steer the terminal stage from your phone. It speaks two contracts: SSH for brain lifecycle cold-start (`scripts/clanky-up.ts`: `up`/`status`/`down`) and the eve **relay** channel (`agent/channels/relay.ts`, a raw bearer-token WS route) for everything live — chat (eve session routes), pane read/steer, live terminal (Native `attach` and Mirror modes), input injection, image upload, and APNs push alerts. Pairing is a QR `clanky://connect` deep link from `clanky pair`; the app stores the relay URL + token in Keychain and auto-reconnects over Tailscale. We have it because remote access must not fork the active mux — the brain runs headless on a Mac mini and the app is the visible window onto it from anywhere. Spawns triggered from the app route through the same transcript-run spawn seam as every other surface, never raw mux commands. See SPEC.md §4.4.

## Custom Face / TUI

- Clanky's face is the custom TUI at `scripts/clanky.ts`; use `clanky dev` while editing so the face runs under watch mode and the owned `eve dev --no-ui` brain is supervised. `pnpm dev` is the direct one-shot repo-local face entrypoint. The face renders the public `eve/client` event stream through `@earendil-works/pi-tui` components. We own the face because eve's dev TUI has a fixed, non-extensible slash-command set and is not exposed as a reusable library. pi-tui is the rendering toolkit; `eve/client` is the only eve coupling.
- **The only eve surface the face depends on is the public `eve/client` API** — events down (`message.appended`, `actions.requested`, `input.requested`, `step.completed`, …), `send()` / `inputResponses` up. Do NOT import eve's compiled `node_modules/eve/dist/.../cli/dev/tui/` internals and do NOT parse eve's terminal frame protocol; both are removed. eve's TUI source (installed package, or a local `../eve` checkout) may be consulted as an optional appearance reference only — never imported.
- Clanky owns its own look via pi-tui components; matching eve's visual language is optional, not a requirement. Keep intentional Clanky divergences and skip Vercel-specific surfaces: do not render Vercel warnings/tips, `/login`, `/vc`, `/channels`, `/deploy`, or pending-deploy indicators unless Clanky explicitly adopts that integration.
- Keep Clanky's slash-command set extensible in the shared `COMMANDS` registry so the typeahead, `/help`, and handler never drift. Clanky commands may intentionally differ from eve's fixed registry; model configuration should stay centered on Codex and Claude subscription-backed providers rather than eve's Vercel-oriented flow.
- Default models for every provider must be the latest version of that provider's flagship model (e.g. Claude `claude-opus-4-8`, Codex `gpt-5.5`, Gemini `gemini-3-pro`, xAI `grok-4`) — never a smaller or older tier (Sonnet/Haiku, Flash, a prior version). When a newer flagship ships, bump the `DEFAULT_*_MODEL` constants in `agent/lib/config-defaults.ts` (the single source; every other module re-exports from it) and front the picker/autocomplete options (`scripts/clanky/config-data.ts` `MODEL_OPTIONS`) with it.
- Preserve Clanky branding: the header identifies Clanky and its eve-backed brain. The face attaches to a running eve server or spawns/owns a headless `eve dev --no-ui` (eve allows one dev server per agent); default port 2000.
- A turn that produces no assistant text must stay legible (spinner while thinking, an explicit no-reply note) — never leave the user staring at silence.

## TUI Design

- Richly format TUI text with color, brightness, and emphasis to make dense output easy to scan.
- Visually differentiate secondary or qualifying text from primary text. Parenthetical notes should use a distinct style, such as dimmer or lower-contrast text, instead of inheriting the surrounding text style: `(ignoring incompatible override qwen3.6:27b-mlx)`.
- In slash-command typeahead, keep the list compact, but when the selected row's description would truncate, render the full description above the list as accented wrapped text.
- Render slash-command results, status blocks, and dense menu panels as width-aware pi-tui components. Avoid pre-rendered fixed-width strings; wrap long text with `wrapTextWithAnsi` or component renderers so pane resizes reflow cleanly.

## TUI Menus

- Settings slash commands that open a modal, including `/model`, should render the current state inside the modal above the prompt. Users should see what they are changing from without selecting a separate status option that exits the menu.
- Keep direct `/<command> status` commands for non-interactive/scriptable output and scrollback. In an interactive menu, status is contextual modal content; it is not the primary action.
- Keep modal status compact by default: show the active/configured value, important mismatches, and auth or live-gate warnings. Do not dump every saved field, env var, or diagnostic line into the default menu view.
- When status details are useful but dense, use the collapsed/expanded details pattern: show a short summary by default, then render the details toggle outside the option list, tight under the status summary and above the prompt. Use a large disclosure triangle flush with the status left margin and `show details` / `hide details` as the description text. The active details row should change highlight color but not show the normal `>` row selector. Toggle the same modal in place. The details toggle must not write config, restart the brain, or close the menu.
- Back navigation is hierarchical. In a modal opened from a parent menu, Left/Esc from a child prompt should return `undefined` to the parent `settingsLoop` so the previous menu reopens. Only backing out of the root modal should produce a `/command cancelled` message. Direct one-shot slash commands may still treat Back/Esc as cancellation because there is no parent menu.
- Prefer the shared `settingsLoop` `renderStatus` / `collapsibleMenuStatus` path for new settings menus so `/model`, media model pickers, harness, layout, approvals, and future menus keep the same status and expand-details behavior.

## Verification

- After code changes, run `pnpm check` and `pnpm lint` (Biome, lint-only; config in `biome.jsonc`).
- If you create or modify a smoke test, run that smoke script and iterate until it passes.
- Run focused smoke tests for the behavior you touched before broader `pnpm smoke`. `pnpm smoke` (`scripts/run-smoke.ts`) globs `test/*-smoke.ts` and runs every offline-capable test, skipping a documented live-gated set — new offline smoke tests are picked up automatically.
- When a real Clanky pane is available in Herdr, prefer testing against that live pane for behavior and TUI verification. Use `herdr pane list` / `herdr pane read` to identify the correct pane and avoid disturbing unrelated sessions.
- Agents may spin up temporary Clanky TUIs inside Herdr when they need an interactive face for testing; close temporary panes when the test is done.
- Do not run `npm test`, `npm run build`, or generic npm commands.
- `pnpm check` does not run smoke tests.

## Live Gates

- Model, work-tracker, and chat-gateway tokens (Discord bot tokens, etc.) remain live gates requiring credentials or user approval. Clanky's agent-owned Discord token and other secrets are resolved from the eve agent's environment / connection config (`.env.local`), not committed. The relay channel binds to the tailnet only and requires a bearer token.
- Local-face auth is socket-verified loopback: only the real socket remote address can mint a local principal — a Host header naming a loopback hostname is never trusted (`agent/lib/frontdoor-auth.ts`).

## Work Tracking

- Clanky tracks work in the configured work-tracker connection by default, following the provider-neutral `clanky-work-tracker` protocol: read the relevant issues before starting, plan multi-step work as issues, and post decisions, results, and verification to the issue as comments while the work happens — not after. The tracker, not pane scrollback, is the durable source of truth for work context; leads and spawned workers inherit the same protocol. Which tracker is bound is deployment configuration (the owner's connection config / workspace docs), never hardcoded here.
- Tracker writes use Clanky's own tracker actor and mention the owner so updates reach their inbox; trackers suppress self-notifications (ADR-0005).
- Once tracked, pane scrollback is disposable: harvest and verify a worker, update the issue, then close the worker's pane.

## State Safety

- Durable Clanky state (memory, sessions) is owned by the eve agent's store; keep it isolated under the agent's resolved data paths and out of version control.
- Do not remove intentional functionality without asking.
- Keep tracker updates explicit: if tracker credentials or tools are unavailable, record or report `tracker_update_skipped` rather than silently dropping tracker state.
- Preserve other agents' work. Never use `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, or `git add .`.
