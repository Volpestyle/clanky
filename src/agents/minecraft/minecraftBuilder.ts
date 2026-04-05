/**
 * Minecraft building sub-planner.
 *
 * Expands a short natural-language build description (or a geometric
 * primitive) into a concrete `MinecraftBuildPlan` — an ordered list of
 * block placements that the BuildStructureSkill executes.
 *
 * Two expansion paths:
 *
 *   1. **Geometric primitive** — the brain supplies a shape name in the
 *      `description` field (e.g. "wall 5x3", "floor 4x4", "pillar 1x5",
 *      "box 3x3x3", "hollow_box 4x4x4"). The planner recognizes the
 *      primitive and emits a deterministic block list using a single
 *      material name pulled from the brain's request or defaulting to
 *      `cobblestone`.
 *
 *   2. **Freeform description** — the brain hands over a natural language
 *      sketch and the planner calls the Minecraft brain binding once to
 *      materialize it as a structured plan. Primarily for small buildings
 *      the brain has already reasoned about ("a 5x3 wood cabin facing
 *      east"). The LLM returns JSON; we normalize and bound-check the
 *      result before handing it to the skill.
 *
 * The sub-planner never executes placements. It only plans.
 */

import type { LLMService } from "../../llm.ts";
import { safeJsonParseFromString } from "../../normalization/valueParsers.ts";
import {
  applyOrchestratorOverrideSettings,
  getResolvedMinecraftBrainBinding
} from "../../settings/agentStack.ts";
import type {
  MinecraftBuildBlockPlacement,
  MinecraftBuildPlan,
  Position
} from "./types.ts";

// ── Public API ──────────────────────────────────────────────────────────────

export type BuildDescriptor = {
  /** Short description or primitive shape (e.g. "wall 5x3", "a wood cabin"). */
  description: string;
  /** Origin block the structure builds from. Usually the bot's current pos. */
  origin: Position;
  /** Facing direction hint for primitive expansion. +x, -x, +z, -z. */
  facing?: "north" | "south" | "east" | "west";
  /** Override dimensions when description is ambiguous. */
  dimensions?: { width: number; height: number; depth: number };
  /** Preferred material. Defaults to cobblestone. */
  material?: string;
  /** Optional explicit title — falls back to the description. */
  title?: string;
};

export type MinecraftBuilder = {
  buildPlan: (descriptor: BuildDescriptor) => Promise<MinecraftBuildPlan>;
};

type MinecraftBuilderLlm = Pick<LLMService, "generate">;

// ── Geometric primitive expansion ───────────────────────────────────────────

const PRIMITIVE_PATTERNS: Array<{
  match: RegExp;
  build: (matches: string[], descriptor: BuildDescriptor) => MinecraftBuildBlockPlacement[];
  title: (matches: string[]) => string;
}> = [
  {
    match: /^\s*wall\s+(\d+)\s*[x\u00d7]\s*(\d+)\s*$/i,
    title: (matches) => `wall ${matches[0]}x${matches[1]}`,
    build: (matches, descriptor) => {
      const width = clampDimension(matches[0], 1, 16);
      const height = clampDimension(matches[1], 1, 16);
      const material = descriptor.material || "cobblestone";
      const blocks: MinecraftBuildBlockPlacement[] = [];
      const { xStep, zStep } = facingToStep(descriptor.facing ?? "east");
      // Walls run sideways to the facing direction.
      const sideStep = { x: -zStep, z: xStep };
      for (let h = 0; h < height; h += 1) {
        for (let w = 0; w < width; w += 1) {
          blocks.push({
            x: descriptor.origin.x + sideStep.x * w,
            y: descriptor.origin.y + h,
            z: descriptor.origin.z + sideStep.z * w,
            blockName: material
          });
        }
      }
      return blocks;
    }
  },
  {
    match: /^\s*floor\s+(\d+)\s*[x\u00d7]\s*(\d+)\s*$/i,
    title: (matches) => `floor ${matches[0]}x${matches[1]}`,
    build: (matches, descriptor) => {
      const width = clampDimension(matches[0], 1, 16);
      const depth = clampDimension(matches[1], 1, 16);
      const material = descriptor.material || "cobblestone";
      const blocks: MinecraftBuildBlockPlacement[] = [];
      for (let dz = 0; dz < depth; dz += 1) {
        for (let dx = 0; dx < width; dx += 1) {
          blocks.push({
            x: descriptor.origin.x + dx,
            y: descriptor.origin.y,
            z: descriptor.origin.z + dz,
            blockName: material
          });
        }
      }
      return blocks;
    }
  },
  {
    match: /^\s*pillar\s+(\d+)\s*$/i,
    title: (matches) => `pillar ${matches[0]}`,
    build: (matches, descriptor) => {
      const height = clampDimension(matches[0], 1, 32);
      const material = descriptor.material || "cobblestone";
      const blocks: MinecraftBuildBlockPlacement[] = [];
      for (let h = 0; h < height; h += 1) {
        blocks.push({
          x: descriptor.origin.x,
          y: descriptor.origin.y + h,
          z: descriptor.origin.z,
          blockName: material
        });
      }
      return blocks;
    }
  },
  {
    match: /^\s*box\s+(\d+)\s*[x\u00d7]\s*(\d+)\s*[x\u00d7]\s*(\d+)\s*$/i,
    title: (matches) => `box ${matches[0]}x${matches[1]}x${matches[2]}`,
    build: (matches, descriptor) => {
      const w = clampDimension(matches[0], 1, 12);
      const h = clampDimension(matches[1], 1, 12);
      const d = clampDimension(matches[2], 1, 12);
      const material = descriptor.material || "cobblestone";
      const blocks: MinecraftBuildBlockPlacement[] = [];
      for (let dy = 0; dy < h; dy += 1) {
        for (let dz = 0; dz < d; dz += 1) {
          for (let dx = 0; dx < w; dx += 1) {
            blocks.push({
              x: descriptor.origin.x + dx,
              y: descriptor.origin.y + dy,
              z: descriptor.origin.z + dz,
              blockName: material
            });
          }
        }
      }
      return blocks;
    }
  },
  {
    match: /^\s*hollow_box\s+(\d+)\s*[x\u00d7]\s*(\d+)\s*[x\u00d7]\s*(\d+)\s*$/i,
    title: (matches) => `hollow_box ${matches[0]}x${matches[1]}x${matches[2]}`,
    build: (matches, descriptor) => {
      const w = clampDimension(matches[0], 2, 12);
      const h = clampDimension(matches[1], 2, 12);
      const d = clampDimension(matches[2], 2, 12);
      const material = descriptor.material || "cobblestone";
      const blocks: MinecraftBuildBlockPlacement[] = [];
      for (let dy = 0; dy < h; dy += 1) {
        for (let dz = 0; dz < d; dz += 1) {
          for (let dx = 0; dx < w; dx += 1) {
            const isEdge =
              dx === 0 || dx === w - 1 ||
              dy === 0 || dy === h - 1 ||
              dz === 0 || dz === d - 1;
            if (!isEdge) continue;
            blocks.push({
              x: descriptor.origin.x + dx,
              y: descriptor.origin.y + dy,
              z: descriptor.origin.z + dz,
              blockName: material
            });
          }
        }
      }
      return blocks;
    }
  }
];

function facingToStep(facing: "north" | "south" | "east" | "west"): { xStep: number; zStep: number } {
  switch (facing) {
    case "north": return { xStep: 0, zStep: -1 };
    case "south": return { xStep: 0, zStep: 1 };
    case "east": return { xStep: 1, zStep: 0 };
    case "west": return { xStep: -1, zStep: 0 };
    default: return { xStep: 1, zStep: 0 };
  }
}

function clampDimension(raw: string | undefined, min: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return min;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function expandGeometricPrimitive(descriptor: BuildDescriptor): MinecraftBuildPlan | null {
  const text = descriptor.description.trim().toLowerCase();
  for (const primitive of PRIMITIVE_PATTERNS) {
    const match = text.match(primitive.match);
    if (!match) continue;
    const blocks = primitive.build(match.slice(1), descriptor);
    return {
      title: descriptor.title || primitive.title(match.slice(1)),
      blocks,
      clearFirst: false
    };
  }
  return null;
}

// ── LLM-backed freeform expansion ───────────────────────────────────────────

const FREEFORM_PLAN_JSON_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    title: { type: "string" },
    clearFirst: { type: "boolean" },
    blocks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          dx: { type: "integer" },
          dy: { type: "integer" },
          dz: { type: "integer" },
          blockName: { type: "string" }
        },
        required: ["dx", "dy", "dz", "blockName"],
        additionalProperties: false
      }
    }
  },
  required: ["title", "blocks"],
  additionalProperties: false
});

function buildFreeformSystemPrompt(): string {
  return [
    "You are a Minecraft structure planner.",
    "You produce concrete block placements in a compact 3D grid relative to an origin block.",
    "Return JSON only.",
    "Each block has integer offsets dx, dy, dz from the origin (positive x=east, positive y=up, positive z=south).",
    "Use canonical Minecraft block ids (oak_planks, cobblestone, glass, oak_door, torch, stone_bricks, etc.).",
    "Keep structures small: at most 150 total blocks. Prefer simple rectangular designs.",
    "Do not emit a block at the exact origin (dx=0,dy=0,dz=0) unless it's a floor.",
    "Order blocks bottom-up: smaller dy first, so supports exist before overhead blocks.",
    "Set clearFirst=true only when the target area is known to be obstructed."
  ].join("\n");
}

function buildFreeformUserPrompt(descriptor: BuildDescriptor): string {
  const dims = descriptor.dimensions
    ? `Requested dimensions: width=${descriptor.dimensions.width}, height=${descriptor.dimensions.height}, depth=${descriptor.dimensions.depth}.`
    : "Dimensions not specified — pick reasonable defaults.";
  const facing = descriptor.facing ? `Facing: ${descriptor.facing}.` : "Facing: east (default).";
  const material = descriptor.material ? `Preferred material hint: ${descriptor.material}.` : "";
  return [
    `Description: ${descriptor.description}`,
    `Origin block: (${descriptor.origin.x}, ${descriptor.origin.y}, ${descriptor.origin.z}).`,
    dims,
    facing,
    material,
    `JSON schema: ${FREEFORM_PLAN_JSON_SCHEMA}`
  ].filter(Boolean).join("\n");
}

function buildBuilderSettings(settings: Record<string, unknown>) {
  const binding = getResolvedMinecraftBrainBinding(settings);
  return applyOrchestratorOverrideSettings(settings, {
    provider: binding.provider,
    model: binding.model,
    temperature: binding.temperature,
    maxOutputTokens: Math.min(2000, Math.max(400, Number(binding.maxOutputTokens) || 1200)),
    reasoningEffort: binding.reasoningEffort
  });
}

function normalizeFreeformPlan(
  parsed: unknown,
  descriptor: BuildDescriptor
): MinecraftBuildPlan {
  const record = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  const rawTitle = String(record.title || "").trim();
  const title = (rawTitle || descriptor.title || descriptor.description).slice(0, 80);
  const clearFirst = record.clearFirst === true;
  const rawBlocks = Array.isArray(record.blocks) ? record.blocks : [];
  const blocks: MinecraftBuildBlockPlacement[] = [];
  for (const entry of rawBlocks) {
    if (!entry || typeof entry !== "object") continue;
    const blockRecord = entry as Record<string, unknown>;
    const dx = Number(blockRecord.dx);
    const dy = Number(blockRecord.dy);
    const dz = Number(blockRecord.dz);
    const blockName = String(blockRecord.blockName || "").trim().toLowerCase().replace(/\s+/g, "_");
    if (!blockName) continue;
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) continue;
    // Bound offsets so the bot can't emit runaway plans.
    if (Math.abs(dx) > 24 || dy < -8 || dy > 32 || Math.abs(dz) > 24) continue;
    blocks.push({
      x: descriptor.origin.x + Math.round(dx),
      y: descriptor.origin.y + Math.round(dy),
      z: descriptor.origin.z + Math.round(dz),
      blockName
    });
    if (blocks.length >= 150) break;
  }
  return {
    title,
    blocks,
    clearFirst
  };
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createMinecraftBuilder(
  llm: MinecraftBuilderLlm,
  getSettings: () => Record<string, unknown>
): MinecraftBuilder {
  return {
    async buildPlan(descriptor: BuildDescriptor): Promise<MinecraftBuildPlan> {
      // Fast path: recognized geometric primitive.
      const primitive = expandGeometricPrimitive(descriptor);
      if (primitive && primitive.blocks.length > 0) {
        return primitive;
      }

      // Slow path: call the brain binding to materialize a plan.
      const settings = getSettings();
      const generation = await llm.generate({
        settings: buildBuilderSettings(settings),
        systemPrompt: buildFreeformSystemPrompt(),
        userPrompt: buildFreeformUserPrompt(descriptor),
        jsonSchema: FREEFORM_PLAN_JSON_SCHEMA,
        trace: {
          source: "minecraft_build_planner"
        }
      });
      const parsed = safeJsonParseFromString(generation.text, null);
      return normalizeFreeformPlan(parsed, descriptor);
    }
  };
}
