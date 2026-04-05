/**
 * Skill: Execute a structured build plan.
 *
 * Takes a list of block placements in dependency order and dispatches
 * `minecraft_place_block` for each. Navigates closer when a target is out
 * of reach, clears obstructing blocks when `clearFirst` is set, and reports
 * progress per block so the session can emit checkpoints.
 *
 * The sub-planner owns the *what* (which blocks go where). This skill owns
 * the *how* (navigate, equip, place). If the brain hands us a plan, we
 * execute it. If it fails mid-way, we surface the partial progress so the
 * brain can recover in the next turn.
 */

import type {
  MinecraftBuildPlan,
  MinecraftSkill,
  SkillContext,
  SkillResult
} from "../types.ts";
import type { MinecraftRuntime } from "../minecraftRuntime.ts";

const PLACE_REACH_BLOCKS = 4;
const NAVIGATE_RANGE_BLOCKS = 2;

export class BuildStructureSkill implements MinecraftSkill {
  readonly name = "build_structure";
  readonly description = "Place blocks from a structured build plan.";

  private readonly runtime: MinecraftRuntime;
  private readonly plan: MinecraftBuildPlan;
  private interrupted = false;
  private placedCount = 0;
  private failedCount = 0;

  constructor(runtime: MinecraftRuntime, plan: MinecraftBuildPlan) {
    this.runtime = runtime;
    this.plan = plan;
  }

  checkPreconditions(): { ok: boolean; reason?: string } {
    if (!this.plan?.blocks || this.plan.blocks.length === 0) {
      return { ok: false, reason: "Build plan has no blocks." };
    }
    if (this.plan.blocks.length > 256) {
      return { ok: false, reason: "Build plan exceeds 256 blocks. Split into smaller plans." };
    }
    return { ok: true };
  }

  async execute(context: SkillContext): Promise<SkillResult> {
    if (context.signal.aborted || this.interrupted) {
      return { status: "interrupted", summary: "Build interrupted before execution.", retries: 0 };
    }

    context.onProgress?.(`Building "${this.plan.title}" (${this.plan.blocks.length} blocks)...`);
    const failures: string[] = [];

    for (let index = 0; index < this.plan.blocks.length; index += 1) {
      if (context.signal.aborted || this.interrupted) {
        return {
          status: "interrupted",
          summary: `Build "${this.plan.title}" interrupted after ${this.placedCount}/${this.plan.blocks.length} blocks.`,
          retries: 0
        };
      }

      const block = this.plan.blocks[index];
      if (!block) continue;

      // Navigate closer when out of reach. We probe pathfinding distance via
      // status rather than tracking position locally — stays consistent with
      // the rest of the runtime.
      const status = await this.runtime.status(context.signal);
      if (status.ok && status.output.position) {
        const pos = status.output.position;
        const dx = block.x - pos.x;
        const dy = block.y - pos.y;
        const dz = block.z - pos.z;
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (distance > PLACE_REACH_BLOCKS) {
          try {
            await this.runtime.goTo(block.x, block.y, block.z, NAVIGATE_RANGE_BLOCKS, context.signal);
            // Small settle before placing; the MCP server doesn't block on
            // path completion so give it time to close the distance.
            await new Promise((resolve) => setTimeout(resolve, 600));
          } catch {
            // Fall through and try the placement anyway.
          }
        }
      }

      // Clear obstruction if requested.
      if (this.plan.clearFirst) {
        try {
          await this.runtime.digBlock(block.x, block.y, block.z, context.signal);
        } catch {
          // Ignore — either air or too far. The place call will report it.
        }
      }

      try {
        const result = await this.runtime.placeBlock(
          block.x,
          block.y,
          block.z,
          block.blockName,
          context.signal
        );
        if (result.ok) {
          this.placedCount += 1;
          context.onProgress?.(
            `Placed ${block.blockName} at ${block.x},${block.y},${block.z} (${this.placedCount}/${this.plan.blocks.length}).`
          );
        } else {
          this.failedCount += 1;
          failures.push(`${block.blockName}@${block.x},${block.y},${block.z}: ${result.error || "rejected"}`);
        }
      } catch (error) {
        this.failedCount += 1;
        failures.push(
          `${block.blockName}@${block.x},${block.y},${block.z}: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      // Abort the whole build if we see repeated failures — usually means
      // missing resources or a positioning problem the brain should reason
      // about.
      if (this.failedCount >= 5) {
        break;
      }
    }

    if (this.placedCount === this.plan.blocks.length) {
      return {
        status: "succeeded",
        summary: `Built "${this.plan.title}": placed ${this.placedCount} blocks.`,
        retries: 0
      };
    }

    const failureSummary = failures.slice(0, 3).join("; ");
    return {
      status: "failed",
      summary: `Built "${this.plan.title}" partially: ${this.placedCount}/${this.plan.blocks.length} placed, ${this.failedCount} failed. First failures: ${failureSummary}`,
      retries: 0
    };
  }

  interrupt(_reason: string): void {
    this.interrupted = true;
  }

  getStatus(): string {
    return this.interrupted
      ? `build "${this.plan.title}" (interrupted)`
      : `building "${this.plan.title}" (${this.placedCount}/${this.plan.blocks.length})`;
  }
}
