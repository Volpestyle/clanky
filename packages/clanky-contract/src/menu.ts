import { z } from "zod";

/**
 * Native slash-command menu protocol. The relay `command` op streams these menu
 * events as `RelayStreamFrame.body`; the client answers via the
 * `command-client` op carrying a {@link MenuClientMessage}. These payloads are
 * camelCase on the wire.
 */

/** One selectable option in a `menu.select` step (or a status action). */
export const MenuOptionSchema = z.object({
  value: z.string(),
  label: z.string().optional(),
  hint: z.string().optional(),
  description: z.string().optional(),
});
export type MenuOption = z.infer<typeof MenuOptionSchema>;

// Every server menu event carries the invocation-scoping `sessionId`
// (ClankyMenuServerEvent in the agent's clanky-menu-protocol.ts; the relay also
// stamps it on the `menu.failed` it synthesizes when the command host drops).
// Optional here so a hostless/legacy frame still parses.
const sessionIdField = { sessionId: z.string().optional() };

export const MenuBeginEventSchema = z.object({
  type: z.literal("menu.begin"),
  ...sessionIdField,
  command: z.string().optional(),
  title: z.string().optional(),
});

export const MenuSelectEventSchema = z.object({
  type: z.literal("menu.select"),
  ...sessionIdField,
  stepId: z.string().optional(),
  message: z.string().optional(),
  kind: z.string().optional(),
  options: z.array(MenuOptionSchema).optional(),
  statusActions: z.array(MenuOptionSchema).optional(),
  currentValues: z.array(z.string()).optional(),
  required: z.boolean().optional(),
  allowBack: z.boolean().optional(),
});

export const MenuTextEventSchema = z.object({
  type: z.literal("menu.text"),
  ...sessionIdField,
  stepId: z.string().optional(),
  message: z.string().optional(),
  placeholder: z.string().optional(),
  defaultValue: z.string().optional(),
  allowBack: z.boolean().optional(),
});

export const MenuLineEventSchema = z.object({
  type: z.literal("menu.line"),
  ...sessionIdField,
  text: z.string().optional(),
  tone: z.string().optional(),
});

export const MenuStatusEventSchema = z.object({
  type: z.literal("menu.status"),
  ...sessionIdField,
  text: z.string().optional(),
});

export const MenuEndEventSchema = z.object({
  type: z.literal("menu.end"),
  ...sessionIdField,
  message: z.string().optional(),
});

export const MenuFailedEventSchema = z.object({
  type: z.literal("menu.failed"),
  ...sessionIdField,
  message: z.string().optional(),
});

/** A menu event streamed by the `command` op. `menu.end`/`menu.failed` are terminal. */
export const MenuEventSchema = z.discriminatedUnion("type", [
  MenuBeginEventSchema,
  MenuSelectEventSchema,
  MenuTextEventSchema,
  MenuLineEventSchema,
  MenuStatusEventSchema,
  MenuEndEventSchema,
  MenuFailedEventSchema,
]);
export type MenuEvent = z.infer<typeof MenuEventSchema>;

// Client → host menu responses, wrapped in the `command-client` op's `message`.
export const MenuRespondMessageSchema = z.object({
  type: z.literal("menu.respond"),
  sessionId: z.string(),
  stepId: z.string(),
  values: z.array(z.string()).optional(),
  text: z.string().optional(),
});

export const MenuBackMessageSchema = z.object({
  type: z.literal("menu.back"),
  sessionId: z.string(),
  stepId: z.string(),
});

export const MenuCancelMessageSchema = z.object({
  type: z.literal("menu.cancel"),
  sessionId: z.string(),
});

/** A client's reply to a menu step, sent as the `command-client` op's `message`. */
export const MenuClientMessageSchema = z.discriminatedUnion("type", [
  MenuRespondMessageSchema,
  MenuBackMessageSchema,
  MenuCancelMessageSchema,
]);
export type MenuClientMessage = z.infer<typeof MenuClientMessageSchema>;
