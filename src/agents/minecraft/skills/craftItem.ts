/**
 * Skill: Craft an item using known recipes.
 *
 * Dispatches `minecraft_craft` to the MCP server. The Mineflayer bot pulls
 * ingredients from inventory, uses a nearby crafting table if required, and
 * produces the item. Fails fast when ingredients are missing or no recipe is
 * known so the planner can recover.
 */

import type { MinecraftSkill, SkillContext, SkillResult } from "../types.ts";
import type { MinecraftRuntime } from "../minecraftRuntime.ts";

export class CraftItemSkill implements MinecraftSkill {
  readonly name = "craft_item";
  readonly description = "Craft an item using known recipes.";

  private readonly runtime: MinecraftRuntime;
  private readonly recipeName: string;
  private readonly count: number;
  private readonly useCraftingTable: boolean;
  private interrupted = false;

  constructor(runtime: MinecraftRuntime, recipeName: string, count = 1, useCraftingTable = false) {
    this.runtime = runtime;
    this.recipeName = recipeName;
    this.count = count;
    this.useCraftingTable = useCraftingTable;
  }

  checkPreconditions(): { ok: boolean; reason?: string } {
    if (!this.recipeName) return { ok: false, reason: "No recipe name specified." };
    if (this.count < 1) return { ok: false, reason: "Count must be at least 1." };
    return { ok: true };
  }

  async execute(context: SkillContext): Promise<SkillResult> {
    if (context.signal.aborted || this.interrupted) {
      return { status: "interrupted", summary: "Skill interrupted before execution.", retries: 0 };
    }

    try {
      context.onProgress?.(`Crafting ${this.count}x ${this.recipeName}...`);
      const result = await this.runtime.craftItem(
        this.recipeName,
        this.count,
        this.useCraftingTable,
        context.signal
      );
      if (!result.ok) {
        return {
          status: "failed",
          summary: result.error || "Craft command rejected.",
          retries: 0
        };
      }
      const output = result.output;
      return {
        status: "succeeded",
        summary: `Crafted ${output.crafted}x ${output.recipeName} (requested ${output.requested}).`,
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
      ? `craft ${this.recipeName} (interrupted)`
      : `crafting ${this.count}x ${this.recipeName}`;
  }
}
