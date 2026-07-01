import { z } from "zod";
import { JsonValueSchema } from "./json.ts";

/**
 * Bodies carried inside `RelayStreamFrame.body` for the two herdr streaming ops:
 * `subscribe` (realtime tree/status events) and `attach` (live terminal output).
 */

/** One entry of the `subscribe` op's `subscriptions[]`. */
export const RelaySubscriptionSchema = z.object({
  type: z.string(),
  pane_id: z.string().optional(),
});
export type RelaySubscription = z.infer<typeof RelaySubscriptionSchema>;

/**
 * A live terminal frame streamed by the relay `attach` op (`PaneOutputFrame` in
 * relay.ts). A `full` frame carries `text`; an incremental frame carries base64
 * `data`. RN terminal clients decode exactly these fields.
 */
export const PaneOutputFrameSchema = z.object({
  type: z.literal("pane.output"),
  pane_id: z.string(),
  terminal_id: z.string().optional(),
  source: z.string(),
  format: z.string(),
  full: z.boolean(),
  text: z.string().optional(),
  encoding: z.literal("base64").optional(),
  data: z.string().optional(),
  seq: z.number().optional(),
  /** Relay-side ms timestamp of when the frame was emitted (latency tracing). */
  t_frame: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  fallback: z.boolean().optional(),
  fallbackReason: z.string().optional(),
});
export type PaneOutputFrame = z.infer<typeof PaneOutputFrameSchema>;

/**
 * A realtime herdr event forwarded by the `subscribe` op. Herdr's envelope drifts
 * — the name lands under `event` or `type`, dotted or underscored, and the
 * payload is either flattened or nested under `data`/`pane`; this schema stays
 * permissive to match. It captures the common fields the reducer reads and
 * passes the rest through.
 */
export const HerdrRealtimeEventSchema = z.looseObject({
  event: z.string().optional(),
  type: z.string().optional(),
  pane_id: z.string().optional(),
  agent_status: z.string().optional(),
  status: z.string().optional(),
  data: JsonValueSchema.optional(),
  pane: JsonValueSchema.optional(),
  workspace: JsonValueSchema.optional(),
});
export type HerdrRealtimeEvent = z.infer<typeof HerdrRealtimeEventSchema>;
