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

export const HandSchema = z.enum(["hand", "off-hand"]);
export type Hand = z.infer<typeof HandSchema>;

export const CursorPositionSchema = z
  .object({
    x: z.number().finite().min(0).max(1),
    y: z.number().finite().min(0).max(1),
    z: z.number().finite().min(0).max(1),
  })
  .strict();

export type CursorPosition = z.infer<typeof CursorPositionSchema>;

export const BlockFaceSchema = z.enum([
  "top",
  "bottom",
  "north",
  "south",
  "east",
  "west",
]);

export type BlockFace = z.infer<typeof BlockFaceSchema>;
