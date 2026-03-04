import assert from "node:assert/strict";
import { env } from "node:process";

type E2ESettingsSnapshot = {
  activity?: {
    replyLevelInitiative?: number;
    replyLevelNonInitiative?: number;
  };
  voice?: {
    replyEagerness?: number;
    thoughtEngine?: {
      eagerness?: number;
    };
  };
} & Record<string, unknown>;

let savedSettingsSnapshot: E2ESettingsSnapshot | null = null;
let activeOverrideCount = 0;

function envNumber(name: string, defaultValue: number): number {
  const value = env[name];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function getDashboardBaseUrl(): string {
  const host = String(env.DASHBOARD_HOST || "127.0.0.1").trim() || "127.0.0.1";
  const port = envNumber("DASHBOARD_PORT", 8787);
  return `http://${host}:${port}`;
}

function getDashboardHeaders(): Record<string, string> {
  const token = String(env.DASHBOARD_TOKEN || "").trim();
  return token ? { "x-dashboard-token": token } : {};
}

async function fetchDashboard(path: string, init?: RequestInit): Promise<Response> {
  const headers = {
    ...getDashboardHeaders(),
    ...(init?.headers || {})
  };
  return fetch(`${getDashboardBaseUrl()}${path}`, {
    ...init,
    headers
  });
}

async function getDashboardSettings(): Promise<E2ESettingsSnapshot> {
  const response = await fetchDashboard("/api/settings");
  assert.equal(response.status, 200, `Failed to read dashboard settings: ${response.status}`);
  return response.json();
}

async function putDashboardSettings(settings: unknown): Promise<E2ESettingsSnapshot> {
  const response = await fetchDashboard("/api/settings", {
    method: "PUT",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(settings)
  });
  assert.equal(response.status, 200, `Failed to update dashboard settings: ${response.status}`);
  return response.json();
}

export async function waitForDashboardReady(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetchDashboard("/api/health");
      if (response.ok) return;
      lastError = new Error(`Dashboard health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Dashboard did not become ready within ${timeoutMs}ms: ${String(lastError)}`);
}

export async function beginTemporaryE2EEagerness50(): Promise<void> {
  await waitForDashboardReady();
  activeOverrideCount += 1;
  if (activeOverrideCount > 1) return;

  try {
    savedSettingsSnapshot = await getDashboardSettings();

    const settings = await putDashboardSettings({
      activity: {
        replyLevelInitiative: 50,
        replyLevelNonInitiative: 50
      },
      voice: {
        replyEagerness: 50,
        thoughtEngine: {
          eagerness: 50
        }
      }
    });

    assert.equal(settings.activity?.replyLevelInitiative, 50);
    assert.equal(settings.activity?.replyLevelNonInitiative, 50);
    assert.equal(settings.voice?.replyEagerness, 50);
    assert.equal(settings.voice?.thoughtEngine?.eagerness, 50);
  } catch (error) {
    activeOverrideCount = 0;
    savedSettingsSnapshot = null;
    throw error;
  }
}

export async function restoreTemporaryE2ESettings(): Promise<void> {
  if (activeOverrideCount <= 0) return;
  activeOverrideCount -= 1;
  if (activeOverrideCount > 0) return;

  const snapshot = savedSettingsSnapshot;
  savedSettingsSnapshot = null;
  if (!snapshot) return;

  await waitForDashboardReady();
  const restored = await putDashboardSettings(snapshot);

  assert.equal(
    restored.activity?.replyLevelInitiative,
    snapshot.activity?.replyLevelInitiative
  );
  assert.equal(
    restored.activity?.replyLevelNonInitiative,
    snapshot.activity?.replyLevelNonInitiative
  );
  assert.equal(
    restored.voice?.replyEagerness,
    snapshot.voice?.replyEagerness
  );
  assert.equal(
    restored.voice?.thoughtEngine?.eagerness,
    snapshot.voice?.thoughtEngine?.eagerness
  );
}
