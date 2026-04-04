/**
 * Skill: Collect blocks of a given type from the nearby world.
 *
 * Dispatches `minecraft_collect_block` to the MCP server. The Mineflayer
 * bot equips the best tool, pathfinds to each block, and mines it.
 */

import type { MinecraftSkill, SkillContext, SkillResult } from "../types.ts";
import type { MinecraftRuntime } from "../minecraftRuntime.ts";

export class CollectBlockSkill implements MinecraftSkill {
  readonly name = "collect_block";
  readonly description = "Mine and collect a specified number of blocks.";

  private readonly runtime: MinecraftRuntime;
  private readonly blockName: string;
  private readonly count: number;
  private readonly maxDistance: number;
  private interrupted = false;

  constructor(runtime: MinecraftRuntime, blockName: string, count = 1, maxDistance = 32) {
    this.runtime = runtime;
    this.blockName = blockName;
    this.count = count;
    this.maxDistance = maxDistance;
  }

  checkPreconditions(): { ok: boolean; reason?: string } {
    if (!this.blockName) return { ok: false, reason: "No block name specified." };
    if (this.count < 1) return { ok: false, reason: "Count must be at least 1." };
    return { ok: true };
  }

  async execute(context: SkillContext): Promise<SkillResult> {
    if (context.signal.aborted || this.interrupted) {
      return { status: "interrupted", summary: "Skill interrupted before execution.", retries: 0 };
    }

    try {
      context.onProgress?.(`Collecting ${this.count} ${this.blockName}...`);
      const result = await this.runtime.collectBlock(this.blockName, this.count, this.maxDistance);
      if (!result.ok) {
        return { status: "failed", summary: result.error || "Collect command rejected.", retries: 0 };
      }
      const output = result.output;
      return {
        status: "succeeded",
        summary:
          `Collected ${output.attempted} of ${output.requested} ${output.blockName}. ` +
          `Inventory: ${output.inventoryBefore} → ${output.inventoryAfter}.`,
        retries: 0
      };
    } catch (error) {
      return {
        status: "failed",
        summary: error instanceof Error ? error.message : String(error),
        retries: 0
      };
    }
  }

  interrupt(_reason: string): void {
    this.interrupted = true;
  }

  getStatus(): string {
    return this.interrupted
      ? `collect ${this.blockName} (interrupted)`
      : `collecting ${this.count} ${this.blockName}`;
  }
}
