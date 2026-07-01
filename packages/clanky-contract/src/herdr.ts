import { z } from "zod";
import { JsonValueSchema } from "./json.ts";

/**
 * Herdr entities and relay op results, cross-checked against the shapes the
 * relay `dispatch()` returns (agent/channels/relay.ts). Wire keys are
 * snake_case, as emitted by herdr and the relay.
 */

/** One pane in the herdr tree (`pane.list`, `pane.get`, list ops). */
export const HerdrPaneSchema = z.object({
  agent: z.string().optional(),
  agent_status: z.string().optional(),
  custom_status: z.string().optional(),
  cwd: z.string().optional(),
  display_agent: z.string().optional(),
  focused: z.boolean().optional(),
  foreground_cwd: z.string().optional(),
  label: z.string().optional(),
  pane_id: z.string(),
  revision: z.number().optional(),
  state_labels: z.record(z.string(), z.string()).optional(),
  tab_id: z.string(),
  terminal_id: z.string().optional(),
  title: z.string().optional(),
  workspace_id: z.string(),
});
export type HerdrPane = z.infer<typeof HerdrPaneSchema>;

/** One workspace in the herdr tree (`workspace.list`). */
export const HerdrWorkspaceSchema = z.object({
  workspace_id: z.string(),
  active_tab_id: z.string().optional(),
  agent_status: z.string().optional(),
  focused: z.boolean().optional(),
  label: z.string().optional(),
  number: z.number().optional(),
  pane_count: z.number().optional(),
  tab_count: z.number().optional(),
});
export type HerdrWorkspace = z.infer<typeof HerdrWorkspaceSchema>;

/** One tab in the herdr tree (`tab.list`). */
export const HerdrTabSchema = z.object({
  tab_id: z.string(),
  workspace_id: z.string(),
  agent_status: z.string().optional(),
  focused: z.boolean().optional(),
  label: z.string().optional(),
  number: z.number().optional(),
  pane_count: z.number().optional(),
});
export type HerdrTab = z.infer<typeof HerdrTabSchema>;

/** One herdr session on the host, as reported by the relay `sessions` op. */
export const HerdrSessionSchema = z.object({
  name: z.string(),
  default: z.boolean(),
  running: z.boolean(),
  socket_path: z.string().optional(),
  session_dir: z.string().optional(),
});
export type HerdrSession = z.infer<typeof HerdrSessionSchema>;

/** Result of the relay `sessions` op. `bound` is the relay's env-bound session. */
export const HerdrSessionListSchema = z.object({
  sessions: z.array(HerdrSessionSchema),
  bound: z.string().optional(),
});
export type HerdrSessionList = z.infer<typeof HerdrSessionListSchema>;

// List-op envelopes (each carries an optional `type` discriminator herdr stamps).
export const HerdrWorkspaceListSchema = z.object({
  type: z.string().optional(),
  workspaces: z.array(HerdrWorkspaceSchema),
});
export type HerdrWorkspaceList = z.infer<typeof HerdrWorkspaceListSchema>;

export const HerdrTabListSchema = z.object({
  type: z.string().optional(),
  tabs: z.array(HerdrTabSchema),
});
export type HerdrTabList = z.infer<typeof HerdrTabListSchema>;

export const HerdrPaneListSchema = z.object({
  type: z.string().optional(),
  panes: z.array(HerdrPaneSchema),
});
export type HerdrPaneList = z.infer<typeof HerdrPaneListSchema>;

export const HerdrAgentListSchema = z.object({
  type: z.string().optional(),
  agents: z.array(HerdrPaneSchema),
});
export type HerdrAgentList = z.infer<typeof HerdrAgentListSchema>;

/** The inner `read` payload of a pane/agent read. */
export const HerdrReadSchema = z.object({
  pane_id: z.string().optional(),
  workspace_id: z.string().optional(),
  tab_id: z.string().optional(),
  source: z.string().optional(),
  format: z.string().optional(),
  text: z.string(),
  revision: z.number().optional(),
  truncated: z.boolean().optional(),
});
export type HerdrRead = z.infer<typeof HerdrReadSchema>;

/**
 * Result of the relay `read` op. The relay returns several shapes here — a herdr
 * read envelope, a transcript read, or a `recent_unwrapped` fallback — so this is
 * the superset the Swift `ClankyHerdrReadResult` decodes. `runId` is camelCase on
 * the wire (unlike the surrounding snake_case herdr keys).
 */
export const HerdrReadResultSchema = z.object({
  type: z.string().optional(),
  read: HerdrReadSchema.optional(),
  source: z.string().optional(),
  fallback: z.boolean().optional(),
  fallbackReason: z.string().optional(),
  agent: z.string().optional(),
  runId: z.string().optional(),
  text: z.string().optional(),
  lines: z.number().optional(),
  herdr: JsonValueSchema.optional(),
});
export type HerdrReadResult = z.infer<typeof HerdrReadResultSchema>;

/**
 * Result of the relay `start` op. The started-agent identity may arrive nested
 * under `agent` (object), as a bare `agent` string, or flattened at the top
 * level — the Swift model resolves across all three.
 */
export const HerdrStartedAgentSchema = z.object({
  name: z.string().optional(),
  agent: z.string().optional(),
  pane_id: z.string().optional(),
  tab_id: z.string().optional(),
  workspace_id: z.string().optional(),
});
export type HerdrStartedAgent = z.infer<typeof HerdrStartedAgentSchema>;

export const HerdrStartResultSchema = z.object({
  agent: z.union([HerdrStartedAgentSchema, z.string()]).optional(),
  name: z.string().optional(),
  agent_name: z.string().optional(),
  pane_id: z.string().optional(),
  tab_id: z.string().optional(),
  workspace_id: z.string().optional(),
});
export type HerdrStartResult = z.infer<typeof HerdrStartResultSchema>;

/** Result of the relay `create-tab` op. `layout` is the raw herdr `layout.apply` result. */
export const HerdrCreateTabResultSchema = z.object({
  workspace_id: z.string().optional(),
  tab_id: z.string().optional(),
  pane_id: z.string().optional(),
  layout: JsonValueSchema.optional(),
});
export type HerdrCreateTabResult = z.infer<typeof HerdrCreateTabResultSchema>;

/** Result of `pane.split` (invoked via the `api` op) — a single pane. */
export const HerdrPaneInfoResultSchema = z.object({
  type: z.string().optional(),
  pane: HerdrPaneSchema,
});
export type HerdrPaneInfoResult = z.infer<typeof HerdrPaneInfoResultSchema>;

/** Result of the relay `upload` op — a saved image plus its `@image` directive. */
export const RelayUploadResultSchema = z.object({
  type: z.string().optional(),
  kind: z.string(),
  path: z.string(),
  filename: z.string(),
  media_type: z.string(),
  bytes: z.number(),
  directive: z.string(),
});
export type RelayUploadResult = z.infer<typeof RelayUploadResultSchema>;

/** Result of the relay `register-push` op. */
export const PushRegistrationResponseSchema = z.object({
  ok: z.boolean().optional(),
  registered: z.boolean().optional(),
  /** Which platform the token was registered for (`ios` / `android`). */
  platform: z.string().optional(),
  apnsConfigured: z.boolean().optional(),
  fcmConfigured: z.boolean().optional(),
});
export type PushRegistrationResponse = z.infer<typeof PushRegistrationResponseSchema>;

/** Result of the relay `unregister-push` op. */
export const PushUnregistrationResponseSchema = z.object({
  ok: z.boolean().optional(),
  unregistered: z.boolean().optional(),
});
export type PushUnregistrationResponse = z.infer<typeof PushUnregistrationResponseSchema>;

/** One native skill/command from the relay `list-skills` op. */
export const SkillCommandSchema = z.object({
  name: z.string(),
  scope: z.string(),
  path: z.string(),
  description: z.string(),
  whenToUse: z.string().optional(),
  source: z.string().optional(),
  runtimeName: z.string().optional(),
});
export type SkillCommand = z.infer<typeof SkillCommandSchema>;

/** Result of the relay `list-skills` op. */
export const SkillListResponseSchema = z.object({
  type: z.string().optional(),
  agentMdEnabled: z.boolean().optional(),
  skills: z.array(SkillCommandSchema),
});
export type SkillListResponse = z.infer<typeof SkillListResponseSchema>;

/** Face/command-host presence counts, as reported by `GET /relay/health`. */
export const FacePresenceSchema = z.object({
  attached: z.boolean(),
  count: z.number(),
});
export type FacePresence = z.infer<typeof FacePresenceSchema>;

/**
 * Body of `GET /relay/health` (the HTTP probe, distinct from the `health` WS op
 * that proxies herdr `ping`). The success shape carries `herdr`/`face`/
 * `commandHost`; the 502 shape carries `error` instead.
 */
export const RelayHealthSchema = z.object({
  ok: z.boolean(),
  herdr: JsonValueSchema.optional(),
  error: z.string().optional(),
  face: FacePresenceSchema.optional(),
  commandHost: FacePresenceSchema.optional(),
});
export type RelayHealth = z.infer<typeof RelayHealthSchema>;
