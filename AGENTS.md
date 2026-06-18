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
  - `agent/lib/` owns ported memory, persona, and the herdr spawn-seam helpers.
  - `skills/` holds bundled Clanky operator skills loaded from disk; `clanky-herdr-operator` is the coordinator-only fan-out protocol.
- The Discord chat gateway is agent-owned via `agent/channels/discord.ts`: Clanky holds the credential and the conversation. Inbound work that should be watched is surfaced as a herdr pane through the spawn seam, never as a hidden in-process subagent.
- Do not fork herdr. Use the vanilla `herdr` CLI/skill; if a herdr-side feature is needed, upstream it to `ogulcancelik/herdr`. Pi is fully removed from Clanky (not a dependency, runtime, or performer); the only use of the local Pi checkout (`~/dev/pi`) is the one-time Codex OAuth code port (SPEC.md §4.6).

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
