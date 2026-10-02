import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import { iterators } from "prismarine-world";
import type { Vec3 } from "vec3";
import { fromVec3, toVec3 } from "../runtime/PositionAdapter";
import type { Position } from "../shared/types";

// Matches bot.dig(block, false, "raycast") in the installed Mineflayer version.
const DIG_FACE_REACH = 5;
const MAX_VISIBILITY_DISTANCE = 64;

export type BlockAccessReason =
  | "accessible"
  | "unloaded"
  | "empty"
  | "not_diggable"
  | "out_of_reach"
  | "occluded"
  | "visibility_unknown"
  | "no_visible_face"
  | "not_on_ground"
  | "already_digging";

export interface BlockAccessInfo {
  readonly position: Position;
  readonly loaded: boolean;
  readonly block: string | null;
  /** Distance from the current eyes to the block CENTER, not its integer corner. */
  readonly distanceFromEyes: number | null;
  /** Maximum eye-to-face raycast distance used by dig; not a center-distance limit. */
  readonly reach: number;
  /** Dig's center precheck and nearest visible face (or candidate face if obscured). */
  readonly withinReach: boolean | null;
  /** A dig face is unobstructed; independent of the current camera direction. */
  readonly visible: boolean | null;
  /** Local preflight only: does not prove permission, server acceptance, or item drops. */
  readonly canDig: boolean;
  readonly reason: BlockAccessReason;
  /** One observed obstruction, not necessarily the only one. */
  readonly blocker: { readonly block: string; readonly position: Position } | null;
}

type AccessBot = Pick<Bot, "entity" | "blockAt" | "canDigBlock" | "targetDigBlock">;
type FaceProbe =
  | { kind: "visible"; distance: number }
  | { kind: "blocked"; distance: number; block: Block }
  | { kind: "unknown" }
  | { kind: "miss" };

/** Inspect geometry without lookAt, movement, digging, or mutation of cached blocks. */
export function inspectBlockAccess(bot: AccessBot, position: Position): BlockAccessInfo {
  const block = bot.blockAt(toVec3(position));
  const base: BlockAccessInfo = {
    position: { ...position }, loaded: block !== null, block: block?.name ?? null,
    distanceFromEyes: null, reach: DIG_FACE_REACH, withinReach: null,
    visible: null, canDig: false, reason: "unloaded", blocker: null,
  };
  if (!block) return base;

  // Mineflayer sets eyeHeight at runtime; its upstream Entity typings omit it.
  const eyeHeight = (bot.entity as typeof bot.entity & { eyeHeight?: number }).eyeHeight;
  if (eyeHeight === undefined || !Number.isFinite(eyeHeight)) {
    return { ...base, reason: "visibility_unknown" };
  }
  const eyes = bot.entity.position.offset(0, eyeHeight, 0);
  const center = block.position.offset(0.5, 0.5, 0.5);
  const distanceFromEyes = eyes.distanceTo(center);
  const measured = { ...base, distanceFromEyes };
  // DigCapability rejects empty bounding boxes, including fluids and plants.
  if (block.boundingBox === "empty") {
    return { ...measured, visible: false, reason: "empty" };
  }

  // canDigBlock uses a fixed 1.65 eye offset and a 5.1 center-distance gate.
  // Keep that separate from dig's actual 5-block eye-to-face raycast.
  const centerInReach = center.distanceTo(bot.entity.position.offset(0, 1.65, 0)) <= 5.1;
  if (distanceFromEyes > MAX_VISIBILITY_DISTANCE) {
    return { ...measured, withinReach: false, reason: "out_of_reach" };
  }

  const faces = candidateFaces(eyes, center);
  if (faces.length === 0) {
    return { ...measured, visible: false, reason: block.diggable ? "no_visible_face" : "not_diggable" };
  }
  const probes = faces.map((face) => probeFace(bot, eyes, face, block));
  const visibleFaces = probes.filter((probe): probe is Extract<FaceProbe, { kind: "visible" }> => probe.kind === "visible");
  const obstructions = probes.filter((probe): probe is Extract<FaceProbe, { kind: "blocked" }> => probe.kind === "blocked");
  const visible = visibleFaces.length > 0 ? true : probes.some((probe) => probe.kind === "unknown") ? null : false;
  const nearestFaceDistance = visibleFaces.length > 0
    ? Math.min(...visibleFaces.map((face) => face.distance))
    : Math.min(...faces.map((face) => eyes.distanceTo(face)));
  const withinReach = centerInReach && nearestFaceDistance <= DIG_FACE_REACH;
  const obstruction = visible === false
    ? obstructions.sort((left, right) => left.distance - right.distance)[0]
    : undefined;
  const observed = {
    ...measured, withinReach, visible,
    blocker: obstruction ? { block: obstruction.block.name, position: fromVec3(obstruction.block.position) } : null,
  };

  let reason: BlockAccessReason;
  if (!block.diggable) reason = "not_diggable";
  else if (!withinReach || !bot.canDigBlock(block)) reason = "out_of_reach";
  else if (visible === null) reason = "visibility_unknown";
  else if (!visible) reason = obstruction ? "occluded" : "no_visible_face";
  else if (bot.targetDigBlock) reason = "already_digging";
  else if (!bot.entity.onGround) reason = "not_on_ground";
  else reason = "accessible";
  return { ...observed, canDig: reason === "accessible", reason };
}

function candidateFaces(eyes: Vec3, center: Vec3): Vec3[] {
  const delta = eyes.minus(center);
  const faces: Vec3[] = [];
  // Same candidate face centers and ordering as Mineflayer's dig raycast.
  for (const axis of ["y", "x", "z"] as const) {
    if (Math.abs(delta[axis]) <= 0.5) continue;
    const face = center.clone();
    face[axis] += Math.sign(delta[axis]) * 0.5;
    faces.push(face);
  }
  return faces;
}

function probeFace(bot: AccessBot, eyes: Vec3, face: Vec3, target: Block): FaceProbe {
  const faceDistance = eyes.distanceTo(face);
  // One additional block lets rays hit a slab's actual surface behind its cube face.
  const range = Math.min(MAX_VISIBILITY_DISTANCE, faceDistance + 1);
  const ray = new iterators.RaycastIterator(eyes, face.minus(eyes).normalize(), range);
  let cell: Position | null = eyes.floored();
  while (cell) {
    const block = bot.blockAt(toVec3(cell));
    // Unlike world.raycast, do not silently treat unloaded cells as transparent air.
    if (!block) return { kind: "unknown" };
    const hit = ray.intersect(block.shapes, block.position);
    if (hit) {
      const distance = eyes.distanceTo(hit.pos);
      if (distance > range) return { kind: "unknown" };
      const isTarget = block.position.equals(target.position);
      // Mineflayer rejects intersections before the candidate face center.
      if (isTarget && distance >= faceDistance) return { kind: "visible", distance };
      return isTarget ? { kind: "miss" } : { kind: "blocked", distance, block };
    }
    if (block.position.equals(target.position)) return { kind: "miss" };
    cell = ray.next();
  }
  return { kind: "miss" };
}
