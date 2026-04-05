/**
 * Unit tests for the Minecraft building sub-planner.
 *
 * Covers geometric primitive expansion (wall, floor, pillar, box, hollow_box)
 * and the LLM-backed freeform expansion path.
 */

import { describe, expect, test } from "bun:test";
import { createMinecraftBuilder } from "./minecraftBuilder.ts";
import type { LLMService } from "../../llm.ts";

class FakeLlm implements Pick<LLMService, "generate"> {
  calls: Array<Record<string, unknown>> = [];
  constructor(private response: string) {}
  async generate(options: Record<string, unknown>) {
    this.calls.push(options);
    return {
      text: this.response,
      provider: "test",
      model: "test",
      usage: { inputTokens: 10, outputTokens: 10 },
      costUsd: 0
    } as unknown as Awaited<ReturnType<LLMService["generate"]>>;
  }
}

const stubSettings = () => ({
  agentStack: {
    runtimeConfig: {
      minecraft: {
        execution: { mode: "inherit_orchestrator" }
      }
    }
  }
}) as Record<string, unknown>;

describe("createMinecraftBuilder primitives", () => {
  test("wall 5x3 produces 15 blocks at the correct offsets", async () => {
    const llm = new FakeLlm("{}");
    const builder = createMinecraftBuilder(llm, stubSettings);
    const plan = await builder.buildPlan({
      description: "wall 5x3",
      origin: { x: 100, y: 64, z: 200 }
    });
    expect(plan.title).toContain("wall");
    expect(plan.blocks.length).toBe(15);
    // Default material is cobblestone.
    expect(plan.blocks.every((b) => b.blockName === "cobblestone")).toBe(true);
    // Height stacking: y offsets 0..2
    const ys = new Set(plan.blocks.map((b) => b.y));
    expect(ys.has(64)).toBe(true);
    expect(ys.has(65)).toBe(true);
    expect(ys.has(66)).toBe(true);
    // No LLM call for primitives.
    expect(llm.calls.length).toBe(0);
  });

  test("floor 3x2 produces 6 blocks on a single y-layer", async () => {
    const llm = new FakeLlm("{}");
    const builder = createMinecraftBuilder(llm, stubSettings);
    const plan = await builder.buildPlan({
      description: "floor 3x2",
      origin: { x: 0, y: 70, z: 0 }
    });
    expect(plan.blocks.length).toBe(6);
    const ys = new Set(plan.blocks.map((b) => b.y));
    expect(ys.size).toBe(1);
    expect(ys.has(70)).toBe(true);
  });

  test("pillar 5 produces 5 stacked blocks", async () => {
    const llm = new FakeLlm("{}");
    const builder = createMinecraftBuilder(llm, stubSettings);
    const plan = await builder.buildPlan({
      description: "pillar 5",
      origin: { x: 5, y: 60, z: 5 },
      material: "oak_log"
    });
    expect(plan.blocks.length).toBe(5);
    expect(plan.blocks.every((b) => b.x === 5 && b.z === 5)).toBe(true);
    expect(plan.blocks.every((b) => b.blockName === "oak_log")).toBe(true);
  });

  test("box 2x2x2 produces 8 solid blocks", async () => {
    const llm = new FakeLlm("{}");
    const builder = createMinecraftBuilder(llm, stubSettings);
    const plan = await builder.buildPlan({
      description: "box 2x2x2",
      origin: { x: 0, y: 64, z: 0 }
    });
    expect(plan.blocks.length).toBe(8);
  });

  test("hollow_box 3x3x3 produces a 26-block shell", async () => {
    const llm = new FakeLlm("{}");
    const builder = createMinecraftBuilder(llm, stubSettings);
    const plan = await builder.buildPlan({
      description: "hollow_box 3x3x3",
      origin: { x: 0, y: 64, z: 0 }
    });
    // 3^3 = 27 total blocks minus 1 interior = 26
    expect(plan.blocks.length).toBe(26);
  });

  test("clamps oversized dimensions", async () => {
    const llm = new FakeLlm("{}");
    const builder = createMinecraftBuilder(llm, stubSettings);
    const plan = await builder.buildPlan({
      description: "wall 100x100",
      origin: { x: 0, y: 64, z: 0 }
    });
    // Clamped to 16x16 = 256 blocks max for walls
    expect(plan.blocks.length).toBe(256);
  });
});

describe("createMinecraftBuilder freeform", () => {
  test("falls back to LLM when description is not a recognized primitive", async () => {
    const llm = new FakeLlm(JSON.stringify({
      title: "tiny shack",
      clearFirst: false,
      blocks: [
        { dx: 0, dy: 0, dz: 0, blockName: "oak_planks" },
        { dx: 1, dy: 0, dz: 0, blockName: "oak_planks" },
        { dx: 0, dy: 1, dz: 0, blockName: "oak_planks" }
      ]
    }));
    const builder = createMinecraftBuilder(llm, stubSettings);
    const plan = await builder.buildPlan({
      description: "a tiny 2x2 wood shack",
      origin: { x: 10, y: 64, z: 10 }
    });
    expect(llm.calls.length).toBe(1);
    expect(plan.title).toBe("tiny shack");
    expect(plan.blocks.length).toBe(3);
    expect(plan.blocks[0]).toEqual({ x: 10, y: 64, z: 10, blockName: "oak_planks" });
    expect(plan.blocks[1]).toEqual({ x: 11, y: 64, z: 10, blockName: "oak_planks" });
    expect(plan.blocks[2]).toEqual({ x: 10, y: 65, z: 10, blockName: "oak_planks" });
  });

  test("filters out blocks with out-of-bounds offsets", async () => {
    const llm = new FakeLlm(JSON.stringify({
      title: "rejected",
      blocks: [
        { dx: 0, dy: 0, dz: 0, blockName: "stone" },
        { dx: 100, dy: 0, dz: 0, blockName: "stone" },
        { dx: 0, dy: -20, dz: 0, blockName: "stone" }
      ]
    }));
    const builder = createMinecraftBuilder(llm, stubSettings);
    const plan = await builder.buildPlan({
      description: "something weird",
      origin: { x: 0, y: 64, z: 0 }
    });
    // Only the valid block remains.
    expect(plan.blocks.length).toBe(1);
    expect(plan.blocks[0]?.blockName).toBe("stone");
  });

  test("caps freeform plans at 150 blocks", async () => {
    const blocks = Array.from({ length: 200 }, (_, i) => ({
      dx: i % 10,
      dy: Math.floor(i / 10),
      dz: 0,
      blockName: "cobblestone"
    }));
    const llm = new FakeLlm(JSON.stringify({ title: "massive", blocks }));
    const builder = createMinecraftBuilder(llm, stubSettings);
    const plan = await builder.buildPlan({
      description: "something huge",
      origin: { x: 0, y: 64, z: 0 }
    });
    expect(plan.blocks.length).toBe(150);
  });
});
