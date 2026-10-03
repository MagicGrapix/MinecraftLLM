import type { Bot } from "mineflayer";
import { containsPosition, createArenaBounds } from "../../src/devworld/ArenaBounds";
import { WorldPlanFactory, type PlannedCommand } from "../../src/devworld/WorldPlan";
import type { WorldBuilderConfig } from "../../src/devworld/WorldBuilderConfig";
import type { ContainerFixture, DropFixture, DropObservation, Observation } from "./types";

export function environmentPlan(config: WorldBuilderConfig, containers: readonly ContainerFixture[], drops: readonly DropFixture[]) {
  const commands: PlannedCommand[] = [];
  if (containers.length > 4 || drops.length > 16) throw new Error("Too many scenario containers or drops.");
  for (const { position, items } of containers) {
    if (Object.keys(items).length > 27) throw new Error("Scenario chest has more than 27 item types.");
    const bounds = createArenaBounds(position, position);
    if (!containsPosition(config.arena, position)) throw new Error("Scenario chest is outside the testing arena.");
    for (const [slot, [item, count]] of Object.entries(items).entries()) {
      validateStack(item, count);
      commands.push({ text: `item replace block ${position.x} ${position.y} ${position.z} container.${slot} with minecraft:${item} ${count}`,
        estimatedBlocksChanged: 0, affectedBounds: bounds });
    }
  }
  for (const { position, item, count } of drops) {
    validateStack(item, count);
    if (![position.x, position.y, position.z].every(Number.isFinite)) throw new Error("Invalid drop position.");
    if (!containsPosition(config.arena, position)) throw new Error("Scenario drop is outside the testing arena.");
    const p = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
    commands.push({ text: `summon minecraft:item ${position.x} ${position.y} ${position.z} {Item:{id:"minecraft:${item}",count:${count}},PickupDelay:0s,Age:-32768s,Motion:[0.0d,0.0d,0.0d]}`,
      estimatedBlocksChanged: 0, affectedBounds: createArenaBounds(p, p) });
  }
  return commands.length ? new WorldPlanFactory(config).create("Scenario chest contents and loose items", commands) : null;
}

export function observeDrops(bot: Pick<Bot, "entities">, config: Pick<WorldBuilderConfig, "arena">): DropObservation[] {
  return Object.values(bot.entities).filter((entity) =>
    ["item", "Item", "item_stack"].includes(entity.name ?? "") && containsPosition(config.arena, entity.position))
    .map((entity) => {
      let item = null;
      try { item = entity.getDroppedItem(); } catch { /* Metadata can arrive after the entity. */ }
      return { position: { x: entity.position.x, y: entity.position.y, z: entity.position.z }, item: item?.name ?? null, count: item?.count ?? null };
    });
}

export function environmentReady(observed: Pick<Observation, "containers" | "drops">, containers: readonly ContainerFixture[], drops: readonly DropFixture[]): boolean {
  if ((observed.containers?.length ?? 0) !== containers.length || (observed.drops?.length ?? 0) !== drops.length) return false;
  const inventoriesEqual = (a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>) =>
    JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
  return containers.every((expected) => observed.containers?.some((actual) =>
    samePosition(actual.position, expected.position) && actual.inventory !== null && inventoriesEqual(actual.inventory, expected.items)))
    && drops.every((expected) => observed.drops?.some((actual) => actual.item === expected.item && actual.count === expected.count
      && Math.hypot(actual.position.x - expected.position.x, actual.position.y - expected.position.y, actual.position.z - expected.position.z) < 0.75));
}

function samePosition(a: { x: number; y: number; z: number }, b: typeof a): boolean { return a.x === b.x && a.y === b.y && a.z === b.z; }
function validateStack(item: string, count: number): void {
  if (!/^[a-z0-9_]+$/.test(item) || !Number.isInteger(count) || count < 1 || count > 64) throw new Error("Invalid scenario item/count.");
}
