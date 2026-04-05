import { test } from "bun:test";
import assert from "node:assert/strict";
import { normalizeSettings } from "../store/settingsNormalization.ts";
import { getMinecraftConfig, getMinecraftNarrationSettings } from "./agentStack.ts";

test("getMinecraftConfig surfaces the canonical Minecraft server target for embodied sessions", () => {
  const settings = normalizeSettings({
    agentStack: {
      runtimeConfig: {
        minecraft: {
          enabled: true,
          knownIdentities: [
            {
              mcUsername: "Volpestyle",
              discordUsername: "Volpestyle",
              label: "Volpe",
              relationship: "operator",
              notes: "Primary collaborator"
            }
          ],
          server: {
            label: "Survival SMP",
            host: "mc.example.test",
            port: 25570,
            description: "Primary operator world"
          }
        }
      }
    }
  });

  const config = getMinecraftConfig(settings);

  assert.deepEqual(config.knownIdentities, [
    {
      mcUsername: "Volpestyle",
      discordUsername: "Volpestyle",
      label: "Volpe",
      relationship: "operator",
      notes: "Primary collaborator"
    }
  ]);
  assert.equal(config.autoSpawn, true);
  assert.deepEqual(config.serverTarget, {
    label: "Survival SMP",
    host: "mc.example.test",
    port: 25570,
    description: "Primary operator world"
  });
});

test("getMinecraftNarrationSettings surfaces scoped Discord narration controls", () => {
  const settings = normalizeSettings({
    agentStack: {
      runtimeConfig: {
        minecraft: {
          narration: {
            eagerness: 72,
            minSecondsBetweenPosts: 90
          }
        }
      }
    }
  });

  const narration = getMinecraftNarrationSettings(settings);

  assert.equal(narration.eagerness, 72);
  assert.equal(narration.minSecondsBetweenPosts, 90);
});
