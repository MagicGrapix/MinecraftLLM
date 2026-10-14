import type { Position } from "../../../src/shared/types";

export interface CollectionScene {
  name: string;
  blocks: { position: Position; name: string }[];
  requested: number;
  expectedGain: number;
  stopDuringDig?: boolean;
}

/** Relative to feet on the standard superflat surface; no randomness or LLM. */
export function collectionScenes(origin: Position): CollectionScene[] {
  const cell = (x: number, y: number, z: number, name: string) => ({
    position: { x: origin.x + x, y: origin.y + y, z: origin.z + z }, name,
  });
  const hill = [cell(4, 2, 0, "oak_log")];
  for (let x = 3; x <= 5; x++) for (let z = -1; z <= 1; z++) hill.push(cell(x, 0, z, "dirt"));
  hill.push(cell(4, 1, 0, "dirt"));
  const hollow = [cell(4, -1, 0, "oak_log")];
  for (let x = 3; x <= 5; x++) for (let z = -1; z <= 1; z++) {
    if (x !== 4 || z !== 0) hollow.push(cell(x, -1, z, "air"));
  }
  const obstacle = [cell(4, 0, 0, "oak_log")];
  for (let y = 0; y < 2; y++) for (const [x, z] of [[3, 0], [5, 0], [4, -1], [4, 1]]) obstacle.push(cell(x!, y, z!, "dirt"));
  return [
    { name: "hill", blocks: hill, requested: 1, expectedGain: 1 },
    { name: "hollow", blocks: hollow, requested: 1, expectedGain: 1 },
    { name: "obstacle", blocks: obstacle, requested: 1, expectedGain: 1 },
    { name: "partial", blocks: [cell(3, 0, 0, "oak_log"), cell(4, 0, 0, "oak_log")], requested: 3, expectedGain: 2 },
    { name: "stop", blocks: [cell(3, 0, 0, "oak_log")], requested: 1, expectedGain: 0, stopDuringDig: true },
  ];
}
