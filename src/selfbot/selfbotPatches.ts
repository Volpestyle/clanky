/**
 * Patches discord.js v14 Client for user-token (selfbot) authentication.
 *
 * All discord.js monkey-patches are isolated in this module so they can be
 * reviewed and updated when upgrading discord.js versions.
 *
 * Patched behaviors:
 * 1. REST: Authorization header uses bare token (no "Bot " prefix)
 * 2. Gateway IDENTIFY: uses real Discord client properties
 * 3. Gateway URL: fetches /gateway instead of /gateway/bot
 *
 * discord.js version: 14.25.1
 * @discordjs/rest version: 2.6.0
 * @discordjs/ws version: 1.2.3
 */
import type { Client } from "discord.js";
import { createRequire } from "node:module";
import path from "node:path";

const SELFBOT_IDENTIFY_PROPERTIES = {
  os: "Windows",
  browser: "Discord Client",
  device: "",
};

const require = createRequire(import.meta.url);

function resolveDiscordJsHandlersPath() {
  try {
    return require.resolve("discord.js/src/client/websocket/handlers/index.js");
  } catch {
    return path.resolve(process.cwd(), "node_modules/discord.js/src/client/websocket/handlers/index.js");
  }
}

const DISCORD_JS_HANDLERS_PATH = resolveDiscordJsHandlersPath();

export function getDiscordAuthorizationHeaderValue(token: string): string {
  return String(token || "").trim();
}

/**
 * Apply all selfbot patches to a discord.js Client instance.
 * Must be called AFTER construction but BEFORE login().
 */
export function applySelfbotPatches(client: Client): void {
  patchRestAuth(client);
  patchReadyHandlerForSelfbotPayload();
  patchInternalWebSocketManager(client);
}

// ---------------------------------------------------------------------------
// REST: strip "Bot " prefix from Authorization header
// ---------------------------------------------------------------------------

/**
 * discord.js REST hardcodes `Authorization: Bot <token>` via authPrefix.
 * User tokens must send `Authorization: <token>` (no prefix).
 *
 * We wrap resolveRequest() to strip the prefix from the built headers.
 *
 * Patched location: @discordjs/rest/dist/index.js ~line 1383
 */
function patchRestAuth(client: Client): void {
  const resolveRequestValue = Reflect.get(client.rest, "resolveRequest");
  if (typeof resolveRequestValue !== "function") {
    return;
  }
  const originalResolveRequest = (request: Record<string, unknown>) =>
    Promise.resolve(resolveRequestValue.call(client.rest, request) as RestResolveRequestResult);

  Reflect.set(client.rest, "resolveRequest", async function (request: Record<string, unknown>) {
    const result = await originalResolveRequest(request);
    const headers = result?.fetchOptions?.headers;
    if (headers?.Authorization && typeof headers.Authorization === "string") {
      if (headers.Authorization.startsWith("Bot ")) {
        headers.Authorization = getDiscordAuthorizationHeaderValue(headers.Authorization.slice(4));
      }
    }
    return result;
  });
}

// ---------------------------------------------------------------------------
// Gateway: identify properties + /gateway URL
// ---------------------------------------------------------------------------

/**
 * Intercepts the internal WSWebSocketManager (_ws) assignment on the
 * discord.js WebSocketManager to apply two patches:
 *
 * 1. Set identifyProperties to real Discord client values so the IDENTIFY
 *    payload does not advertise "@discordjs/ws".
 *
 * 2. Override fetchGatewayInformation() to hit /gateway instead of
 *    /gateway/bot — the bot endpoint requires bot auth and returns
 *    bot-specific session limits that don't apply to user tokens.
 *
 * Timing: _ws is created in WebSocketManager.connect() (line 164) before
 * fetchGatewayInformation (line 172) and _ws.connect() (line 204). The
 * property interceptor fires synchronously on assignment, so both patches
 * take effect before any network calls.
 *
 * Patched locations:
 * - discord.js/src/client/websocket/WebSocketManager.js line 109, 164
 * - @discordjs/ws/dist/index.js lines 534-538 (identifyProperties)
 * - @discordjs/ws/dist/index.js line 1404 (fetchGatewayInformation)
 */
function patchInternalWebSocketManager(client: Client): void {
  const ws = client.ws;
  let wsInner: InternalWSManager | null = coerceInternalWsManager(Reflect.get(ws, "_ws"));

  Object.defineProperty(ws, "_ws", {
    get() {
      return wsInner;
    },
    set(value: unknown) {
      const nextWs = coerceInternalWsManager(value);
      wsInner = nextWs;
      if (nextWs?.options) {
        nextWs.options.identifyProperties = { ...SELFBOT_IDENTIFY_PROPERTIES };
        patchFetchGatewayInformation(nextWs);
      }
    },
    configurable: true,
    enumerable: true,
  });
}

/**
 * Replace fetchGatewayInformation to use GET /gateway (user endpoint)
 * instead of GET /gateway/bot.
 *
 * The /gateway endpoint returns `{ url: string }` without session_start_limit.
 * discord.js expects session_start_limit, so we synthesize reasonable defaults.
 */
function patchFetchGatewayInformation(wsManager: InternalWSManager): void {
  wsManager.fetchGatewayInformation = async function (force = false) {
    if (this.gatewayInformation) {
      if (this.gatewayInformation.expiresAt <= Date.now()) {
        this.gatewayInformation = null;
      } else if (!force) {
        return this.gatewayInformation.data;
      }
    }
    const data = (await this.options.rest.get("/gateway")) as GatewayResponse;
    const enriched = {
      url: data.url,
      shards: 1,
      session_start_limit: {
        total: 1000,
        remaining: 1000,
        reset_after: 14_400_000,
        max_concurrency: 1,
      },
    };
    this.gatewayInformation = {
      data: enriched,
      expiresAt: Date.now() + enriched.session_start_limit.reset_after,
    };
    return this.gatewayInformation.data;
  };
}

/**
 * discord.js assumes READY.d.application always exists because bot READY
 * payloads include it. User READY payloads do not. Patch the READY packet
 * handler to synthesize a minimal application object so ClientApplication
 * construction does not crash on startup.
 *
 * Patched location:
 * - discord.js/src/client/websocket/handlers/READY.js
 */
function patchReadyHandlerForSelfbotPayload(): void {
  const handlers = require(DISCORD_JS_HANDLERS_PATH) as {
    READY?: ((client: Client, packet: { d?: Record<string, unknown> }, shard: { id: number }) => void) & {
      __selfbotPatched?: boolean;
    };
  };
  const originalReady = handlers.READY;
  if (typeof originalReady !== "function" || originalReady.__selfbotPatched) {
    return;
  }

  const patchedReady = function (
    client: Client,
    packet: { d?: Record<string, unknown> },
    shard: { id: number }
  ) {
    const data = packet?.d;
    if (data && (!data.application || typeof data.application !== "object")) {
      packet = {
        ...packet,
        d: {
          ...data,
          application: buildSyntheticReadyApplication(data),
        },
      };
    }
    return originalReady(client, packet, shard);
  };
  patchedReady.__selfbotPatched = true;
  handlers.READY = patchedReady;
}

function buildSyntheticReadyApplication(data: Record<string, unknown>): Record<string, unknown> {
  const rawUser = data.user;
  const user =
    rawUser && typeof rawUser === "object" && !Array.isArray(rawUser)
      ? (rawUser as Record<string, unknown>)
      : null;
  const userId = String(user?.id || "").trim() || "0";
  const username = String(user?.username || "").trim() || "Discord User";
  return {
    id: userId,
    name: username,
    description: "",
    icon: null,
    flags: 0,
    bot_public: false,
    bot_require_code_grant: false,
  };
}

// ---------------------------------------------------------------------------
// Raw gateway helpers
// ---------------------------------------------------------------------------

/**
 * Send a raw gateway opcode payload through the first shard.
 * Use this for opcodes that discord.js doesn't expose, such as:
 *   OP20 STREAM_WATCH
 *   OP22 STREAM_SET_PAUSED
 */
export type GatewayRawDispatchPacket = {
  t?: string;
  d?: Record<string, unknown> | null;
};

type GatewayRawDispatchListener = (packet: GatewayRawDispatchPacket, shardId?: number) => void;

export interface GatewayDispatchClientLike {
  on: (event: string, callback: GatewayRawDispatchListener) => void;
  off?: (event: string, callback: GatewayRawDispatchListener) => void;
  removeListener?: (event: string, callback: GatewayRawDispatchListener) => void;
  ws: {
    _ws?: {
      send: (shardId: number, payload: { op: number; d: unknown }) => void;
    } | null;
    shards: {
      first: () => { id?: number } | null | undefined;
    };
  };
}

export function sendGatewayPayload(
  client: GatewayDispatchClientLike,
  payload: { op: number; d: unknown }
): void {
  const shardId = client.ws.shards.first()?.id ?? 0;
  client.ws._ws?.send(shardId, payload);
}

/**
 * Listen for raw gateway dispatch events, including undocumented ones like
 * STREAM_CREATE, STREAM_SERVER_UPDATE, STREAM_DELETE.
 *
 * discord.js emits Events.Raw for every dispatch event via:
 *   WebSocketManager.attachEvents() -> client.emit(Events.Raw, data, shardId)
 *
 * The callback receives the full gateway payload { t, d, s, op }.
 */
export function onRawDispatch(
  client: GatewayDispatchClientLike,
  eventName: string,
  callback: (data: Record<string, unknown>) => void
): () => void {
  const listener: GatewayRawDispatchListener = (packet) => {
    if (!packet || packet.t !== eventName) return;
    if (!packet.d || typeof packet.d !== "object" || Array.isArray(packet.d)) return;
    callback(packet.d);
  };
  client.on("raw", listener);
  return () => {
    if (typeof client.off === "function") {
      client.off("raw", listener);
      return;
    }
    if (typeof client.removeListener === "function") {
      client.removeListener("raw", listener);
    }
  };
}

// ---------------------------------------------------------------------------
// Internal types (not exported — these describe discord.js internals)
// ---------------------------------------------------------------------------

interface RestResolveRequestResult {
  url?: string;
  fetchOptions?: {
    headers?: Record<string, string>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function coerceInternalWsManager(value: unknown): InternalWSManager | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as InternalWSManager;
  if (!candidate.options || typeof candidate.options !== "object") return null;
  if (typeof candidate.fetchGatewayInformation !== "function") return null;
  return candidate;
}

interface InternalWSManager {
  options: {
    identifyProperties: { os: string; browser: string; device: string };
    rest: { get: (route: string) => Promise<unknown> };
    [key: string]: unknown;
  };
  gatewayInformation: {
    data: GatewayBotResponse;
    expiresAt: number;
  } | null;
  fetchGatewayInformation: (force?: boolean) => Promise<GatewayBotResponse>;
  send: (shardId: number, payload: { op: number; d: unknown }) => void;
}

interface GatewayResponse {
  url: string;
}

interface GatewayBotResponse {
  url: string;
  shards: number;
  session_start_limit: {
    total: number;
    remaining: number;
    reset_after: number;
    max_concurrency: number;
  };
}
