/**
 * @clanky/contract — the shared Clanky wire contract as zod schemas plus their
 * inferred TypeScript types. Zod is the only runtime dependency so Metro can
 * bundle this straight into the React Native app.
 *
 * Layers:
 *  - json      recursive `JsonValue` primitive for opaque herdr passthroughs
 *  - envelope  relay request / ready / reply / stream frames
 *  - ops       per-op args, the op-name catalog, and result-by-op schemas
 *  - herdr     herdr entities and dispatch-op results
 *  - streaming subscribe/attach stream bodies
 *  - menu      native slash-command menu events and client messages
 *  - session   the consumed subset of Eve session events + session HTTP shapes
 *
 * Every symbol is re-exported below so consumers import from the package root.
 */
export * from "./json.ts";
export * from "./envelope.ts";
export * from "./herdr.ts";
export * from "./streaming.ts";
export * from "./menu.ts";
export * from "./session.ts";
export * from "./ops.ts";
