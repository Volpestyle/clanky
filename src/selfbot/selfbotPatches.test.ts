import { describe, it, expect, beforeEach } from "bun:test";
import { createRequire } from "node:module";
import path from "node:path";
import { Client, GatewayIntentBits } from "discord.js";
import {
  applySelfbotPatches,
  getDiscordAuthorizationHeaderValue,
  sendGatewayPayload,
  onRawDispatch,
} from "./selfbotPatches.ts";

const require = createRequire(import.meta.url);
const DISCORD_JS_HANDLERS_PATH = (() => {
  try {
    return require.resolve("discord.js/src/client/websocket/handlers/index.js");
  } catch {
    return path.resolve(process.cwd(), "node_modules/discord.js/src/client/websocket/handlers/index.js");
  }
})();

// ---------------------------------------------------------------------------
// Minimal fakes that mirror the discord.js internal shapes we patch
// ---------------------------------------------------------------------------

function createFakeRest() {
  let storedToken: string | null = null;
  const getRequests: string[] = [];
  return {
    options: { authPrefix: "Bot" },
    setToken(token: string) {
      storedToken = token;
    },
    get storedToken() {
      return storedToken;
    },
    getRequests,
    async resolveRequest(request: Record<string, unknown>) {
      const authPrefix =
        (request.authPrefix as string | undefined) ?? this.options.authPrefix;
      return {
        url: "/test",
        fetchOptions: {
          headers: {
            Authorization: `${authPrefix} ${storedToken ?? "tok_abc"}`,
          },
          method: "GET",
        },
      };
    },
    async get(route: string) {
      getRequests.push(route);
      if (route === "/gateway") {
        return { url: "wss://gateway.discord.gg" };
      }
      throw new Error(`unexpected route: ${route}`);
    },
  };
}

function createFakeClient() {
  const rest = createFakeRest();
  const listeners = new Map<string, Array<(data: unknown, extra?: unknown) => void>>();
  const ws = {
    _ws: null as null | {
      options?: Record<string, unknown>;
      gatewayInformation?: { data: unknown; expiresAt: number } | null;
      fetchGatewayInformation?: (force?: boolean) => Promise<unknown>;
      send?: (shardId: number, payload: { op: number; d: unknown }) => void;
    },
    shards: {
      first() {
        return { id: 0 };
      },
    },
  };
  return {
    rest,
    ws,
    on(event: string, cb: (data: unknown, extra?: unknown) => void) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(cb);
    },
    emit(event: string, data: unknown, extra?: unknown) {
      for (const cb of listeners.get(event) ?? []) cb(data, extra);
    },
    _listeners: listeners,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("selfbotPatches", () => {
  describe("REST auth", () => {
    it("normalizes raw Discord auth to a bare trimmed token", () => {
      expect(getDiscordAuthorizationHeaderValue("  user_token_123  ")).toBe(
        "user_token_123"
      );
    });

    it("strips 'Bot ' prefix from Authorization header", async () => {
      const client = createFakeClient();
      client.rest.setToken("user_token_123");
      applySelfbotPatches(client as never);

      const result = await client.rest.resolveRequest({});
      expect(result.fetchOptions.headers.Authorization).toBe("user_token_123");
    });

    it("leaves non-Bot-prefixed auth headers unchanged", async () => {
      const client = createFakeClient();
      client.rest.setToken("user_token_123");
      applySelfbotPatches(client as never);

      // Simulate a request that already has custom authPrefix
      const originalResolve = client.rest.resolveRequest.bind(client.rest);
      const saved = client.rest.resolveRequest;
      // Temporarily restore to produce a non-Bot header for testing
      // (the patch wraps the original, so we test the wrapper behavior)
      const result = await saved.call(client.rest, { authPrefix: "Bearer" });
      // Bearer prefix should not be stripped (only "Bot " is stripped)
      expect(result.fetchOptions.headers.Authorization).toBe(
        "Bearer user_token_123"
      );
    });
  });

  describe("gateway identify properties", () => {
    it("patches identifyProperties when _ws is assigned", () => {
      const client = createFakeClient();
      applySelfbotPatches(client as never);

      // Simulate discord.js creating the internal WSWebSocketManager
      const fakeWsManager = {
        options: {
          identifyProperties: {
            browser: "@discordjs/ws 1.2.3",
            device: "@discordjs/ws 1.2.3",
            os: "linux",
          },
          rest: client.rest,
        },
        gatewayInformation: null,
        fetchGatewayInformation: async () => ({}),
        send: () => {},
      };

      client.ws._ws = fakeWsManager;

      expect(fakeWsManager.options.identifyProperties).toEqual({
        os: "Windows",
        browser: "Discord Client",
        device: "",
      });
    });

    it("does not throw when _ws is set to null", () => {
      const client = createFakeClient();
      applySelfbotPatches(client as never);
      expect(() => {
        client.ws._ws = null;
      }).not.toThrow();
    });
  });

  describe("gateway URL", () => {
    it("patches fetchGatewayInformation to use /gateway", async () => {
      const client = createFakeClient();
      applySelfbotPatches(client as never);

      const fakeWsManager = {
        options: {
          identifyProperties: {},
          rest: client.rest,
        },
        gatewayInformation: null as null | { data: unknown; expiresAt: number },
        fetchGatewayInformation: async () => ({}),
        send: () => {},
      };

      client.ws._ws = fakeWsManager;

      const result = await fakeWsManager.fetchGatewayInformation();
      expect(result.url).toBe("wss://gateway.discord.gg");
      expect(result.shards).toBe(1);
      expect(result.session_start_limit).toBeDefined();
      expect(result.session_start_limit.total).toBe(1000);

      // Verify it hit /gateway not /gateway/bot
      expect(client.rest.getRequests).toContain("/gateway");
      expect(client.rest.getRequests).not.toContain("/gateway/bot");
    });

    it("caches gateway info and returns it on subsequent calls", async () => {
      const client = createFakeClient();
      applySelfbotPatches(client as never);

      const fakeWsManager = {
        options: {
          identifyProperties: {},
          rest: client.rest,
        },
        gatewayInformation: null as null | { data: unknown; expiresAt: number },
        fetchGatewayInformation: async () => ({}),
        send: () => {},
      };

      client.ws._ws = fakeWsManager;

      await fakeWsManager.fetchGatewayInformation();
      const requestCountAfterFirst = client.rest.getRequests.length;

      await fakeWsManager.fetchGatewayInformation();
      // Should not have made another request (cached)
      expect(client.rest.getRequests.length).toBe(requestCountAfterFirst);
    });
  });

  describe("gateway READY handling", () => {
    it("patches discord.js READY handling when selfbot READY payload omits application", () => {
      const handlers = require(DISCORD_JS_HANDLERS_PATH);
      const client = new Client({
        intents: [GatewayIntentBits.Guilds],
      });
      applySelfbotPatches(client);

      expect(() => {
        handlers.READY(
          client,
          {
            t: "READY",
            d: {
              user: {
                id: "123456789012345678",
                username: "selfbot-user",
                discriminator: "0",
                avatar: null,
                bot: false,
              },
              guilds: [],
            },
          },
          {
            id: 0,
            checkReady() {},
          }
        );
      }).not.toThrow();

      expect(client.application?.id).toBe("123456789012345678");
      expect(client.application?.name).toBe("selfbot-user");
    });
  });

  describe("sendGatewayPayload", () => {
    it("sends a raw payload through the internal WS manager", () => {
      const client = createFakeClient();
      applySelfbotPatches(client as never);

      const sent: Array<{ shardId: number; payload: unknown }> = [];
      const fakeWsManager = {
        options: { identifyProperties: {}, rest: client.rest },
        gatewayInformation: null,
        fetchGatewayInformation: async () => ({}),
        send(shardId: number, payload: unknown) {
          sent.push({ shardId, payload });
        },
      };
      client.ws._ws = fakeWsManager;

      sendGatewayPayload(client as never, { op: 20, d: { stream_key: "guild:123:456" } });

      expect(sent).toHaveLength(1);
      expect(sent[0].shardId).toBe(0);
      expect(sent[0].payload).toEqual({ op: 20, d: { stream_key: "guild:123:456" } });
    });
  });

  describe("onRawDispatch", () => {
    it("filters and routes raw dispatch events by type", () => {
      const client = createFakeClient();
      applySelfbotPatches(client as never);

      const received: Array<Record<string, unknown>> = [];
      onRawDispatch(client as never, "STREAM_CREATE", (data) => {
        received.push(data);
      });

      // Emit a STREAM_CREATE
      client.emit("raw", { t: "STREAM_CREATE", d: { stream_key: "guild:1:2" } });

      // Emit an unrelated event
      client.emit("raw", { t: "MESSAGE_CREATE", d: { content: "hi" } });

      expect(received).toHaveLength(1);
      expect(received[0].stream_key).toBe("guild:1:2");
    });
  });
});
