# ADR-0006 — Federated workspace: clanky-agent owns the shared wire contract

- **Status:** Accepted (endorsed by owner 2026-07-01)
- **Date:** 2026-07-01
- **Deciders:** James Volpe
- **Issue:** Unfiled — file under the work tracker when convenient.
- **Affects:** `packages/clanky-contract` (moved here from `clanky-ios`) ·
  `agent/channels/relay.ts` (validates inbound ops with the shared schema) ·
  `clanky-ios/pnpm-workspace.yaml` + `apps/mobile` (consume the sibling
  package; Metro watches it) · the umbrella folder layout at `~/dev/clanky`
  (now load-bearing for iOS development) · `SPEC.md` §relay

## Context

Clanky spans three independently-cloned repos under one umbrella folder:
`clanky-agent` (Node/TS brain + relay), `clankvox` (Rust media plane), and
`clanky-ios` (React Native client). The 2026-07-01 quality audit found the
relay wire contract was defined **twice with nothing enforcing agreement**:
`@clanky/contract` (zod schemas) lived in the iOS repo and was consumed only
by the phone, while the agent — the actual producer of the protocol — hand-
declared the same shapes inline in `relay.ts`. Drift already existed
(`register-push` reply fields, `session_dir`, unmodeled host-side command
frames), and the contract's request-validation half was dead code.

Two structural options were weighed for fixing this class of problem:

1. **Collapse everything into one monorepo.** Atomic cross-surface commits and
   a single lockfile, but: repo visibility is all-or-nothing on GitHub (parts
   of Clanky may go public while the control plane stays private), the three
   toolchains (Node/eve, cargo, Expo/native) would couple CI and dependency
   policy far more than the code is actually coupled, and the architecture's
   strongest boundaries (the clankvox IPC seam, the client/host split) already
   behave like repo boundaries.
2. **Federated workspace.** Keep the three repos separate; make `clanky-agent`
   the owner of every shared protocol/API package; have clients consume those
   packages rather than mirror them.

The real pain was contract drift, not repo count.

## Decision

Adopt the federated workspace:

- `clanky-agent` owns all shared protocol packages. `@clanky/contract` lives
  at `clanky-agent/packages/clanky-contract` and describes the agent's API;
  future shared surfaces (e.g. a `@clanky/relay-client` if client duplication
  grows) follow the same rule.
- The agent **consumes its own contract**: `agent/channels/relay.ts` validates
  every inbound relay request with `RelayRequestByOpSchema` before dispatch,
  so producer and consumer parse the same schemas and drift fails loudly.
- `clanky-ios` depends on the package as a sibling workspace package
  (`../clanky-agent/packages/clanky-contract`); Metro watches it. The iOS repo
  defines no wire shapes of its own.
- The contract package uses explicit `.ts` source imports so Node strip-types
  and Metro resolve the same source entrypoint — no build step in the dev
  loop.
- `clankvox` stays a separate repo for as long as it is independently
  buildable and testable; its stdin/stdout IPC seam is exactly the kind of
  boundary that deserves one.

## Consequences

- The umbrella folder's side-by-side layout (`clanky-agent/` next to
  `clanky-ios/`) is now **required** for iOS development, not just
  orientation. A lone `clanky-ios` clone does not resolve the contract.
- Wire-shape changes happen in one place, in the producer's repo, and the
  relay rejects requests that don't match — the "mirror rotted silently"
  failure mode is gone.
- CI/release for `clanky-ios` cannot rely on the sibling checkout forever:
  before any external release, either publish `@clanky/contract` at a pinned
  version or make the multi-checkout an explicit, documented CI step. This is
  the open follow-up of this ADR.
