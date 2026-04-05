import { test, mock } from "bun:test";
import assert from "node:assert/strict";

test("repath reasserts the last goal-near navigation target", async () => {
  mock.module("prismarine-viewer", () => ({
    default: {
      headless: () => false
    }
  }));

  const { MinecraftBotController } = await import("./minecraftBot.ts");
  const controller = new MinecraftBotController();
  const pathfinderCalls = [];
  controller.bot = {
    pathfinder: {
      setGoal(goal, dynamic) {
        pathfinderCalls.push({ goal, dynamic });
      }
    },
    players: {}
  };

  await controller.goTo(10, 64, 5, 2);
  pathfinderCalls.length = 0;

  const result = await controller.repath();
  assert.equal(result.mode, "navigate");
  assert.equal(pathfinderCalls.length, 2);
  assert.equal(pathfinderCalls[0]?.goal, null);
  assert.notEqual(pathfinderCalls[1]?.goal, null);
  assert.equal(pathfinderCalls[1]?.dynamic, false);
});
