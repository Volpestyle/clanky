import { z } from "zod";
import { JsonValueSchema } from "./json.ts";

/**
 * Relay envelope frames shared by agent/channels/relay.ts and the RN clients.
 *
 * Every client→relay message is an `{ id?, op, args? }` request, modeled per-op
 * by `RelayRequestByOpSchema` (ops.ts) — the schema the app's dev-build send
 * funnels validate against. The relay answers with one of: the
 * {@link RelayReadyFrameSchema} on connect, a non-stream
 * {@link RelayAckReplySchema}/{@link RelayErrorReplySchema}, or — for the
 * long-lived ops (`subscribe`/`attach`/`command`) — a sequence of
 * {@link RelayStreamFrameSchema} frames.
 */

/**
 * Request id. The relay accepts `string | number` and echoes it back on every
 * reply. RN clients send strings so downstream dispatch can key requests
 * consistently.
 */
export const RelayIdSchema = z.union([z.string(), z.number()]);
export type RelayId = z.infer<typeof RelayIdSchema>;

/** First frame the relay sends after a socket opens and authorizes. */
export const RelayReadyFrameSchema = z.object({
  type: z.literal("ready"),
});
export type RelayReadyFrame = z.infer<typeof RelayReadyFrameSchema>;

/**
 * Non-stream success reply. Dispatch ops carry `result`; the control ops carry a
 * single ack facet instead (`unsubscribed`/`detached`/`face`/`commandHost`).
 */
export const RelayAckReplySchema = z.object({
  id: RelayIdSchema.optional(),
  ok: z.literal(true),
  result: JsonValueSchema.optional(),
  unsubscribed: z.boolean().optional(),
  detached: z.boolean().optional(),
  face: z.enum(["attached", "detached"]).optional(),
  commandHost: z.enum(["attached", "detached"]).optional(),
});
export type RelayAckReply = z.infer<typeof RelayAckReplySchema>;

/** Non-stream failure reply. `ok:false` with a human-readable `error`. */
export const RelayErrorReplySchema = z.object({
  id: RelayIdSchema.optional(),
  ok: z.literal(false),
  error: z.string(),
});
export type RelayErrorReply = z.infer<typeof RelayErrorReplySchema>;

/**
 * A frame of a streaming op (`subscribe`/`attach`/`command`). `body` is the
 * per-op payload (a herdr realtime event, a {@link PaneOutputFrame}, or a menu
 * event); `error` is set instead when `ok:false`.
 */
export const RelayStreamFrameSchema = z.object({
  id: RelayIdSchema.optional(),
  ok: z.boolean(),
  stream: z.literal(true),
  body: JsonValueSchema.optional(),
  error: z.string().optional(),
});
export type RelayStreamFrame = z.infer<typeof RelayStreamFrameSchema>;

/**
 * The relay's reply to a message it could not JSON-parse: a bare `{ error }`
 * with no `id`/`ok`.
 */
export const RelayInvalidRequestErrorSchema = z.object({
  error: z.string(),
});
export type RelayInvalidRequestError = z.infer<typeof RelayInvalidRequestErrorSchema>;

/**
 * Any frame the relay can send to a client. Ordered so the more specific frames
 * (ready, stream) are matched before the general non-stream replies.
 */
export const RelayServerMessageSchema = z.union([
  RelayReadyFrameSchema,
  RelayStreamFrameSchema,
  RelayAckReplySchema,
  RelayErrorReplySchema,
  RelayInvalidRequestErrorSchema,
]);
export type RelayServerMessage = z.infer<typeof RelayServerMessageSchema>;
