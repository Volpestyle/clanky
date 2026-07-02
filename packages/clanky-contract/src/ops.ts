import { z } from "zod";
import { JsonObjectSchema, JsonValueSchema } from "./json.ts";
import { RelayIdSchema } from "./envelope.ts";
import { RelaySubscriptionSchema } from "./streaming.ts";
import { MenuClientMessageSchema } from "./menu.ts";
import {
  HerdrAgentListSchema,
  HerdrCreateTabResultSchema,
  HerdrPaneListSchema,
  HerdrReadResultSchema,
  HerdrSessionListSchema,
  HerdrStartResultSchema,
  HerdrTabListSchema,
  HerdrWorkspaceListSchema,
  PushRegistrationResponseSchema,
  PushUnregistrationResponseSchema,
  RelayUploadResultSchema,
  SkillListResponseSchema,
} from "./herdr.ts";

/**
 * Per-op request args and result schemas for the relay WebSocket protocol
 * (`dispatch()` + the streaming/control op handlers in agent/channels/relay.ts).
 * Every op accepts an optional `session` arg; the relay funnels it to target a
 * specific herdr session, or falls back to its env-bound session when absent.
 */

// Shared across every op: the herdr-session selector the relay honors.
const sessionArg = { session: z.string().optional() };

// --- Request/response op args (routed through dispatch) ---------------------

/** `api`: raw herdr socket passthrough. */
export const ApiArgsSchema = z.object({
  method: z.string(),
  params: JsonObjectSchema.optional(),
  ...sessionArg,
});
export type ApiArgs = z.infer<typeof ApiArgsSchema>;

/** `health`: proxies herdr `ping`. (Distinct from `GET /relay/health`.) */
export const HealthArgsSchema = z.object({ ...sessionArg });
export type HealthArgs = z.infer<typeof HealthArgsSchema>;

/** `list`: herdr `agent.list`. */
export const ListArgsSchema = z.object({ ...sessionArg });
export type ListArgs = z.infer<typeof ListArgsSchema>;

/** `sessions`: enumerate herdr sessions on the host. */
export const SessionsArgsSchema = z.object({ ...sessionArg });
export type SessionsArgs = z.infer<typeof SessionsArgsSchema>;

/** `list-skills`: native slash-command inventory. */
export const ListSkillsArgsSchema = z.object({ ...sessionArg });
export type ListSkillsArgs = z.infer<typeof ListSkillsArgsSchema>;

/** `workspaces`: herdr `workspace.list`. */
export const WorkspacesArgsSchema = z.object({ ...sessionArg });
export type WorkspacesArgs = z.infer<typeof WorkspacesArgsSchema>;

/** `tabs`: herdr `tab.list`, optionally scoped to a workspace. */
export const TabsArgsSchema = z.object({
  workspace_id: z.string().optional(),
  ...sessionArg,
});
export type TabsArgs = z.infer<typeof TabsArgsSchema>;

/** `panes`: herdr `pane.list`, optionally scoped to a workspace. */
export const PanesArgsSchema = z.object({
  workspace_id: z.string().optional(),
  ...sessionArg,
});
export type PanesArgs = z.infer<typeof PanesArgsSchema>;

/** `create-tab`: apply a one-pane layout as a new tab. Requires `argv[]`. */
export const CreateTabArgsSchema = z.object({
  argv: z.array(z.string()),
  workspace_id: z.string().optional(),
  cwd: z.string().optional(),
  label: z.string().optional(),
  focus: z.boolean().optional(),
  ...sessionArg,
});
export type CreateTabArgs = z.infer<typeof CreateTabArgsSchema>;

/** `get`: fetch a pane or agent. Exactly one of `agent`/`pane` is set. */
export const GetArgsSchema = z.object({
  agent: z.string().optional(),
  pane: z.string().optional(),
  ...sessionArg,
});
export type GetArgs = z.infer<typeof GetArgsSchema>;

/** `read`: read a pane or agent's output/transcript. */
export const ReadArgsSchema = z.object({
  agent: z.string().optional(),
  pane: z.string().optional(),
  source: z.string().optional(),
  lines: z.number().optional(),
  format: z.string().optional(),
  strip_ansi: z.boolean().optional(),
  ...sessionArg,
});
export type ReadArgs = z.infer<typeof ReadArgsSchema>;

/** `send`: submit a line (herdr appends Enter) to a pane or agent. */
export const SendArgsSchema = z.object({
  agent: z.string().optional(),
  pane: z.string().optional(),
  text: z.string(),
  ...sessionArg,
});
export type SendArgs = z.infer<typeof SendArgsSchema>;

/** `run`: submit a line to a pane (herdr appends Enter). */
export const RunArgsSchema = z.object({
  pane: z.string(),
  text: z.string(),
  ...sessionArg,
});
export type RunArgs = z.infer<typeof RunArgsSchema>;

/** `keys`: send named keys to a pane. `t0` is the client-side send timestamp
 *  (Date.now()) for latency tracing; the relay ignores unknown args. */
export const KeysArgsSchema = z.object({
  pane: z.string(),
  keys: z.array(z.string()),
  t0: z.number().optional(),
  ...sessionArg,
});
export type KeysArgs = z.infer<typeof KeysArgsSchema>;

/** `upload`: save a base64 image and get back an `@image` directive. */
export const UploadArgsSchema = z.object({
  kind: z.string(),
  data: z.string(),
  filename: z.string().optional(),
  media_type: z.string().optional(),
  ...sessionArg,
});
export type UploadArgs = z.infer<typeof UploadArgsSchema>;

/** `start`: spawn a herdr agent, optionally placed relative to an existing pane. */
export const StartArgsSchema = z.object({
  name: z.string(),
  argv: z.array(z.string()),
  cwd: z.string().optional(),
  workspace_id: z.string().optional(),
  tab_id: z.string().optional(),
  target_pane_id: z.string().optional(),
  split: z.enum(["right", "down"]).optional(),
  focus: z.boolean().optional(),
  transcript: z.boolean().optional(),
  ...sessionArg,
});
export type StartArgs = z.infer<typeof StartArgsSchema>;

/** `close`: close a pane. */
export const CloseArgsSchema = z.object({
  pane: z.string(),
  ...sessionArg,
});
export type CloseArgs = z.infer<typeof CloseArgsSchema>;

/** `register-push`: register this device's APNs token for agent-state pushes. */
export const RegisterPushArgsSchema = z.object({
  token: z.string(),
  events: z.array(z.string()).optional(),
  platform: z.string().optional(),
  ...sessionArg,
});
export type RegisterPushArgs = z.infer<typeof RegisterPushArgsSchema>;

/** `unregister-push`: drop a previously registered APNs token. */
export const UnregisterPushArgsSchema = z.object({
  token: z.string(),
  ...sessionArg,
});
export type UnregisterPushArgs = z.infer<typeof UnregisterPushArgsSchema>;

/** `write`: raw verbatim keystrokes to a pane (no trailing Enter). `t0` is the
 *  client-side send timestamp (Date.now()) for latency tracing. */
export const WriteArgsSchema = z.object({
  pane: z.string(),
  text: z.string(),
  t0: z.number().optional(),
  ...sessionArg,
});
export type WriteArgs = z.infer<typeof WriteArgsSchema>;

/** `chat.mirror`: materialize (or revalidate by handle) a native chat's herdr
 *  pane mirror. Optional `tab_id`/`pane_id` are the device-remembered handles
 *  from a prior call (reuse the same tab); absent → create a fresh mirror tab.
 *  For fresh mirrors, `workspace_id` targets an existing workspace and wins over
 *  `workspace_label`, which find-or-creates by label; absent → default workspace. */
export const ChatMirrorArgsSchema = z.object({
  session_id: z.string(),
  slug: z.string(),
  title: z.string().optional(),
  tab_id: z.string().optional(),
  pane_id: z.string().optional(),
  workspace_id: z.string().optional(),
  workspace_label: z.string().optional(),
  ...sessionArg,
});
export type ChatMirrorArgs = z.infer<typeof ChatMirrorArgsSchema>;

/** `chat.close`: tear down a chat's mirror pane (and its tab when `close_tab`). */
export const ChatCloseArgsSchema = z.object({
  tab_id: z.string().optional(),
  pane_id: z.string().optional(),
  close_tab: z.boolean().optional(),
  ...sessionArg,
});
export type ChatCloseArgs = z.infer<typeof ChatCloseArgsSchema>;

/** Result of `chat.mirror` — the herdr handles that pin the chat's mirror tab. */
export const ChatMirrorResultSchema = z.object({
  workspace_id: z.string(),
  tab_id: z.string(),
  pane_id: z.string(),
});
export type ChatMirrorResult = z.infer<typeof ChatMirrorResultSchema>;

/** Result of `chat.close` — whether the requested mirror handles were closed. */
export const ChatCloseResultSchema = z.object({
  closed_pane: z.boolean(),
  closed_tab: z.boolean(),
});
export type ChatCloseResult = z.infer<typeof ChatCloseResultSchema>;

// --- Streaming / control op args -------------------------------------------

/** `subscribe`: open a realtime herdr-event stream. Requires `subscriptions[]`. */
export const SubscribeArgsSchema = z.object({
  subscriptions: z.array(RelaySubscriptionSchema),
  ...sessionArg,
});
export type SubscribeArgs = z.infer<typeof SubscribeArgsSchema>;

/** `unsubscribe`: close this peer's realtime event stream. */
export const UnsubscribeArgsSchema = z.object({ ...sessionArg });
export type UnsubscribeArgs = z.infer<typeof UnsubscribeArgsSchema>;

/** `attach`: open a live terminal stream for a pane. */
export const AttachArgsSchema = z.object({
  pane: z.string(),
  source: z.string().optional(),
  format: z.string().optional(),
  strip_ansi: z.boolean().optional(),
  interval_ms: z.number().optional(),
  lines: z.number().optional(),
  terminal_id: z.string().optional(),
  takeover: z.boolean().optional(),
  cols: z.number().optional(),
  rows: z.number().optional(),
  cell_width_px: z.number().optional(),
  cell_height_px: z.number().optional(),
  ...sessionArg,
});
export type AttachArgs = z.infer<typeof AttachArgsSchema>;

/** `detach`: close a live terminal stream (a specific pane, or all when omitted). */
export const DetachArgsSchema = z.object({
  pane: z.string().optional(),
  ...sessionArg,
});
export type DetachArgs = z.infer<typeof DetachArgsSchema>;

/** `resize`: resize a live attach stream's grid in place (sent on the SAME
 *  socket as the pane's `attach`). Replies `{ id, ok: true }` with no result;
 *  an error reply means the relay predates the op and the client should fall
 *  back to a full detach/attach at the new grid. */
export const ResizeArgsSchema = z.object({
  pane: z.string(),
  cols: z.number(),
  rows: z.number(),
  ...sessionArg,
});
export type ResizeArgs = z.infer<typeof ResizeArgsSchema>;

/** `ping`: connection-health probe on long-lived sockets (attach / input).
 *  Replies `{ id, ok: true, result: { t } }`; older relays answer with an error
 *  reply the client tolerates silently. */
export const PingArgsSchema = z.object({ ...sessionArg });
export type PingArgs = z.infer<typeof PingArgsSchema>;

/** Result of the `ping` op: the relay's ms timestamp. */
export const PingResultSchema = z.object({
  t: z.number(),
});
export type PingResult = z.infer<typeof PingResultSchema>;

/** `command`/`face-command`: run a native slash command; streams menu events. */
export const CommandArgsSchema = z.object({
  command_line: z.string(),
});
export type CommandArgs = z.infer<typeof CommandArgsSchema>;

/** `command-client`/`face-command-client`: client's answer to a menu step. */
export const CommandClientArgsSchema = z.object({
  request_id: z.string(),
  message: MenuClientMessageSchema,
});
export type CommandClientArgs = z.infer<typeof CommandClientArgsSchema>;

/** `command-event`/`face-command-event`: host → relay menu event forwarding. */
export const CommandEventArgsSchema = z.object({
  request_id: z.string().optional(),
  event: JsonValueSchema.optional(),
});
export type CommandEventArgs = z.infer<typeof CommandEventArgsSchema>;

/** Args for the presence toggles (`face-attach`/`command-attach`/...). The
 *  optional `pid` identifies the attaching companion process in `/relay/health`
 *  peer details; detach ops send none. */
export const PresenceAttachArgsSchema = z.object({
  pid: z.number().optional(),
});
export type PresenceAttachArgs = z.infer<typeof PresenceAttachArgsSchema>;

export const EmptyArgsSchema = z.object({});
export type EmptyArgs = z.infer<typeof EmptyArgsSchema>;

// --- Op name catalog --------------------------------------------------------

export const RELAY_OP_NAMES = [
  "api",
  "health",
  "list",
  "sessions",
  "list-skills",
  "workspaces",
  "tabs",
  "panes",
  "create-tab",
  "get",
  "read",
  "send",
  "run",
  "keys",
  "upload",
  "start",
  "close",
  "register-push",
  "unregister-push",
  "write",
  "chat.mirror",
  "chat.close",
  "subscribe",
  "unsubscribe",
  "attach",
  "detach",
  "resize",
  "ping",
  "face-attach",
  "face-detach",
  "command-attach",
  "command-detach",
  "command",
  "face-command",
  "command-event",
  "face-command-event",
  "command-client",
  "face-command-client",
] as const;

export const RelayOpNameSchema = z.enum(RELAY_OP_NAMES);
export type RelayOpName = z.infer<typeof RelayOpNameSchema>;

// --- Result schemas keyed by op (dispatch ops only) -------------------------

/**
 * The `result` shape each dispatch op resolves to. Ops whose result is raw herdr
 * JSON (`api`, `health`, `get`, `send`, `run`, `keys`, `close`, `write`) map to
 * `JsonValue`. The streaming/control ops are absent: they reply with ack facets
 * or stream frames, not a `result` (see `RelayAckReply`/`RelayStreamFrame`).
 */
export const OP_RESULT_SCHEMAS = {
  api: JsonValueSchema,
  health: JsonValueSchema,
  list: HerdrAgentListSchema,
  sessions: HerdrSessionListSchema,
  "list-skills": SkillListResponseSchema,
  workspaces: HerdrWorkspaceListSchema,
  tabs: HerdrTabListSchema,
  panes: HerdrPaneListSchema,
  "create-tab": HerdrCreateTabResultSchema,
  get: JsonValueSchema,
  read: HerdrReadResultSchema,
  send: JsonValueSchema,
  run: JsonValueSchema,
  keys: JsonValueSchema,
  upload: RelayUploadResultSchema,
  start: HerdrStartResultSchema,
  close: JsonValueSchema,
  "register-push": PushRegistrationResponseSchema,
  "unregister-push": PushUnregistrationResponseSchema,
  write: JsonValueSchema,
  "chat.mirror": ChatMirrorResultSchema,
  "chat.close": ChatCloseResultSchema,
  ping: PingResultSchema,
} as const;

// --- Per-op request discriminated union -------------------------------------

const req = <Name extends RelayOpName, Args extends z.ZodTypeAny>(op: Name, args: Args) =>
  z.object({ id: RelayIdSchema.optional(), op: z.literal(op), args: args.optional() });

/**
 * A relay request narrowed by its `op` to the matching args schema. Covers every
 * op the client can send; `face-attach`/`face-detach`/`command-attach`/
 * `command-detach` take no args.
 */
export const RelayRequestByOpSchema = z.discriminatedUnion("op", [
  req("api", ApiArgsSchema),
  req("health", HealthArgsSchema),
  req("list", ListArgsSchema),
  req("sessions", SessionsArgsSchema),
  req("list-skills", ListSkillsArgsSchema),
  req("workspaces", WorkspacesArgsSchema),
  req("tabs", TabsArgsSchema),
  req("panes", PanesArgsSchema),
  req("create-tab", CreateTabArgsSchema),
  req("get", GetArgsSchema),
  req("read", ReadArgsSchema),
  req("send", SendArgsSchema),
  req("run", RunArgsSchema),
  req("keys", KeysArgsSchema),
  req("upload", UploadArgsSchema),
  req("start", StartArgsSchema),
  req("close", CloseArgsSchema),
  req("register-push", RegisterPushArgsSchema),
  req("unregister-push", UnregisterPushArgsSchema),
  req("write", WriteArgsSchema),
  req("chat.mirror", ChatMirrorArgsSchema),
  req("chat.close", ChatCloseArgsSchema),
  req("subscribe", SubscribeArgsSchema),
  req("unsubscribe", UnsubscribeArgsSchema),
  req("attach", AttachArgsSchema),
  req("detach", DetachArgsSchema),
  req("resize", ResizeArgsSchema),
  req("ping", PingArgsSchema),
  req("face-attach", PresenceAttachArgsSchema),
  req("face-detach", EmptyArgsSchema),
  req("command-attach", PresenceAttachArgsSchema),
  req("command-detach", EmptyArgsSchema),
  req("command", CommandArgsSchema),
  req("face-command", CommandArgsSchema),
  req("command-event", CommandEventArgsSchema),
  req("face-command-event", CommandEventArgsSchema),
  req("command-client", CommandClientArgsSchema),
  req("face-command-client", CommandClientArgsSchema),
]);
export type RelayRequestByOp = z.infer<typeof RelayRequestByOpSchema>;
