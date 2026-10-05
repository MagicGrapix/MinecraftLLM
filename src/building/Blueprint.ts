import { z } from "zod";
import type { Position } from "../shared/types";
import { MinecraftNameSchema } from "../world/queries/MinecraftNames";
import { BLUEPRINT_LIMITS as limits } from "./BuildingConfig";

export const BLUEPRINT_FORMAT_VERSION = 1;

const localPosition = z.object({
  x: z.number().int().min(0).max(limits.maxWidth - 1),
  y: z.number().int().min(0).max(limits.maxHeight - 1),
  z: z.number().int().min(0).max(limits.maxDepth - 1),
}).strict();

/** Position is the lower half. Both occupied cells must be '_' in the drawing. */
export const BlueprintDoorSchema = z.object({
  item: MinecraftNameSchema.max(128),
  position: localPosition,
  facing: z.enum(["north", "south", "east", "west"]),
}).strict();

export const BlueprintSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500),
  width: z.number().int().min(1).max(limits.maxWidth),
  depth: z.number().int().min(1).max(limits.maxDepth),
  palette: z.record(z.string().regex(/^[A-Z]$/, "Use one uppercase ASCII letter."), MinecraftNameSchema.max(128))
    .refine((palette) => Object.keys(palette).length >= 1 && Object.keys(palette).length <= limits.maxPalette,
      `Palette must contain 1 to ${limits.maxPalette} materials.`),
  layers: z.array(z.array(z.string().min(1).max(limits.maxWidth)
    .regex(/^[A-Z._]+$/, "Rows use uppercase ASCII letters, . (required air), or _ (ignored)."))
    .min(1).max(limits.maxDepth)).min(1).max(limits.maxHeight),
  dependencies: z.object({ doors: z.array(BlueprintDoorSchema).max(limits.maxDoors) }).strict(),
}).strict();

export type Blueprint = z.infer<typeof BlueprintSchema>;
export type DoorFacing = z.infer<typeof BlueprintDoorSchema>["facing"];
export type DoorHinge = "left" | "right";
export interface DoorProperties {
  readonly facing: DoorFacing;
  readonly hinge: DoorHinge;
  readonly half: "lower" | "upper";
  readonly open: false;
  readonly powered: false;
}

/** Array order is y, then z, then x. Every position is local to the blueprint origin. */
export type BlueprintCell =
  | { readonly position: Position; readonly kind: "block"; readonly block: string }
  | { readonly position: Position; readonly kind: "door"; readonly block: string; readonly properties: DoorProperties }
  | { readonly position: Position; readonly kind: "air" | "ignore" };

export interface CubePlacement {
  readonly kind: "place_block";
  readonly position: Position;
  readonly block: string;
  readonly item: string;
}

export interface DoorPlacement {
  readonly kind: "place_door";
  readonly position: Position;
  readonly block: string;
  readonly item: string;
  readonly facing: DoorFacing;
  readonly hinge: DoorHinge;
}
export type BlueprintPlacement = CubePlacement | DoorPlacement;

export interface MaterialRequirement {
  readonly item: string;
  readonly quantity: number;
}

/** Compilation is geometric data, not proof of world access or a placement schedule. */
export interface CompiledBlueprint {
  readonly blueprint: Blueprint;
  readonly minecraftVersion: string;
  readonly height: number;
  readonly cells: readonly BlueprintCell[];
  readonly operations: readonly BlueprintPlacement[];
  readonly materials: readonly MaterialRequirement[];
}

export interface BlueprintIssue {
  readonly code: "INVALID_SHAPE" | "UNKNOWN_SYMBOL" | "UNKNOWN_BLOCK" | "UNSUPPORTED_BLOCK"
    | "MISSING_PLACEMENT_ITEM" | "UNSUPPORTED_DEPENDENCY" | "EMPTY_BLUEPRINT"
    | "DOOR_OUT_OF_BOUNDS" | "DOOR_OVERLAP" | "DOOR_SUPPORT" | "ADJACENT_DOORS";
  readonly path: string;
  readonly message: string;
  readonly received?: unknown;
  readonly position?: Position;
  readonly suggestions?: readonly string[];
}
