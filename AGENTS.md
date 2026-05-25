# Development Rules

## Style

- Keep responses and code comments concise and technical.
- Do not use emojis in commits, issues, PR comments, docs, or code.
- Do not commit unless explicitly asked.
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
- Keep package boundaries clean:
  - `agents/clanky` (`@clanky/agent`) owns the runnable Pi `InteractiveMode`, persona wiring, and the `clanky` bin.
  - `packages/clanky-core` (`@clanky/core`) owns Pi integration, memory, profile paths, state storage, Linear stores, skills loading, and model-facing tools.
  - `skills/` holds bundled Clanky skills loaded from disk.
- Chat gateways (Discord, etc.) are not packages in this repo. Clanky consumes them either by importing `@agentroom/chat-discord` in standalone mode or by deferring to an AgentRoom daemon in enrolled mode. See `docs/AGENTROOM.md`.
- Do not patch or vendor Pi. Use published `@earendil-works/pi-*` packages and exported APIs.

## Verification

- After code changes, run `pnpm check`.
- If you create or modify a smoke test, run that smoke script and iterate until it passes.
- Run focused smoke tests for the behavior you touched before broader `pnpm smoke`.
- Do not run `npm test`, `npm run build`, or generic npm commands.
- `pnpm check` does not run smoke tests.

## Live Gates

- Model, Linear, and chat-gateway tokens (Discord bot tokens, etc.) remain live gates requiring credentials or user approval. Standalone Clanky reads them from its own profile; enrolled Clanky must never read them at all.

## State Safety

- Profile state must remain isolated under the resolved Clanky home/profile paths.
- Do not remove intentional functionality without asking.
- Keep Linear updates explicit: if tracker credentials or tools are unavailable, record or report `tracker_update_skipped` rather than silently dropping tracker state.
- Preserve other agents' work. Never use `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, or `git add .`.
