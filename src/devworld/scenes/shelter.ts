import { parseArchitectDrawing } from "../../building/ArchitectDrawing";
import { region, type SceneDefinition } from "./SceneDefinition";

// Top-down layers, bottom to top. South entrance: two air cells vertically.
// West window: one air cell in the upper wall. No physical door.
export const SHELTER_DRAWING = `AAAAA
AAAAA
AAAAA
AAAAA
AAAAA

AAAAA
A...A
A...A
A...A
AA.AA

AAAAA
A...A
....A
A...A
AA.AA

AAAAA
AAAAA
AAAAA
AAAAA
AAAAA`;

const parsed = parseArchitectDrawing(SHELTER_DRAWING);
if (!parsed.ok) throw new Error(parsed.error.message);

export const shelterScene: SceneDefinition = {
  id: 4,
  name: "shelter",
  description: "Blueprint illustration: fixed 5x5x4 shelter with a two-block entrance and a one-block window. Built by server commands, not by the agent.",
  drawing: SHELTER_DRAWING,
  regions: parsed.value.layers.flatMap((layer, y) => layer.flatMap((row, z) =>
    [...row.matchAll(/A+|\.+/g)].map((run) => region(run[0][0] === "A" ? "oak_planks" : "air",
      run.index! - 2, y, z - 2, run.index! + run[0].length - 3, y, z - 2)))),
  actor: { position: { x: 0.5, y: 1, z: 4.5 }, yaw: -135, pitch: 0, hand: "oak_planks" },
  camera: { position: { x: -7, y: 4, z: 8 }, yaw: -135, pitch: 15 },
};
