---
description: Use when Clanky needs to read host code, repos, files, or version-control state directly with the host_command tool — exploring a codebase, checking a diff or PR, grepping for a symbol, or inspecting git/GitHub context without spawning a worker pane.
---

# Host Command — reading the Mac directly

`host_command` runs a real shell on the host inside an OS-enforced Seatbelt
sandbox. It is the quick context lane from ADR-0003: full-disk **read**, no
writes, no network except for trusted CLIs. Use it to understand; use a
`herdr_spawn` pane to act.

## The floor (what the sandbox enforces)

- **Reads:** the whole disk, except credential material — `.env*` files,
  `~/.ssh`, `~/.aws` are unreadable at the OS level. Do not try to read
  credentials from other locations either; never echo tokens into output.
- **Writes:** blocked. An escalated or `auto`-mode run may write, scoped to
  cwd + `/tmp` only, with `.git` protected.
- **Network:** off by default. Granted automatically only when *every* command
  in the pipeline is a known read (`cat`, `rg`, `grep`, `ls`, `find`, `sed -n`,
  `jq`, `head`, `tail`, `wc`, ...) or a trusted `gh` read — one unknown binary
  in the pipe and the whole run is offline, so keep networked pipelines pure.
- Complex scripts (substitutions, redirections, multi-line) still run — fully
  sandboxed and always offline. Compose freely for local reads.

## Layout and defaults

- Default cwd is the repos root `~/dev` (override per call with `cwd`, or
  globally with `CLANKY_HOST_COMMAND_ROOT`).
- Naming gotcha: sibling docs cross-reference the Clanky agent repo as
  `../clanky`, but on disk the folder is `~/dev/clanky/clanky-agent` (the
  umbrella folder `~/dev/clanky` holds `clanky-agent`, `clankvox`,
  `clanky-ios`).

## Incantations

- Find code: `rg -n "pattern" <repo>/` · files only: `rg -l` · type filter:
  `rg -t ts`.
- Read a slice: `sed -n 100,160p file.ts` or `head -50 file.ts`.
- JSON: `cat package.json | jq .scripts`.
- GitHub reads (network auto-granted): `gh pr view <n> --repo <o/r>`,
  `gh pr diff <n>`, `gh pr checks <n>`, `gh issue list`, `gh run view <id>`,
  `gh search code <q>`, `gh api repos/<o>/<r>/pulls` (GET only).
- Local `git` is deliberately not granted (ADR-0003): `gh` covers GitHub-level
  context, and git archaeology is a worker's job. Code content is readable via
  `cat`/`rg`.

## Approval ladder

- `read-only` (default): reads auto-run with zero prompts. Mutating `gh`
  subcommands (`pr create`, `issue comment`, non-GET `api`) ask first.
  `gh auth token` is refused outright.
- Escalation: when a run genuinely needs writes or extra network, re-invoke
  with `escalation: { write: true | network: true, justification: "…" }`; the
  owner approves in place. Prefer a pane for anything watchable instead.
- `auto` / `yolo` are owner-set postures (`/approvals`); never ask for them.
  Yolo applies only to owner turns — presence turns clamp back to the floor.

## When not to use it

Substantial, watchable, or mutating work — builds, test runs, edits, landing
branches, long investigations — is the work lane: `herdr_spawn` a visible
pane (load `clanky-herdr-operator`). If a read needs more than ~2 minutes or
its output should be watched, it is pane work.
