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
  - `clanky-core` owns Pi integration, sessions, cron, skills, state, Linear stores, and model-facing tools.
  - `clanky-gateway` owns HTTP, MCP, WebSocket, UDS gateway dispatch, and external MCP subprocesses.
  - `clanky-swarm` owns `swarm-mcp` lifecycle, dispatch, message, complete, snapshot, and lock semantics.
  - `clanky-tui` owns dashboard/chat clients over the daemon socket.
  - `clanky-cli` is a thin command surface over gateway/core operations.
- Do not patch or vendor Pi. Use published `@earendil-works/pi-*` packages and exported APIs.
- Do not reinvent `swarm-mcp`; consume its public stdio MCP tool surface.

## Verification

- After code changes, run `pnpm check`.
- If you create or modify a smoke test, run that smoke script and iterate until it passes.
- Run focused smoke tests for the behavior you touched before broader `pnpm smoke`.
- Do not run `npm test`, `npm run build`, or generic npm commands.
- `pnpm check` does not run smoke tests.

## Live Gates

- Do not retry launchd bootstrap for `com.clanky.daemon` without explicit user approval.
- Model, Linear, calendar, default swarm service env, and launchd-managed profile-daemon checks remain live gates requiring credentials, service installation, or user approval. Claude Code MCP mount evidence is captured on this machine; rerun it only for revalidation.
- Use `pnpm clanky doctor --home ~/.clanky` for non-mutating live-gate preflight.

## State Safety

- Profile state must remain isolated under the resolved Clanky home/profile paths.
- Do not remove intentional functionality without asking.
- Keep Linear updates explicit: if tracker credentials or tools are unavailable, record or report `tracker_update_skipped` rather than silently dropping tracker state.
- Preserve other agents' work. Never use `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, or `git add .`.
