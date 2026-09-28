import { z } from "zod";
import { mcData } from "../config";
import { BlockPositionSchema, PositionSchema } from "../shared/types";

export const LabScenarioSchema = z.object({
  name: z.string().trim().min(1).max(100),
  self: z.object({
    position: PositionSchema,
    facing: z.enum(["north", "south", "east", "west"]),
    health: z.number().min(0).max(20),
    food: z.number().min(0).max(20),
    foodSaturation: z.number().min(0).max(20),
    oxygenLevel: z.number().min(0).max(20),
    onGround: z.boolean(),
  }).strict(),
  inventory: z.record(z.number().int().min(1).max(2304)),
  selectedItem: z.string().nullable(),
  surfaceY: z.number().int(),
  autoCollectDrops: z.boolean(),
  blocks: z.array(z.object({
    position: BlockPositionSchema,
    name: z.string().trim().min(1),
  }).strict()).max(500),
}).strict().superRefine((scenario, context) => {
  for (const [name] of Object.entries(scenario.inventory)) {
    if (!mcData.itemsByName[name]) {
      context.addIssue({ code: "custom", path: ["inventory", name], message: `Unknown item: ${name}` });
    }
  }
  if (scenario.selectedItem && !scenario.inventory[scenario.selectedItem]) {
    context.addIssue({ code: "custom", path: ["selectedItem"], message: "Selected item must be in inventory." });
  }
  scenario.blocks.forEach((block, index) => {
    if (!mcData.blocksByName[block.name]) {
      context.addIssue({ code: "custom", path: ["blocks", index, "name"], message: `Unknown block: ${block.name}` });
    }
  });
});

export type LabScenario = z.infer<typeof LabScenarioSchema>;

export const defaultLabScenario: LabScenario = {
  name: "One log, one tree",
  self: {
    position: { x: 0.5, y: -60, z: 0.5 },
    facing: "east",
    health: 20,
    food: 20,
    foodSaturation: 5,
    oxygenLevel: 20,
    onGround: true,
  },
  inventory: { oak_log: 1 },
  selectedItem: "oak_log",
  surfaceY: -61,
  autoCollectDrops: true,
  blocks: [
    { position: { x: 3, y: -60, z: 0 }, name: "oak_log" },
    { position: { x: 3, y: -59, z: 0 }, name: "oak_log" },
    { position: { x: 3, y: -58, z: 0 }, name: "oak_log" },
  ],
};
