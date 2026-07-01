# Worktree & PR-lane policy

Independent means **write-disjoint**. Workers fanned out concurrently must not
write the same files, and a read-only worker must never audit files another
worker in the same run is creating — its analysis reads a moving target and
reports stale or half-written state. If two tasks share mutable paths (one reads
what another writes, or both edit the same files), do not fan them out together:
sequence them (separate runs, or a `blocked` handoff), or, when the work truly
belongs in separate PR lanes, isolate each writer in its own git worktree under
the rules below. When unsure whether scopes overlap, assume they do.

Use the parent/current worktree by default. A worker gets a separate git
worktree only after the operator has deliberately decided that task should land
as its own branch/PR; do not use per-worker worktrees merely as a convenience
for concurrent edits. If scopes overlap but the work is not meant to be its own
PR, sequence the tasks or synthesize them into one edit-capable worker in the
parent worktree. When scopes are **cleanly disjoint** (each worker owns its own
directory subtree), a single **scope-partitioned shared worktree** with
lead-owned commits is the lighter default — no per-worker worktree setup, and
integration seams stay visible in one tree. For shared-parent runs, integration
is **lead-owned**: never run `git add -A`/`git add .` or commit while any worker
in the run is mid-edit — a blind stage captures another worker's half-written
files. Wait for the run to quiesce (all workers `idle`/done) before committing,
per the `/c` skill. This interlock is convention only — nothing enforces it yet
([VUH-337](https://linear.app/vuhlp/issue/VUH-337)).

For PR-lane worktrees, the operator owns the branch/PR lifecycle. Capture the
branch, worktree path, PR URL, review status, and trunk branch (`main`, `master`,
or the repo's default) in the run ledger. Review each worker PR yourself before
accepting it, wait for review-bot comments when they are expected, steer workers
to address actionable comments, and reconcile the branch with trunk after the PR
lands so later work starts from the real integrated state.
