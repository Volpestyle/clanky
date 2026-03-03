# Repository Instructions

- Clanker conk current preferred models (see pricing.ts)
- Main
  - sonnet
  - gpt-5-mini reasoning medium
  - grok-4
- Classifiers
  - haiku
  - gpt-5-nano reasoning low

- Refer to docs/openai/openai-realtime-transcription.md when working with openai realtime transcripton or ASR.
- Refer to docs/openai/openai-realtime-speech.md when working with openai realtime speech.
- Runtime/package manager standard: use Bun (`bun`, `bun run`, `bunx`) over Node/NPM (`node`, `npm`, `npx`) unless explicitly requested.
- Do not run smoke tests unless the user explicitly directs you to run them, since they incur cost.
- For runtime debugging and incident analysis, prefer Grafana/Loki log exploration first; see `docs/logs.md` for setup and query workflow.

- Always remove legacy compatibility paths and dead code as part of the same change.
- Do not keep backward-compatibility shims, aliases, or old-field fallbacks unless the user explicitly asks for them.
- Prefer a single source of truth over parallel old/new code paths.
- After refactors, delete unused settings, branches, helpers, and UI wiring instead of leaving dormant code behind.
- Pull inspiration from ../openclaw when designing and coding agentic capabilites for clanker conk
- Expect parallel in-flight edits from the user or other agents; treat unexpected diffs as active work, and never revert/reset/checkout files you did not explicitly change for the current task.
- Do not call out unrelated in-flight edits unless they directly interfere with your ability to complete the current task. If you can work around them with low ambiguity, proceed without mentioning them.
- Avoid typecasts to `any` or `unknown`; prefer explicit, concrete types and narrow unions. Use casts only as a last resort with clear justification.
- Prefer LLM-driven decisions over hardcoded heuristics for conversational behavior; add deterministic heuristics only when explicitly requested or required for guardrails and obvious no-brainer cost savings.
- Never use hardcoded fallback text or voice lines for bot output. User-visible bot speech/messages must be model-generated unless the user explicitly requests deterministic wording.
- Bot name is a customizable setting. bot is not always named 'clanker conk'
- Use git commit author `Volpestyle <14805252+Volpestyle@users.noreply.github.com>` for all commits in this repository.

## Testing Philosophy

- Design around Test Driven Development using Golden Test Suites/Harnesses.
- Golden tests assert the exact behavior we describe — write the expectation first, then implement to satisfy it.
- When the user explicitly asks to validate smoke/golden behavior, prefer the live suite/path by default (for example `test:voice-golden:live`) unless they explicitly ask for simulated-only.
- When running live smoke or golden test suites, make sure we use `claude-code` as the provider
- E2E Discord bot-to-bot tests (`tests/e2e/`) validate the physical voice layer but require separate bot tokens and test guild setup (see `docs/e2e-testing.md`)
- Do not run E2E tests unless the user explicitly directs it, since they require live Discord infrastructure

## Dashboard UI Preferences

- No floating toasts. Prefer inline/in-UI alerts (status messages near the action that triggered them).

## Documentation Diagrams

Architecture and flow diagrams live as Mermaid source files in `docs/diagrams/*.mmd` and are rendered to high-res PNGs that the markdown files embed.
When writing or updating documentation, add/update a diagram when it would materially improve clarity for architecture, data flow, or runtime behavior.

### Regenerating diagrams after changes

After editing any `.mmd` file, re-render all diagrams:

```sh
bun run diagrams
```

Or render a single file:

```sh
bun run diagrams -- settings-flow.mmd
```

This runs `@mermaid-js/mermaid-cli` (`mmdc`) at 4x scale to produce crisp PNGs. Commit both the updated `.mmd` source and the regenerated `.png`.

### Adding a new diagram

1. Create `docs/diagrams/<name>.mmd` with valid Mermaid syntax.
2. Run `bun run diagrams -- <name>.mmd` to generate `docs/diagrams/<name>.png`.
3. Embed in the target markdown file:

   ```md
   ![Diagram Title](diagrams/<name>.png)

   <!-- source: docs/diagrams/<name>.mmd -->
   ```

4. Commit the `.mmd`, `.png`, and updated `.md` together.

## Code Hygiene (Desloppifying)

When the codebase accumulates AI-generated cruft, follow this protocol:

### Audit Phase

Run analysis tools to identify issues, prioritized by impact:

- **High**: Bugs, security issues, type safety violations, `any`/`unknown` casts
- **Medium**: Duplicate code, dead code, unused imports/variables, inconsistent naming
- **Low**: Formatting, style inconsistencies

### Cleanup Workflow

1. Run linters and type checkers to surface issues
2. Categorize findings by severity (see above)
3. Fix incrementally — one category at a time, with tests between changes
4. Remove legacy compatibility paths, dead code, and unused branches as part of the same change
5. Verify fixes with `bun run typecheck` and existing test suite

### Principles

- Prefer single source of truth over parallel old/new code paths
- After refactors, delete unused settings, branches, helpers, and UI wiring
- Avoid `any`/`unknown` casts; use explicit, concrete types
- Use agents with file-level context rather than whole-repo context for targeted fixes
