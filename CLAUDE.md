# Development Rules

Use `AGENTS.md` as the canonical development rules and `SPEC.md` as the
canonical architecture (eve conductor + vanilla herdr stage + visible panes).

Clanky is an eve agent. Before working on agent runtime behavior, channels,
schedules, sessions, tools, or skills, read the bundled eve docs in
`node_modules/eve/docs/` (start at `README.md`) and prefer the published eve
APIs over guesses. For herdr coordination, use the vanilla `herdr` CLI/skill;
never fork herdr — upstream instead. Pi is fully removed from Clanky (not a
dependency, runtime, or performer); the only use of the local Pi checkout
(`~/dev/pi`) is the one-time Codex OAuth code port described in SPEC.md §4.6.
