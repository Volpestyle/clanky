/**
 * Skill: Follow a player at a configurable distance.
 *
 * Dispatches `minecraft_follow_player` to the MCP server. The Mineflayer
 * pathfinder keeps the behavior durable until a new goal replaces it.
 */

import type { MinecraftSkill, SkillContext, SkillResult } from "../types.ts";
import type { MinecraftRuntime } from "../minecraftRuntime.ts";

export class FollowPlayerSkill implements MinecraftSkill {
  readonly name = "follow_player";
  readonly description = "Follow a player at a set distance.";

  private readonly runtime: MinecraftRuntime;
  private readonly playerName: string;
  private readonly distance: number;
  private interrupted = false;

  constructor(runtime: MinecraftRuntime, playerName: string, distance = 3) {
    this.runtime = runtime;
    this.playerName = playerName;
    this.distance = distance;
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
      const result = await this.runtime.followPlayer(this.playerName, this.distance, context.signal);
      if (!result.ok) {
        return { status: "failed", summary: result.error || "Follow command rejected.", retries: 0 };
      }
      context.onProgress?.(`Following ${this.playerName} at distance ${this.distance}.`);
      return {
        status: "succeeded",
        summary: `Now following ${this.playerName} (distance=${this.distance}).`,
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
      ? `follow ${this.playerName} (interrupted)`
      : `following ${this.playerName}`;
  }
}
