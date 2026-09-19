import { z } from "zod";

export interface Position {
  x: number;
  y: number;
  z: number;
}

const coordinateSchema = z.number().finite();

export const PositionSchema: z.ZodType<Position> = z
  .object({
    x: coordinateSchema,
    y: coordinateSchema,
    z: coordinateSchema,
  })
  .strict();

export const BlockPositionSchema: z.ZodType<Position> = z
  .object({
    x: coordinateSchema.int(),
    y: coordinateSchema.int(),
    z: coordinateSchema.int(),
  })
  .strict();

export const EquipmentDestinationSchema = z.enum([
  "hand",
  "off-hand",
  "head",
  "torso",
  "legs",
  "feet",
]);

export type EquipmentDestination = z.infer<typeof EquipmentDestinationSchema>;

export const BlockFaceSchema = z.enum([
  "top",
  "bottom",
  "north",
  "south",
  "east",
  "west",
]);

export type BlockFace = z.infer<typeof BlockFaceSchema>;
