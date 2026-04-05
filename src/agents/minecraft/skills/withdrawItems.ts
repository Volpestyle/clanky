/**
 * Skill: Withdraw items from a nearby chest into the bot's inventory.
 *
 * Dispatches `minecraft_withdraw_items` to the MCP server. The bot opens the
 * chest, transfers requested items, and closes the container. Caller is
 * responsible for enforcing constraints.allowedChests at the session layer.
 */

import type { MinecraftItemRequest, MinecraftSkill, SkillContext, SkillResult } from "../types.ts";
import type { MinecraftRuntime } from "../minecraftRuntime.ts";

export class WithdrawItemsSkill implements MinecraftSkill {
  readonly name = "withdraw_items";
  readonly description = "Withdraw items from a chest into inventory.";

  private readonly runtime: MinecraftRuntime;
  private readonly chestX: number;
  private readonly chestY: number;
  private readonly chestZ: number;
  private readonly items: MinecraftItemRequest[];
  private interrupted = false;

  constructor(
    runtime: MinecraftRuntime,
    chest: { x: number; y: number; z: number },
    items: MinecraftItemRequest[]
  ) {
    this.runtime = runtime;
    this.chestX = chest.x;
    this.chestY = chest.y;
    this.chestZ = chest.z;
    this.items = items;
  }

  checkPreconditions(): { ok: boolean; reason?: string } {
    if (!Array.isArray(this.items) || this.items.length === 0) {
      return { ok: false, reason: "No items specified to withdraw." };
    }
    return { ok: true };
  }

  async execute(context: SkillContext): Promise<SkillResult> {
    if (context.signal.aborted || this.interrupted) {
      return { status: "interrupted", summary: "Skill interrupted before execution.", retries: 0 };
    }

    try {
      context.onProgress?.(
        `Withdrawing ${this.items.length} stack(s) from ${this.chestX},${this.chestY},${this.chestZ}...`
      );
      const result = await this.runtime.withdrawItems(
        this.chestX,
        this.chestY,
        this.chestZ,
        this.items,
        context.signal
      );
      if (!result.ok) {
        return {
          status: "failed",
          summary: result.error || "Withdraw command rejected.",
          retries: 0
        };
      }
      const output = result.output;
      const withdrawnLine = output.withdrawn.length > 0
        ? output.withdrawn.map((entry) => `${entry.count}x ${entry.name}`).join(", ")
        : "nothing";
      const skippedLine = output.skipped.length > 0
        ? ` skipped: ${output.skipped.map((entry) => `${entry.name} (${entry.reason})`).join(", ")}`
        : "";
      return {
        status: "succeeded",
        summary: `Withdrew ${withdrawnLine} from chest ${output.chest.x},${output.chest.y},${output.chest.z}.${skippedLine}`,
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
      ? `withdraw items (interrupted)`
      : `withdrawing ${this.items.length} stack(s)`;
  }
}
