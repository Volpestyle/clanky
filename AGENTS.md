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
- `SPEC.md` is the canonical architecture. Clanky is an eve agent (conductor) on a vanilla herdr stage. Before working on runtime behavior, channels, schedules, sessions, tools, or skills, read the bundled eve docs in `node_modules/eve/docs/` (start at `README.md`) and prefer published eve APIs over guesses.
- Keep package boundaries clean (target layout, SPEC.md §9):
  - `agent/` is the eve Clanky agent: `instructions.md`, `agent.ts`, `channels/`, `tools/`, `schedules/`, `skills/`, `lib/`.
  - `agent/lib/` owns memory, persona, and the herdr spawn-seam helpers.
  - `skills/` holds bundled Clanky operator/worker skills loaded from disk; `clanky-herdr-operator` is the coordinator-only fan-out protocol, and `clanky-herdr-worker` is the worker-side coordination protocol.
- The Discord chat gateway is agent-owned via `agent/channels/discord.ts`: Clanky holds the credential and the conversation. Inbound work that should be watched is surfaced as a herdr pane through the spawn seam, never as a hidden in-process subagent.
- Do not fork herdr. Use the vanilla `herdr` CLI/skill; if a herdr-side feature is needed, upstream it to `ogulcancelik/herdr`. Pi is not part of Clanky (not a dependency, runtime, or performer); use the local Pi checkout (`~/dev/pi`) only as a source reference for the Codex OAuth implementation (SPEC.md §4.6).

## Custom Face / TUI

- Clanky's face is the custom TUI at `scripts/clanky.ts` (`pnpm face`), built on the public `eve/client`. eve's own dev TUI has a fixed, non-extensible slash-command set, which is why we own the face.
- **Reference eve's TUI source when working on the face.** Before changing rendering or input, read the matching file under `node_modules/eve/dist/src/cli/dev/tui/` and copy its behavior/appearance for parity: `theme.js` (glyphs + colors, including ASCII fallback), `blocks.js` (per-block layout, wrapping, logs, questions, approvals, subagents), `tool-format.js` (tool summaries and expanded values), `status-line.js` (degradation and token flow), `command-typeahead.js` (slash typeahead + inline arg hint on exact match), `line-editor.js` (key handling, history, line windowing), `prompt-commands.js` (command shape), `terminal-renderer.js` and `runner.js` (stream translation and live-region behavior). If a local `../eve` checkout is present and the task is an eve-parity audit, compare against `../eve/packages/eve/src/cli/dev/tui/` too; implementation still targets the installed eve package unless the dependency is updated.
- Target full eve TUI parity for everything except intentional Clanky divergences: Clanky-owned slash commands, Clanky/eve branding, and Vercel-specific setup/deploy surfaces. Do not copy Vercel warnings, `/login`, `/vc`, `/channels`, `/deploy`, pending-deploy indicators, or Vercel tips unless Clanky explicitly adopts that integration.
- Keep Clanky's slash-command set extensible in the shared `COMMANDS` registry so the typeahead, `/help`, and handler never drift. Clanky commands may intentionally differ from eve's fixed registry; model configuration should stay centered on Codex and Claude subscription-backed providers rather than eve's Vercel-oriented flow.
- Preserve Clanky branding while matching eve's visual language: the header should identify Clanky and its eve-backed brain, not reuse eve's default preview/Vercel header verbatim. The face attaches to a running eve server or spawns/owns a headless `eve dev --no-ui` (eve allows one dev server per agent); default port 2000.
- A turn that produces no assistant text must stay legible (spinner while thinking, an explicit no-reply note) — never leave the user staring at silence.

## Verification

- After code changes, run `pnpm check`.
- If you create or modify a smoke test, run that smoke script and iterate until it passes.
- Run focused smoke tests for the behavior you touched before broader `pnpm smoke`.
- Do not run `npm test`, `npm run build`, or generic npm commands.
- `pnpm check` does not run smoke tests.

## Live Gates

- Model, work-tracker, and chat-gateway tokens (Discord bot tokens, etc.) remain live gates requiring credentials or user approval. Clanky's agent-owned Discord token and other secrets are resolved from the eve agent's environment / connection config (`.env.local`), not committed. The relay channel binds to the tailnet only and requires a bearer token.

## State Safety

- Durable Clanky state (memory, sessions) is owned by the eve agent's store; keep it isolated under the agent's resolved data paths and out of version control.
- Do not remove intentional functionality without asking.
- Keep tracker updates explicit: if tracker credentials or tools are unavailable, record or report `tracker_update_skipped` rather than silently dropping tracker state.
- Preserve other agents' work. Never use `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, or `git add .`.
