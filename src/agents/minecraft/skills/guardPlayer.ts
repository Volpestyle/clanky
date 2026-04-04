/**
 * Skill: Guard a player — follow them and engage nearby hostile mobs.
 *
 * Dispatches `minecraft_guard_player` to the MCP server. The guard behavior
 * runs on a physics-tick loop inside the MCP server (via mineflayer-pvp)
 * and stays active until replaced by another goal.
 */

import type { MinecraftSkill, SkillContext, SkillResult } from "../types.ts";
import type { MinecraftRuntime } from "../minecraftRuntime.ts";

export class GuardPlayerSkill implements MinecraftSkill {
  readonly name = "guard_player";
  readonly description = "Follow a player and attack nearby hostile mobs.";

  private readonly runtime: MinecraftRuntime;
  private readonly playerName: string;
  private readonly radius: number;
  private readonly followDistance: number;
  private interrupted = false;

  constructor(runtime: MinecraftRuntime, playerName: string, radius = 8, followDistance = 4) {
    this.runtime = runtime;
    this.playerName = playerName;
    this.radius = radius;
    this.followDistance = followDistance;
  }

  checkPreconditions(): { ok: boolean; reason?: string } {
    if (!this.playerName) return { ok: false, reason: "No player name specified." };
    return { ok: true };
  }

  async execute(context: SkillContext): Promise<SkillResult> {
    if (context.signal.aborted || this.interrupted) {
      return { status: "interrupted", summary: "Skill interrupted before execution.", retries: 0 };
    }

    try {
      const result = await this.runtime.guardPlayer(this.playerName, this.radius, this.followDistance, context.signal);
      if (!result.ok) {
        return { status: "failed", summary: result.error || "Guard command rejected.", retries: 0 };
      }
      context.onProgress?.(
        `Guarding ${this.playerName} (radius=${this.radius}, follow=${this.followDistance}).`
      );
      return {
        status: "succeeded",
        summary: `Now guarding ${this.playerName} — engaging hostiles within ${this.radius} blocks.`,
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
      ? `guard ${this.playerName} (interrupted)`
      : `guarding ${this.playerName}`;
  }
}
