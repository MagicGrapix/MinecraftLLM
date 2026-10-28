import MinecraftData from "minecraft-data";
import type { Position } from "../../shared/types";
import { containsBounds, containsPosition, createArenaBounds } from "../ArenaBounds";
import { FillCommandGenerator } from "../generators/FillCommandGenerator";
import { ResetArenaGenerator } from "../generators/ResetArenaGenerator";
import { WorldPlanFactory, type PlannedCommand } from "../WorldPlan";
import type { WorldBuilderConfig } from "../WorldBuilderConfig";
import type { SceneDefinition, ScenePose } from "./SceneDefinition";

export const PHOTO_ACTOR = "photo_bot";
export const PHOTO_STAGE = { x: 32, z: 32, radius: 10, height: 10 };

export function createScenePlan(config: WorldBuilderConfig, scene: SceneDefinition) {
  if ([config.controllerUsername, config.agentUsername].some((name) => name.toLowerCase() === PHOTO_ACTOR)) {
    throw new Error(`${PHOTO_ACTOR} is reserved for the photo actor; choose a different agent/controller username.`);
  }
  const origin = { x: PHOTO_STAGE.x, y: config.surfaceY, z: PHOTO_STAGE.z };
  const absolute = (p: Position): Position => ({ x: origin.x + p.x, y: origin.y + p.y, z: origin.z + p.z });
  const bounds = createArenaBounds(
    absolute({ x: -PHOTO_STAGE.radius, y: -3, z: -PHOTO_STAGE.radius }),
    absolute({ x: PHOTO_STAGE.radius, y: PHOTO_STAGE.height, z: PHOTO_STAGE.radius }),
  );
  if (!containsBounds(config.arena, bounds)) throw new Error("Photo stage is outside the configured arena. No commands sent.");
  const checkPosition = (p: Position): Position => {
    const value = absolute(p);
    if (!Object.values(value).every(Number.isFinite) || !containsPosition(bounds, value)) {
      throw new Error("Scene position is outside the photo stage.");
    }
    return value;
  };
  const pose = (value: ScenePose) => {
    if (!Number.isFinite(value.yaw) || !Number.isFinite(value.pitch) || Math.abs(value.pitch) > 90) {
      throw new Error("Invalid scene rotation.");
    }
    return { ...value, position: checkPosition(value.position) };
  };
  const actor = pose(scene.actor);
  const camera = pose(scene.camera);
  const registry = MinecraftData(config.version);
  const validateName = (name: string, kind: "block" | "item") => {
    if (!/^[a-z0-9_]+$/.test(name) || !(kind === "block" ? registry.blocksByName[name] : registry.itemsByName[name])) {
      throw new Error(`Unknown scene ${kind}: ${name}`);
    }
  };
  validateName(scene.actor.hand, "item");
  const fill = new FillCommandGenerator(config.maxFillBlocks);
  const commands: PlannedCommand[] = [
    { text: `gamemode creative ${PHOTO_ACTOR}` },
    { text: `tp ${PHOTO_ACTOR} ${origin.x} ${bounds.max.y} ${origin.z}`, affectedBounds: bounds },
    { text: `clear ${PHOTO_ACTOR}` },
    ...new ResetArenaGenerator({ arena: bounds, surfaceY: config.surfaceY, agentUsername: PHOTO_ACTOR, fill }).generateTerrainReset(),
  ];
  const expected = new Map<string, { position: Position; block: string }>();
  const remember = (min: Position, max: Position, block: string) => {
    for (let y = min.y; y <= max.y; y++) for (let z = min.z; z <= max.z; z++) for (let x = min.x; x <= max.x; x++) {
      expected.set(`${x},${y},${z}`, { position: { x, y, z }, block });
    }
  };
  remember(bounds.min, bounds.max, "air");
  for (const [dy, block] of [[0, "grass_block"], [-1, "dirt"], [-2, "dirt"], [-3, "bedrock"]] as const) {
    remember({ ...bounds.min, y: origin.y + dy }, { ...bounds.max, y: origin.y + dy }, block);
  }
  for (const region of scene.regions) {
    validateName(region.block, "block");
    const area = createArenaBounds(checkPosition(region.min), checkPosition(region.max));
    commands.push(...fill.generate(area, `minecraft:${region.block}`).map((command) => ({
      ...command,
      text: region.block === "oak_leaves"
        ? command.text.replace("minecraft:oak_leaves ", "minecraft:oak_leaves[persistent=true] ") : command.text,
    })));
    remember(area.min, area.max, region.block);
  }
  // Covered grass naturally turns into dirt. Make those hidden supports stable immediately.
  for (const cell of [...expected.values()]) {
    if (cell.position.y !== config.surfaceY + 1 || ["air", "oak_leaves"].includes(cell.block)) continue;
    const below = { ...cell.position, y: config.surfaceY };
    if (expected.get(`${below.x},${below.y},${below.z}`)?.block !== "grass_block") continue;
    commands.push(...fill.generate(createArenaBounds(below, below), "minecraft:dirt"));
    remember(below, below, "dirt");
  }
  const drops = (scene.drops ?? []).map((drop) => ({ ...drop, position: checkPosition(drop.position) }));
  for (const drop of drops) {
    validateName(drop.item, "item");
    const cell = { x: Math.floor(drop.position.x), y: Math.floor(drop.position.y), z: Math.floor(drop.position.z) };
    commands.push({
      // Java 1.21.x item NBT; indefinite age/pickup delay keep the illustration in place.
      text: `summon minecraft:item ${xyz(drop.position)} {Item:{id:"minecraft:${drop.item}",count:1},PickupDelay:32767s,Age:-32768s,NoGravity:1b,Motion:[0.0d,0.0d,0.0d]}`,
      affectedBounds: createArenaBounds(cell, cell),
    });
  }
  commands.push(
    { text: `item replace entity ${PHOTO_ACTOR} weapon.mainhand with minecraft:${scene.actor.hand} 1` },
    { text: `tp ${PHOTO_ACTOR} ${xyz(actor.position)} ${actor.yaw} ${actor.pitch}`, affectedBounds: bounds },
    { text: "time set noon" },
    { text: "weather clear" },
  );
  return {
    scene, bounds, actor, camera, drops, expected: [...expected.values()],
    plan: new WorldPlanFactory(config).create(`Static photo scene ${scene.id}: ${scene.name}`, commands),
  };
}

export type PreparedScene = ReturnType<typeof createScenePlan>;

export function xyz(p: Position): string { return `${p.x} ${p.y} ${p.z}`; }
