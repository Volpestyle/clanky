import { test } from "bun:test";
import assert from "node:assert/strict";
import { withDashboardServer } from "./testHelpers.ts";

test("dashboard API smoke: health/settings/actions/stats endpoints", async () => {
  const result = await withDashboardServer({}, async ({ baseUrl, bot, store }) => {
    const healthResponse = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthResponse.status, 200);
    const healthJson = await healthResponse.json();
    assert.equal(healthJson.ok, true);

    const settingsResponse = await fetch(`${baseUrl}/api/settings`);
    assert.equal(settingsResponse.status, 200);
    const settingsJson = await settingsResponse.json();
    assert.equal(typeof settingsJson.activity?.replyLevelReplyChannels, "number");
    assert.equal(typeof settingsJson.activity?.replyLevelOtherChannels, "number");
    assert.equal(typeof settingsJson.replyFollowupLlm?.enabled, "boolean");

    const updatePayload = {
      activity: {
        replyLevelReplyChannels: 62,
        replyLevelOtherChannels: 14
      },
      replyFollowupLlm: {
        enabled: true,
        provider: "anthropic",
        model: "claude-haiku-4-5",
        maxToolSteps: 4,
        maxTotalToolCalls: 9,
        maxWebSearchCalls: 2,
        maxMemoryLookupCalls: 3,
        maxImageLookupCalls: 1,
        toolTimeoutMs: 15000
      }
    };
    const updateResponse = await fetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(updatePayload)
    });
    assert.equal(updateResponse.status, 200);
    const updatedSettings = await updateResponse.json();
    assert.equal(updatedSettings.activity.replyLevelReplyChannels, 62);
    assert.equal(updatedSettings.activity.replyLevelOtherChannels, 14);
    assert.equal(updatedSettings.replyFollowupLlm.enabled, true);
    assert.equal(updatedSettings.replyFollowupLlm.provider, "anthropic");
    assert.equal(updatedSettings.replyFollowupLlm.model, "claude-haiku-4-5");
    assert.equal(updatedSettings.replyFollowupLlm.maxToolSteps, 4);
    assert.equal(updatedSettings.replyFollowupLlm.maxTotalToolCalls, 9);
    assert.equal(updatedSettings.replyFollowupLlm.maxWebSearchCalls, 2);
    assert.equal(updatedSettings.replyFollowupLlm.maxMemoryLookupCalls, 3);
    assert.equal(updatedSettings.replyFollowupLlm.maxImageLookupCalls, 1);
    assert.equal(updatedSettings.replyFollowupLlm.toolTimeoutMs, 15000);
    assert.equal(bot.appliedSettings.length, 1);

    const persisted = store.getSettings();
    assert.equal(persisted.activity.replyLevelReplyChannels, 62);
    assert.equal(persisted.activity.replyLevelOtherChannels, 14);
    assert.equal(persisted.replyFollowupLlm.enabled, true);
    assert.equal(persisted.replyFollowupLlm.maxToolSteps, 4);

    const actionsResponse = await fetch(`${baseUrl}/api/actions?limit=25`);
    assert.equal(actionsResponse.status, 200);
    const actionsJson = await actionsResponse.json();
    assert.equal(Array.isArray(actionsJson), true);

    const statsResponse = await fetch(`${baseUrl}/api/stats`);
    assert.equal(statsResponse.status, 200);
    const statsJson = await statsResponse.json();
    assert.equal(typeof statsJson.stats, "object");
    assert.equal(typeof statsJson.stats.performance, "object");
    assert.equal(typeof statsJson.runtime, "object");
  });
  if (result?.skipped) {
    return;
  }
});

test("dashboard API smoke: dashboard token auth gates /api routes", async () => {
  const result = await withDashboardServer({ dashboardToken: "smoke-token" }, async ({ baseUrl }) => {
    const unauthorized = await fetch(`${baseUrl}/api/settings`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`${baseUrl}/api/settings`, {
      headers: {
        "x-dashboard-token": "smoke-token"
      }
    });
    assert.equal(authorized.status, 200);
  });
  if (result?.skipped) {
    return;
  }
});
