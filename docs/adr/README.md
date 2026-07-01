# Architecture Decision Records

`SPEC.md` is the canonical, present-tense description of Clanky's architecture —
it says what *is*. An ADR captures a single *decision*: the context that forced
it, the options weighed, and why one won. SPEC tells you the shape; the ADR tells
you why the shape is that way and what was rejected.

Write an ADR when a change is a deliberate, hard-to-reverse trade-off — a
new invariant, a boundary move, a protocol swap — especially one that gates other
work. Routine changes that just follow the existing model do not need one.

## Convention

- One file per decision: `NNNN-kebab-title.md`, zero-padded, monotonically
  increasing. Never renumber or delete a ratified ADR; supersede it with a new one.
- Each ADR carries a **Status**: `Proposed` (written, awaiting sign-off),
  `Accepted` (ratified — the SPEC now reflects it), or
  `Superseded by ADR-NNNN` (a later decision replaced it).
- Keep the voice of the repo: concise, technical, present tense, no emojis.
  Diagram the topology when it helps (Mermaid, inline).
- When an ADR is `Accepted`, fold its outcome into `SPEC.md` and cross-link both
  ways. A `Proposed` ADR may land alongside a SPEC block also marked *Proposed*
  so the tree stays truthful about what is ratified versus pending.

## Index

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-remote-lifecycle-cold-start.md) | Remote lifecycle / cold-start after the React Native migration | Proposed |
| [0002](0002-pool-orchestration-operating-model.md) | Tracker-driven persistent-pool orchestration | Proposed |
