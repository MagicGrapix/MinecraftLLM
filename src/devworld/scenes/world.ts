import { fixedOak, region, type SceneDefinition } from "./SceneDefinition";

export const worldScene: SceneDefinition = {
  id: 2,
  name: "world",
  description: "World observations illustration: tree, stone, dirt and one loose oak_log (not collected).",
  regions: [...fixedOak(1, 2), region("stone", -2, 1, 0), region("dirt", -2, 1, 1)],
  drops: [{ position: { x: 0.5, y: 1.15, z: 0.5 }, item: "oak_log" }],
  actor: { position: { x: 0.5, y: 1, z: -1.5 }, yaw: 0, pitch: 15, hand: "wooden_axe" },
  camera: { position: { x: -5, y: 4, z: -5 }, yaw: -42, pitch: 20 },
};
