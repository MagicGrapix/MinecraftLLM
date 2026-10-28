import { fixedOak, type SceneDefinition } from "./SceneDefinition";

export const woodScene: SceneDefinition = {
  id: 1,
  name: "wood",
  description: "Wood collection illustration: fixed oak tree and a bot holding a wooden axe. No action is executed.",
  regions: [...fixedOak(1, 1), ...fixedOak(5, -5)],
  actor: { position: { x: -1.5, y: 1, z: 1.5 }, yaw: -90, pitch: 0, hand: "wooden_axe" },
  camera: { position: { x: -6, y: 4, z: 6 }, yaw: -125, pitch: 15 },
};
