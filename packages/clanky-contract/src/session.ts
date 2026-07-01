import { z } from "zod";
import { JsonValueSchema } from "./json.ts";

/**
 * Eve session stream (`GET /eve/v1/session/:id/stream`, NDJSON). The generic
 * frame is `{ type, data? }`; the RN chat reducer consumes the subset modeled
 * by {@link SessionEventSchema} below. Event `data` payloads are camelCase on
 * the wire.
 */

/** The raw NDJSON frame: a `type` tag plus an opaque `data` bag. */
export const SessionStreamEventSchema = z.object({
  type: z.string(),
  data: JsonValueSchema.optional(),
});
export type SessionStreamEvent = z.infer<typeof SessionStreamEventSchema>;

// --- Typed payload pieces --------------------------------------------------

/** A tool/action invocation announced by `actions.requested`. */
export const SessionActionRequestSchema = z.object({
  callId: z.string(),
  toolName: z.string().optional(),
  input: JsonValueSchema.optional(),
});
export type SessionActionRequest = z.infer<typeof SessionActionRequestSchema>;

/** A tool/action outcome carried by `action.result`. */
export const SessionActionResultSchema = z.object({
  callId: z.string(),
  isError: z.boolean().optional(),
  output: JsonValueSchema.optional(),
});
export type SessionActionResult = z.infer<typeof SessionActionResultSchema>;

/** One selectable option in an `input.requested` request. */
export const SessionInputOptionSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  description: z.string().optional(),
  style: z.string().optional(),
});
export type SessionInputOption = z.infer<typeof SessionInputOptionSchema>;

/** A single pending user-input request from `input.requested`. */
export const SessionInputRequestSchema = z.object({
  requestId: z.string(),
  prompt: z.string().optional(),
  title: z.string().optional(),
  options: z.array(SessionInputOptionSchema).optional(),
  allowFreeform: z.boolean().optional(),
});
export type SessionInputRequest = z.infer<typeof SessionInputRequestSchema>;

/** The `authorization` sub-object of an `authorization.required` event. */
export const SessionAuthorizationSchema = z.object({
  url: z.string().optional(),
  userCode: z.string().optional(),
  instructions: z.string().optional(),
});
export type SessionAuthorization = z.infer<typeof SessionAuthorizationSchema>;

// --- Consumed event subset (discriminated on `type`) -----------------------

// Generic over the literal `type` so each member keeps its literal discriminant
// (a plain `type: string` parameter would widen every member to `type: string`,
// breaking `switch (event.type)` narrowing for consumers).
const withData = <K extends string, T extends z.ZodTypeAny>(type: K, data: T) =>
  z.object({ type: z.literal(type), data: data.optional() });

export const SessionStartedEventSchema = withData("session.started", z.object({}).loose());
export const TurnStartedEventSchema = withData("turn.started", z.object({}).loose());

export const MessageAppendedEventSchema = withData(
  "message.appended",
  z.object({ messageSoFar: z.string().optional(), messageDelta: z.string().optional() }),
);
export const MessageCompletedEventSchema = withData(
  "message.completed",
  z.object({ message: z.string().optional() }),
);

export const ReasoningAppendedEventSchema = withData(
  "reasoning.appended",
  z.object({ reasoningSoFar: z.string().optional(), reasoningDelta: z.string().optional() }),
);
export const ReasoningCompletedEventSchema = withData("reasoning.completed", z.object({}).loose());

export const ActionsRequestedEventSchema = withData(
  "actions.requested",
  z.object({ actions: z.array(SessionActionRequestSchema).optional() }),
);
export const ActionResultEventSchema = withData(
  "action.result",
  z.object({
    result: SessionActionResultSchema.optional(),
    status: z.string().optional(),
    error: z.string().optional(),
  }),
);

export const TurnCompletedEventSchema = withData("turn.completed", z.object({}).loose());
export const TurnFailedEventSchema = withData("turn.failed", z.object({ message: z.string().optional() }));

/**
 * Emitted after EVERY model call completes — including mid-turn tool-call steps
 * (`finishReason: "tool-calls"`), so it does NOT end the active turn; only
 * `turn.completed` / `session.waiting` / failures do (eve's own consumers treat
 * it as a flush/usage checkpoint, never a terminal signal).
 */
export const StepCompletedEventSchema = withData(
  "step.completed",
  z
    .object({
      finishReason: z.string().optional(),
      usage: z
        .object({
          inputTokens: z.number().optional(),
          outputTokens: z.number().optional(),
          cacheReadTokens: z.number().optional(),
          cacheWriteTokens: z.number().optional(),
        })
        .loose()
        .optional(),
    })
    .loose(),
);
export const StepFailedEventSchema = withData("step.failed", z.object({ message: z.string().optional() }));

export const SessionWaitingEventSchema = withData("session.waiting", z.object({}).loose());
export const SessionCompletedEventSchema = withData("session.completed", z.object({}).loose());
export const SessionFailedEventSchema = withData(
  "session.failed",
  z.object({ message: z.string().optional() }),
);

export const InputRequestedEventSchema = withData(
  "input.requested",
  z.object({ requests: z.array(SessionInputRequestSchema).optional() }),
);

export const AuthorizationRequiredEventSchema = withData(
  "authorization.required",
  z.object({
    name: z.string().optional(),
    description: z.string().optional(),
    url: z.string().optional(),
    authorization: SessionAuthorizationSchema.optional(),
  }),
);
export const AuthorizationCompletedEventSchema = withData(
  "authorization.completed",
  z.object({ name: z.string().optional(), outcome: z.string().optional() }),
);

/**
 * The subset of Eve session events the app reducer (AppStore.applyClankyEvent)
 * actually interprets. Unlisted event types still arrive as
 * {@link SessionStreamEventSchema} frames and are ignored by the reducer.
 */
export const SessionEventSchema = z.discriminatedUnion("type", [
  SessionStartedEventSchema,
  TurnStartedEventSchema,
  MessageAppendedEventSchema,
  MessageCompletedEventSchema,
  ReasoningAppendedEventSchema,
  ReasoningCompletedEventSchema,
  ActionsRequestedEventSchema,
  ActionResultEventSchema,
  TurnCompletedEventSchema,
  TurnFailedEventSchema,
  StepCompletedEventSchema,
  StepFailedEventSchema,
  SessionWaitingEventSchema,
  SessionCompletedEventSchema,
  SessionFailedEventSchema,
  InputRequestedEventSchema,
  AuthorizationRequiredEventSchema,
  AuthorizationCompletedEventSchema,
]);
export type SessionEvent = z.infer<typeof SessionEventSchema>;

/** Every session event `type` the reducer recognizes. */
export const SESSION_EVENT_TYPES = [
  "session.started",
  "turn.started",
  "message.appended",
  "message.completed",
  "reasoning.appended",
  "reasoning.completed",
  "actions.requested",
  "action.result",
  "turn.completed",
  "turn.failed",
  "step.completed",
  "step.failed",
  "session.waiting",
  "session.completed",
  "session.failed",
  "input.requested",
  "authorization.required",
  "authorization.completed",
] as const;
export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];

// --- Eve session HTTP request/response shapes ------------------------------

/** `POST /eve/v1/session` response (`ClankyEveSessionResponse`). */
export const EveSessionResponseSchema = z.object({
  ok: z.boolean(),
  sessionId: z.string(),
  continuationToken: z.string().optional(),
});
export type EveSessionResponse = z.infer<typeof EveSessionResponseSchema>;

/** One `parts[]` entry of a multimodal session message body. */
export const EveTextPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});
export const EveFilePartSchema = z.object({
  type: z.literal("file"),
  filename: z.string(),
  mediaType: z.string(),
  data: z.string(),
});
export const EveMessagePartSchema = z.discriminatedUnion("type", [EveTextPartSchema, EveFilePartSchema]);
export type EveMessagePart = z.infer<typeof EveMessagePartSchema>;

/** A session `message` field: bare text, or an array of multimodal parts. */
export const EveMessagePayloadSchema = z.union([z.string(), z.array(EveMessagePartSchema)]);
export type EveMessagePayload = z.infer<typeof EveMessagePayloadSchema>;

/** Body for `POST /eve/v1/session` (create a session). */
export const EveCreateSessionRequestSchema = z.object({
  message: EveMessagePayloadSchema,
  mode: z.string().optional(),
});
export type EveCreateSessionRequest = z.infer<typeof EveCreateSessionRequestSchema>;

/** Body for `POST /eve/v1/session/:id` (continue a session). */
export const EveContinueSessionRequestSchema = z.object({
  continuationToken: z.string(),
  message: EveMessagePayloadSchema,
});
export type EveContinueSessionRequest = z.infer<typeof EveContinueSessionRequestSchema>;

/** One answer to a pending `input.requested`. */
export const EveInputResponseSchema = z.object({
  requestId: z.string(),
  optionId: z.string().optional(),
  text: z.string().optional(),
});
export type EveInputResponse = z.infer<typeof EveInputResponseSchema>;

/** Body for `POST /eve/v1/session/:id` that answers pending input requests. */
export const EveInputResponseRequestSchema = z.object({
  continuationToken: z.string(),
  inputResponses: z.array(EveInputResponseSchema),
});
export type EveInputResponseRequest = z.infer<typeof EveInputResponseRequestSchema>;
