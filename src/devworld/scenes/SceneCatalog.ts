import { woodScene } from "./wood";
import { worldScene } from "./world";
import { craftingScene } from "./crafting";
import { shelterScene } from "./shelter";

export const SCENES = [woodScene, worldScene, craftingScene, shelterScene] as const;

export function getScene(id: number) {
  const scene = SCENES.find((entry) => entry.id === id);
  if (!scene) throw new Error(`Unknown scene ${id}. Use scene list.`);
  return scene;
}
