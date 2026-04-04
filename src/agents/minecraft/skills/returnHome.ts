/**
 * Skill: Return to a saved home position.
 *
 * Dispatches `minecraft_go_to` to the MCP server using the stored home
 * coordinates.  If no home is set, the skill fails gracefully.
 */

import type { MinecraftSkill, Position, SkillContext, SkillResult } from "../types.ts";
import type { MinecraftRuntime } from "../minecraftRuntime.ts";

export class ReturnHomeSkill implements MinecraftSkill {
  readonly name = "return_home";
  readonly description = "Pathfind back to a saved home position.";

  private readonly runtime: MinecraftRuntime;
  private readonly home: Position | null;
  private readonly range: number;
  private interrupted = false;

  constructor(runtime: MinecraftRuntime, home: Position | null, range = 2) {
    this.runtime = runtime;
    this.home = home;
    this.range = range;
  }

  checkPreconditions(): { ok: boolean; reason?: string } {
    if (!this.home) return { ok: false, reason: "No home position set." };
    return { ok: true };
  }

  async execute(context: SkillContext): Promise<SkillResult> {
    if (context.signal.aborted || this.interrupted) {
      return { status: "interrupted", summary: "Skill interrupted before execution.", retries: 0 };
    }

    if (!this.home) {
      return { status: "failed", summary: "No home position set.", retries: 0 };
    }

    try {
      context.onProgress?.(`Returning home to ${this.home.x}, ${this.home.y}, ${this.home.z}...`);
      const result = await this.runtime.goTo(this.home.x, this.home.y, this.home.z, this.range);
      if (!result.ok) {
        return { status: "failed", summary: result.error || "Go-to command rejected.", retries: 0 };
      }
      return {
        status: "succeeded",
        summary: `Pathfinding to home (${this.home.x}, ${this.home.y}, ${this.home.z}).`,
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
    if (!this.home) return "return home (no home set)";
    return this.interrupted
      ? `return home (interrupted)`
      : `returning to ${this.home.x}, ${this.home.y}, ${this.home.z}`;
  }
}
