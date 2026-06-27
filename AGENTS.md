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
- `SPEC.md` is the canonical architecture. Clanky is an eve agent (conductor) on a vanilla herdr stage. Before working on runtime behavior, channels, schedules, sessions, tools, or skills, use the Eve skill at `~/dev/eve/SKILL.md`, then read the bundled eve docs in `node_modules/eve/docs/` (start at `README.md`). Prefer published eve APIs over guesses.
- Keep package boundaries clean (target layout, SPEC.md §9):
  - `agent/` is the eve Clanky agent: `instructions.md`, `agent.ts`, `channels/`, `tools/`, `schedules/`, `skills/`, `lib/`.
  - `agent/lib/` owns memory, persona, and the herdr spawn-seam helpers.
  - `skills/` holds bundled Clanky operator/worker skills loaded from disk; `clanky-herdr-operator` is the coordinator-only fan-out protocol, and `clanky-herdr-worker` is the worker-side coordination protocol.
- The Discord chat gateway is agent-owned via `agent/channels/discord.ts`: Clanky holds the credential and the conversation. Inbound work that should be watched is surfaced as a herdr pane through the spawn seam, never as a hidden in-process subagent.
- Do not fork herdr. Use the vanilla `herdr` CLI/skill; if a herdr-side feature is needed, upstream it to `ogulcancelik/herdr`.
- All worker spawns funnel through the transcript-run wrapping seam (`wrapTranscriptArgv` in `agent/tools/herdr_spawn.ts`): the eve `herdr_spawn` tool, the operator `spawn.sh`, and the relay `start` op all launch performers under `clanky transcript-run` with a pinned `HERDR_SESSION`/`CLANKY_HOME`. A worker has a durable transcript only if launched through the seam. Never spawn a worker with raw `herdr agent start`/`agent.start`, and route every new spawn surface (TUI slash command, iOS button) through the seam, not raw herdr.
- Pi's `@earendil-works/pi-tui` is Clanky's face UI toolkit: the face (`scripts/clanky.ts`) renders the public `eve/client` event stream through pi-tui components. eve stays the conductor/runtime brain underneath; pi is the presentation layer only — never the agent brain, the runtime conductor, or a performer (performers stay `clanky`/`claude`/`codex`/`opencode`). The local Pi checkout (`~/dev/pi`) also remains a source reference (e.g., Codex OAuth, SPEC.md §4.6).

## Custom Face / TUI

- Clanky's face is the custom TUI at `scripts/clanky.ts` (`pnpm face`): it renders the public `eve/client` event stream through `@earendil-works/pi-tui` components. We own the face because eve's dev TUI has a fixed, non-extensible slash-command set and is not exposed as a reusable library. pi-tui is the rendering toolkit; `eve/client` is the only eve coupling.
- **The only eve surface the face depends on is the public `eve/client` API** — events down (`message.appended`, `actions.requested`, `input.requested`, `step.completed`, …), `send()` / `inputResponses` up. Do NOT import eve's compiled `node_modules/eve/dist/.../cli/dev/tui/` internals and do NOT parse eve's terminal frame protocol; both are removed. eve's TUI source (installed package, or a local `../eve` checkout) may be consulted as an optional appearance reference only — never imported.
- Clanky owns its own look via pi-tui components; matching eve's visual language is optional, not a requirement. Keep intentional Clanky divergences and skip Vercel-specific surfaces: do not render Vercel warnings/tips, `/login`, `/vc`, `/channels`, `/deploy`, or pending-deploy indicators unless Clanky explicitly adopts that integration.
- Keep Clanky's slash-command set extensible in the shared `COMMANDS` registry so the typeahead, `/help`, and handler never drift. Clanky commands may intentionally differ from eve's fixed registry; model configuration should stay centered on Codex and Claude subscription-backed providers rather than eve's Vercel-oriented flow.
- Default models for every provider must be the latest version of that provider's flagship model (e.g. Claude `claude-opus-4-8`, Codex `gpt-5.5`, Gemini `gemini-3-pro`, xAI `grok-4`) — never a smaller or older tier (Sonnet/Haiku, Flash, a prior version). When a newer flagship ships, bump the `DEFAULT_*_MODEL` constants in `agent/lib/model-selection.ts` and `scripts/clanky.ts` together and front the picker/autocomplete options with it.
- Preserve Clanky branding: the header identifies Clanky and its eve-backed brain. The face attaches to a running eve server or spawns/owns a headless `eve dev --no-ui` (eve allows one dev server per agent); default port 2000.
- A turn that produces no assistant text must stay legible (spinner while thinking, an explicit no-reply note) — never leave the user staring at silence.

## Verification

- After code changes, run `pnpm check`.
- If you create or modify a smoke test, run that smoke script and iterate until it passes.
- Run focused smoke tests for the behavior you touched before broader `pnpm smoke`.
- When a real Clanky pane is available in Herdr, prefer testing against that live pane for behavior and TUI verification. Use `herdr pane list` / `herdr pane read` to identify the correct pane and avoid disturbing unrelated sessions.
- Agents may spin up temporary Clanky TUIs inside Herdr when they need an interactive face for testing; close temporary panes when the test is done.
- Do not run `npm test`, `npm run build`, or generic npm commands.
- `pnpm check` does not run smoke tests.

## Live Gates

- Model, work-tracker, and chat-gateway tokens (Discord bot tokens, etc.) remain live gates requiring credentials or user approval. Clanky's agent-owned Discord token and other secrets are resolved from the eve agent's environment / connection config (`.env.local`), not committed. The relay channel binds to the tailnet only and requires a bearer token.

## State Safety

- Durable Clanky state (memory, sessions) is owned by the eve agent's store; keep it isolated under the agent's resolved data paths and out of version control.
- Do not remove intentional functionality without asking.
- Keep tracker updates explicit: if tracker credentials or tools are unavailable, record or report `tracker_update_skipped` rather than silently dropping tracker state.
- Preserve other agents' work. Never use `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, or `git add .`.
