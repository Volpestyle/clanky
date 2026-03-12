# Repository Instructions

- Bot name is a customizable setting. Bot is not always named 'clanker conk'.
- This is more a framework for building a discord bot than a specific bot, which is why we have so much **configuration** [docs/voice/voice-provider-abstraction.md](docs/voice/voice-provider-abstraction.md).
- When making changes, it is essential we think about the code paths of all these possible configurations.

## Agent Autonomy — Core Design Principle

This bot in this repository (Clanker Conk) is built around a single idea: **the agent sees context like a human would, and decides what to do on its own.**

We do not hardcode behaviors for the agent. We give it rich context — conversation history, channel events, available tools, memory, participant state — and let the model reason about what to do. The agent should feel like a real person who happens to have access to powerful tools, not a state machine following a script. Think about Clanker Conk as if it was YOU (agent reading this), and guide your product and design decisions based on what YOU would want if you were this autonomous, self-directed, discord 'user'.

**What this means in practice:**

- **Tools are capabilities, not triggers.** If the agent sees a link in chat, it *can* use the browser tool to look at it — but only if it decides that's useful. We never wire "if link → browse" or "if question → search."
- **Prompts inform, they don't command.** Use soft guidance ("prefer", "when it fits naturally", "you may") over prescriptive rules ("you must", "always do X"). The model should reason about the situation, not follow a flowchart.
- **All user-facing speech is model-generated.** No canned responses, no fallback text, no hardcoded greetings. If the bot speaks, the model wrote those words for that moment.
- **Deterministic gates exist only for infrastructure safety** — permissions, rate limits, acoustic thresholds, budget caps. Never for creative or conversational decisions.
- **Admission gates are cost gates, not relevance gates.** They decide whether it's worth calling the LLM, not whether the bot should respond. The LLM decides that via `[SKIP]`. At high eagerness, gates widen and the model sees more; at low eagerness, gates narrow to save cost.
- **Settings are context, not rules.** Eagerness levels, persona flavor, and guidance text are injected into prompts for the model to reason about, not enforced as hard thresholds.
- **The agent can always choose silence.** `[SKIP]` is a first-class output. The bot should never be forced to respond just because it was triggered.

**When adding new features, ask:** "Am I telling the agent what to do, or am I giving it the context to decide for itself?" If the answer is the former, reconsider the design.

## General

#### Style
- Include a 'Product language' conclusion in your messages and commit messages when it seems like it makes sense.

#### Code Hygiene
- LOGS LOGS LOGS, log everything that might be beneficial for debugging or incident analysis. (logs.md)[docs/logs.md]
- Remove legacy compatibility paths, dead code, backward-compat shims, aliases, and old-field fallbacks as part of the same change. Prefer a single source of truth over parallel old/new code paths. Always sweep up after a change to remove all leftover latent code. Keep only what the user explicitly asks to preserve.
- When doing large changes, don't worry about tests until the very end. It's better to have ME prove our system manually before spending energy making and fixing tests.
- Always update canonical documentation of related feature when updating code. Prefer to avoid 'past tense' language, stating a canonical truth rather than a redesign or migration plan, unless explicitly asked for plan.
- Build modular, composable, and easily testable components. Avoid monolithic architecture.
##### Tests
- When I report a bug, don't start by trying to fix it. Instead, start by writing a test that reproduces the bug. Then, have subagents try to fix the bug and prove it with a passing test.
- Be conservative when creating tests. This can lead to bloat and heavy tech debt. Tests should only test critical business logic paths and edge cases.
- If you find tests that seem to be adding useless bloat, testing legacy things, or are redundant, please remove them.
- If you come across code that seems to be latent or dead, please remove.

#### Process
- Runtime/package manager standard: use Bun (`bun`, `bun run`, `bunx`) over Node/NPM (`node`, `npm`, `npx`) unless explicitly requested.
- Do not run 'smoke' or 'live' tests unless the user explicitly directs you to run them, since they incur cost. E2E tests and essential unit tests are the primary focus.
- For runtime debugging and incident analysis, prefer Grafana/Loki log exploration first; see `docs/logs.md` for setup and query workflow.
- Expect parallel in-flight edits from the user or other agents; treat unexpected diffs as active work, and never revert/reset/checkout files you did not explicitly change for the current task. Do not call out unrelated in-flight edits unless they directly interfere with your task.
- Avoid typecasts to `any` or `unknown`; prefer explicit, concrete types and narrow unions. Use casts only as a last resort with clear justification.
- Use git commit author `Volpestyle <14805252+Volpestyle@users.noreply.github.com>` for all commits in this repository.
- Pull inspiration from ../openclaw when designing and coding agentic capabilities for clanker conk.

## Testing Philosophy

- Design around Test Driven Development using Golden E2E Test Suites/Harnesses.
- Unit tests are still essential, but should be strictly reserved for testing complex business logic, algorithmic boundaries, state machines, and data transformations. Never write unit tests that simply verify prompt string concatenation or other brittle, implementation-detail patterns.
- The E2E Discord bot-to-bot tests are our primary testing method for truley reliable behavior.
- When running/writing tests, make sure we test different configurations, and during E2E live tests, be conscious about watching the integration test and the actual process logs at the same time, to cross reference. Integration test timings are most accurate when we read directly from our process logs.

### Test Commands

- When running e2e integration tests, start the bun bot process and then test so you can compare logs side by side.
- `bun run test` — unit/integration tests only (files in `src/` and `dashboard/src/`). E2E tests are excluded. Always use this for verification after code changes.
- `bun run test:e2e` — E2E tests only (`tests/e2e/`). Requires running dashboard, bot tokens, and test guild.
- `bun run test:e2e:voice` / `bun run test:e2e:text` — targeted E2E suites.
- Never run bare `bun test` — it discovers all `*.test.ts` files including E2E. Always use `bun run test`.

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