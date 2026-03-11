import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { env } from "node:process";
import { resolveE2EPipelineOverrides } from "./presets.ts";

type E2ESettingsSnapshot = {
  interaction?: {
    activity?: {
      ambientReplyEagerness?: number;
      responseWindowEagerness?: number;
      reactivity?: number;
    };
  };
  voice?: {
    conversationPolicy?: {
      ambientReplyEagerness?: number;
    };
  };
  initiative?: {
    voice?: {
      eagerness?: number;
    };
  };
} & Record<string, unknown>;

const SNAPSHOT_PATH = resolve(import.meta.dirname, "..", ".settings-snapshot.json");

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

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (
      srcVal !== null &&
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === "object" &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>
      );
    } else {
      result[key] = srcVal;
    }
  }
  return result;
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

export async function recoverStaleE2ESettings(): Promise<void> {
  if (!existsSync(SNAPSHOT_PATH)) return;
  const raw = readFileSync(SNAPSHOT_PATH, "utf-8");
  const staleSnapshot: E2ESettingsSnapshot = JSON.parse(raw);
  await putDashboardSettings(staleSnapshot);
  unlinkSync(SNAPSHOT_PATH);
}

export async function beginTemporaryE2ESettings(overrides: Record<string, unknown>): Promise<void> {
  await waitForDashboardReady();
  await recoverStaleE2ESettings();

  activeOverrideCount += 1;
  if (activeOverrideCount > 1) return;

  try {
    savedSettingsSnapshot = await getDashboardSettings();
    writeFileSync(SNAPSHOT_PATH, JSON.stringify(savedSettingsSnapshot, null, 2));

    const merged = deepMerge(savedSettingsSnapshot, overrides);
    await putDashboardSettings(merged);
  } catch (error) {
    activeOverrideCount = 0;
    savedSettingsSnapshot = null;
    try { unlinkSync(SNAPSHOT_PATH); } catch {}
    throw error;
  }
}

export async function beginTemporaryE2EEagerness(voiceEagerness: number, textEagerness?: number): Promise<void> {
  const text = textEagerness ?? voiceEagerness;
  return beginTemporaryE2ESettings({
    interaction: {
      activity: {
        ambientReplyEagerness: text,
        responseWindowEagerness: text
      }
    },
    voice: {
      conversationPolicy: {
        ambientReplyEagerness: voiceEagerness
      }
    },
    initiative: {
      voice: {
        eagerness: voiceEagerness
      }
    }
  });
}

export async function beginTemporaryE2EEagerness50(): Promise<void> {
  return beginTemporaryE2EEagerness(50);
}

export async function beginTemporaryE2EWithPreset(argv: string[] = process.argv.slice(2)): Promise<string> {
  const { presetName, overrides } = resolveE2EPipelineOverrides(argv);
  await beginTemporaryE2ESettings(overrides);
  return presetName;
}

export async function restoreTemporaryE2ESettings(): Promise<void> {
  if (activeOverrideCount <= 0) return;
  activeOverrideCount -= 1;
  if (activeOverrideCount > 0) return;

  const snapshot = savedSettingsSnapshot;
  savedSettingsSnapshot = null;
  if (!snapshot) return;

  await waitForDashboardReady();
  await putDashboardSettings(snapshot);

  try { unlinkSync(SNAPSHOT_PATH); } catch {}
}
