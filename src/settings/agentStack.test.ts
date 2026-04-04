import { test } from "bun:test";
import assert from "node:assert/strict";
import { normalizeSettings } from "../store/settingsNormalization.ts";
import { getMinecraftConfig } from "./agentStack.ts";

test("getMinecraftConfig surfaces the canonical Minecraft server target for embodied sessions", () => {
  const settings = normalizeSettings({
    agentStack: {
      runtimeConfig: {
        minecraft: {
          enabled: true,
          operatorPlayerName: "Volpestyle",
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

  assert.equal(config.operatorPlayerName, "Volpestyle");
  assert.equal(config.autoSpawn, true);
  assert.deepEqual(config.serverTarget, {
    label: "Survival SMP",
    host: "mc.example.test",
    port: 25570,
    description: "Primary operator world"
  });
});
