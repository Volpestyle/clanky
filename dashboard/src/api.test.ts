import { test } from "bun:test";
import assert from "node:assert/strict";

async function withApiModule(run) {
  const priorLocalStorage = globalThis.localStorage;
  const storage = new Map<string, string>();

  globalThis.localStorage = {
    get length() {
      return storage.size;
    },
    clear() {
      storage.clear();
    },
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    key(index) {
      const keys = [...storage.keys()];
      return keys[index] ?? null;
    },
    removeItem(key) {
      storage.delete(String(key));
    },
    setItem(key, value) {
      storage.set(String(key), String(value));
    }
  };

  try {
    storage.set("dashboard_token", "legacy-token");
    const stamp = `${Date.now()}-${Math.random()}`;
    const apiModule = await import(`./api.ts?${stamp}`);
    await run(apiModule, storage);
  } finally {
    globalThis.localStorage = priorLocalStorage;
  }
}

async function withMockFetch(handler, run) {
  const priorFetch = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    await run();
  } finally {
    globalThis.fetch = priorFetch;
  }
}

test("dashboard api clears legacy localStorage token on load", async () => {
  await withApiModule(async (_apiModule, storage) => {
    assert.equal(storage.has("dashboard_token"), false);
  });
});

test("dashboard api sends same-origin credentials without dashboard token header", async () => {
  await withApiModule(async (apiModule) => {
    let seenOptions = null;
    await withMockFetch(
      async (_url, options) => {
        seenOptions = options;
        return {
          ok: true,
          async json() {
            return { ok: true };
          }
        };
      },
      async () => {
        const result = await apiModule.api("/api/settings", {
          method: "PUT",
          body: {
            foo: "bar"
          }
        });
        assert.deepEqual(result, { ok: true });
      }
    );

    assert.equal(seenOptions.method, "PUT");
    assert.equal(seenOptions.credentials, "same-origin");
    assert.equal(seenOptions.headers["Content-Type"], "application/json");
    assert.equal("x-dashboard-token" in seenOptions.headers, false);
    assert.equal(seenOptions.body, JSON.stringify({ foo: "bar" }));
  });
});

test("dashboard auth session login posts the provided token", async () => {
  await withApiModule(async (apiModule) => {
    let seenUrl = "";
    let seenOptions = null;
    await withMockFetch(
      async (url, options) => {
        seenUrl = String(url);
        seenOptions = options;
        return {
          ok: true,
          async json() {
            return {
              authenticated: true,
              requiresToken: true,
              publicHttpsEnabled: true,
              authMethod: "session",
              configurationError: null
            };
          }
        };
      },
      async () => {
        const result = await apiModule.createDashboardSession("token-123");
        assert.equal(result.authenticated, true);
        assert.equal(result.authMethod, "session");
      }
    );

    assert.equal(seenUrl, "/api/auth/session");
    assert.equal(seenOptions.method, "POST");
    assert.equal(seenOptions.credentials, "same-origin");
    assert.equal(seenOptions.body, JSON.stringify({ token: "token-123" }));
  });
});

test("dashboard api throws structured error on non-ok responses", async () => {
  await withApiModule(async (apiModule) => {
    await withMockFetch(
      async () => ({
        ok: false,
        status: 401,
        async text() {
          return "unauthorized";
        }
      }),
      async () => {
        await assert.rejects(
          () => apiModule.api("/api/settings"),
          /API 401: unauthorized/
        );
      }
    );
  });
});

test("dashboard api preserves JSON error bodies for callers that handle conflicts", async () => {
  await withApiModule(async (apiModule) => {
    await withMockFetch(
      async () => ({
        ok: false,
        status: 409,
        headers: {
          get(name) {
            return name.toLowerCase() === "content-type" ? "application/json" : null;
          }
        },
        async text() {
          return JSON.stringify({
            error: "settings_conflict",
            detail: "Reload the latest settings."
          });
        }
      }),
      async () => {
        try {
          await apiModule.api("/api/settings");
          assert.fail("expected api() to throw");
        } catch (error) {
          assert.equal(error instanceof apiModule.ApiError, true);
          assert.equal(error.status, 409);
          assert.deepEqual(error.body, {
            error: "settings_conflict",
            detail: "Reload the latest settings."
          });
        }
      }
    );
  });
});
