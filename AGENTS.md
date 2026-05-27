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
- When working on Clanky agent runtime behavior, Pi `InteractiveMode`, sessions, model/tool wiring, or harness integration, first inspect `/Users/jamesvolpe/dev/pi` and prefer the published `@earendil-works/pi-*` APIs and local Pi patterns over guesses.
- Keep package boundaries clean:
  - `agents/clanky` (`@clanky/agent`) owns the runnable Pi `InteractiveMode`, persona wiring, and the `clanky` bin.
  - `packages/clanky-core` (`@clanky/core`) owns Pi integration, memory, profile paths, state storage, work-tracker stores, skills loading, and model-facing tools.
  - `skills/` holds bundled Clanky skills loaded from disk.
- Durable Clanky configuration belongs to the active profile (`auth.json`, `discord-voice.json`, `models.json`, profile-local stores). TUI setup commands should edit those stores and report the active source; env vars are explicit launch overrides. Do not add hidden TUI-only persistent state or move AgentRoom room topology into Clanky.
- Chat gateways (Discord, etc.) are not packages in this repo. Clanky consumes them by importing `@agentroom/chat-discord` for agent-owned conversations, even when also participating in AgentRoom. Room-owned connector channels are owned by the AgentRoom daemon. See `docs/AGENTROOM.md`.
- Do not patch or vendor Pi. Use published `@earendil-works/pi-*` packages and exported APIs.

## Verification

- After code changes, run `pnpm check`.
- If you create or modify a smoke test, run that smoke script and iterate until it passes.
- Run focused smoke tests for the behavior you touched before broader `pnpm smoke`.
- Do not run `npm test`, `npm run build`, or generic npm commands.
- `pnpm check` does not run smoke tests.

## Live Gates

- Model, work-tracker, and chat-gateway tokens (Discord bot tokens, etc.) remain live gates requiring credentials or user approval. Clanky's agent-owned Discord token is resolved from `CLANKY_DISCORD_TOKEN` env (wins) or the profile `AuthStorage` entry under provider id `clanky-discord` (`<profileDir>/auth.json`, perms `0600`, populated interactively by the `/discord-login` slash command). Clanky must never read the room connector token owned by AgentRoom.

## State Safety

- Profile state must remain isolated under the resolved Clanky home/profile paths.
- Do not remove intentional functionality without asking.
- Keep tracker updates explicit: if tracker credentials or tools are unavailable, record or report `tracker_update_skipped` rather than silently dropping tracker state.
- Preserve other agents' work. Never use `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, or `git add .`.
