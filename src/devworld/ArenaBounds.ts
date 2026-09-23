import { z } from "zod";
import type { Position } from "../shared/types";

export interface ArenaBounds {
  readonly min: Position;
  readonly max: Position;
}

const integerPosition = z
  .object({
    x: z.number().int(),
    y: z.number().int(),
    z: z.number().int(),
  })
  .strict();

export const ArenaBoundsSchema: z.ZodType<ArenaBounds> = z
  .object({
    min: integerPosition,
    max: integerPosition,
  })
  .strict()
  .superRefine((bounds, context) => {
    for (const axis of ["x", "y", "z"] as const) {
      if (bounds.min[axis] > bounds.max[axis]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["max", axis],
          message: `max.${axis} must be >= min.${axis}.`,
        });
      }
    }
  });

export function createArenaBounds(
  min: Position,
  max: Position,
): ArenaBounds {
  const parsed = ArenaBoundsSchema.parse({ min, max });
  return cloneBounds(parsed);
}

export function cloneBounds(bounds: ArenaBounds): ArenaBounds {
  return {
    min: { ...bounds.min },
    max: { ...bounds.max },
  };
}

export function containsPosition(
  bounds: ArenaBounds,
  position: Position,
): boolean {
  return (
    position.x >= bounds.min.x &&
    position.x <= bounds.max.x &&
    position.y >= bounds.min.y &&
    position.y <= bounds.max.y &&
    position.z >= bounds.min.z &&
    position.z <= bounds.max.z
  );
}

export function containsBounds(
  outer: ArenaBounds,
  inner: ArenaBounds,
): boolean {
  return (
    containsPosition(outer, inner.min) &&
    containsPosition(outer, inner.max)
  );
}

export function intersectsBounds(
  left: ArenaBounds,
  right: ArenaBounds,
): boolean {
  return !(
    left.max.x < right.min.x ||
    left.min.x > right.max.x ||
    left.max.y < right.min.y ||
    left.min.y > right.max.y ||
    left.max.z < right.min.z ||
    left.min.z > right.max.z
  );
}

export function unionBounds(
  left: ArenaBounds,
  right: ArenaBounds,
): ArenaBounds {
  return createArenaBounds(
    {
      x: Math.min(left.min.x, right.min.x),
      y: Math.min(left.min.y, right.min.y),
      z: Math.min(left.min.z, right.min.z),
    },
    {
      x: Math.max(left.max.x, right.max.x),
      y: Math.max(left.max.y, right.max.y),
      z: Math.max(left.max.z, right.max.z),
    },
  );
}

export function boundsVolume(bounds: ArenaBounds): number {
  return (
    (bounds.max.x - bounds.min.x + 1) *
    (bounds.max.y - bounds.min.y + 1) *
    (bounds.max.z - bounds.min.z + 1)
  );
}

export function expandBounds(
  bounds: ArenaBounds,
  amount: number,
): ArenaBounds {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error("Bounds expansion must be a non-negative integer.");
  }
  return createArenaBounds(
    {
      x: bounds.min.x - amount,
      y: bounds.min.y - amount,
      z: bounds.min.z - amount,
    },
    {
      x: bounds.max.x + amount,
      y: bounds.max.y + amount,
      z: bounds.max.z + amount,
    },
  );
}
