import { Vec3 } from "vec3";
import type { Position } from "../shared/types";

export function toVec3(position: Position): Vec3 {
  return new Vec3(position.x, position.y, position.z);
}

export function fromVec3(position: Vec3): Position {
  return {
    x: position.x,
    y: position.y,
    z: position.z,
  };
}
