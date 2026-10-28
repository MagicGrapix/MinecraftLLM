import { region, type SceneDefinition } from "./SceneDefinition";

export const craftingScene: SceneDefinition = {
  id: 3,
  name: "crafting",
  description: "Crafting illustration: workbench, furnace and a supplied wooden sword. No recipe is executed.",
  regions: [region("crafting_table", 0, 1, 0), region("furnace", 2, 1, 0), region("oak_log", -3, 1, 0, -3, 2, 1)],
  actor: { position: { x: 0.5, y: 1, z: 2.5 }, yaw: 180, pitch: 15, hand: "wooden_sword" },
  camera: { position: { x: 6, y: 4, z: 6 }, yaw: 135, pitch: 18 },
};
