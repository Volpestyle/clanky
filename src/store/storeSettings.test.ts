import { test } from "bun:test";
import assert from "node:assert/strict";
import { Store } from "./store.ts";
import { normalizeSettings } from "./settingsNormalization.ts";

test("patchSettingsWithVersion preserves unrelated settings when saving a partial patch", () => {
  const store = new Store(":memory:");
  store.init();

  try {
    store.setSettings({
      identity: {
        botName: "patch me"
      },
      permissions: {
        replies: {
          maxMessagesPerHour: 77
        }
      }
    });

    const current = store.getSettingsRecord();
    const result = store.patchSettingsWithVersion({
      agentStack: {
        runtimeConfig: {
          browser: {
            enabled: false
          }
        }
      }
    }, current.updatedAt);

    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error("expected versioned settings patch to succeed");
    }

    assert.equal(result.settings.identity.botName, "patch me");
    assert.equal(result.settings.permissions.replies.maxMessagesPerHour, 77);
    assert.equal(result.settings.agentStack.runtimeConfig.browser.enabled, false);
  } finally {
    store.close();
  }
});

test("replaceSettingsWithVersion restores fields that were set back to defaults", () => {
  const store = new Store(":memory:");
  store.init();

  try {
    const defaultBotName = normalizeSettings({}).identity.botName;
    store.setSettings({
      identity: {
        botName: "patched name"
      },
      permissions: {
        replies: {
          maxMessagesPerHour: 77
        }
      }
    });

    const current = store.getSettingsRecord();
    const result = store.replaceSettingsWithVersion({
      identity: {
        botName: defaultBotName
      }
    }, current.updatedAt);

    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error("expected versioned settings replace to succeed");
    }

    assert.equal(result.settings.identity.botName, defaultBotName);
    assert.equal(result.intent.identity, undefined);
    assert.equal(
      store.getSettings().permissions.replies.maxMessagesPerHour,
      normalizeSettings({}).permissions.replies.maxMessagesPerHour
    );
  } finally {
    store.close();
  }
});

test("rewriteRuntimeSettingsRow migrates legacy voiceRuntime overrides into canonical voice runtime config", () => {
  const store = new Store(":memory:");
  store.init();

  try {
    const legacyIntent = {
      agentStack: {
        advancedOverridesEnabled: true,
        overrides: {
          voiceRuntime: "voice_agent"
        }
      }
    };

    store.db
      .prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ?")
      .run(JSON.stringify(legacyIntent), "2026-03-13T00:00:00.000Z", "runtime_settings");

    const rewritten = store.rewriteRuntimeSettingsRow(JSON.stringify(legacyIntent));
    const record = store.getSettingsRecord();

    assert.equal(rewritten.agentStack.runtimeConfig.voice.runtimeMode, "voice_agent");
    assert.equal(record.intent.agentStack?.runtimeConfig?.voice?.runtimeMode, "voice_agent");
    assert.equal(record.intent.agentStack?.overrides?.voiceRuntime, undefined);
  } finally {
    store.close();
  }
});
