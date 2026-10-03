import type { Observation } from "../e2e/types";

export function observation(overrides: Partial<Observation> = {}): Observation {
  return { inventory: {}, position: { x: 0.5, y: -60, z: 0.5 }, yaw: Math.PI, pitch: 0,
    health: 20, food: 20, effects: 0, onGround: true, physicalIdle: true, mode: "idle", planSteps: 0, completedSteps: 0, ...overrides };
}
