import { EventEmitter } from "node:events";
import mcData from "minecraft-data";
import blockLoader from "prismarine-block";
import itemLoader from "prismarine-item";
import { Vec3 } from "vec3";
import type { Bot } from "mineflayer";
import type { ExecutionContext } from "../../src/capabilities/Capability";
import { CollectionTerrain } from "../../src/collection/CollectionTerrain";
import { CollectionTrace } from "../../src/collection/CollectionTrace";
import type { ServerInventoryConfirmation } from "../../src/runtime/ServerInventoryConfirmation";

export function terrainFixture() {
  const data = mcData("1.21.11"), Block = blockLoader("1.21.11"), Item = itemLoader("1.21.11");
  const cells = new Map<string, string | null>(), events: Record<string, unknown>[] = [];
  const read = (p: Vec3) => {
    const name = cells.has(p.toString()) ? cells.get(p.toString()) : p.y < 0 ? "dirt" : "air";
    if (name === null) return null;
    const block = Block.fromStateId(data.blocksByName[name!]!.minStateId, 0); block.position = p.clone(); return block;
  };
  const client = new EventEmitter();
  const set = (p: Vec3, name: string, packet = true) => {
    cells.set(p.toString(), name);
    if (packet) client.emit("block_change", { location: p, type: read(p)!.stateId });
  };
  let digs = 0, available = 8;
  const bot = Object.assign(new EventEmitter(), { registry: data, _client: client,
    game: { dimension: "overworld" }, entity: { position: new Vec3(0.5, 0, 0.5), onGround: true },
    heldItem: new Item(data.itemsByName.dirt!.id, 8), inventory: { items: () => [] }, blockAt: read,
    canDigBlock: () => true, digTime: () => 1, stopDigging: () => {},
    dig: async (b: ReturnType<typeof read>) => { digs++; set(b!.position, "air"); },
  }) as unknown as Bot;
  const controller = new AbortController();
  const context = { runtime: { bot }, signal: controller.signal, world: { getBlockAccess: () => ({ canDig: true }) }, deferCancellationUntil: () => {} } as unknown as ExecutionContext;
  const observation = { synchronize: async () => true, get snapshot() { return { items: { dirt: available } }; } } as unknown as ServerInventoryConfirmation;
  const terrain = new CollectionTerrain(context, observation, { x: 0, y: 0, z: 0 }, new CollectionTrace(e => events.push(e)), () => {});
  const policy = (reserved = 0) => terrain.policy({ x: 3, y: 3, z: 0 }, { x: 0, y: 0, z: 0 }, reserved, controller.signal, s => { throw new Error(s); });
  const place = (p: Vec3, reserved = 0, run = async () => { set(p, "dirt"); }) => policy(reserved).intercept("placeBlock", [read(p.offset(0, -1, 0)), new Vec3(0, 1, 0)], run);
  return { bot, context, controller, terrain, cells, events, read, set, policy, place, digs: () => digs, stock: (n: number) => { available = n; } };
}
