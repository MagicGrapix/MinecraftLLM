import { EventEmitter } from "node:events";
import type { Bot } from "mineflayer";
import type { Recipe } from "prismarine-recipe";

export function fakeRecipe(resultId: number, resultCount: number, ingredients: Array<{ id: number; count: number }>): Recipe {
  return { result: { id: resultId, metadata: null, count: resultCount },
    delta: [...ingredients.map(item => ({ ...item, metadata: null })), { id: resultId, metadata: null, count: resultCount }],
    requiresTable: false } as Recipe;
}

export function fakeCraftBot(options: {
  counts: (id: number) => number;
  serverCounts?: (id: number) => number;
  recipes: Recipe[];
  craft: () => Promise<void>;
  blockAt?: () => unknown;
  canSeeBlock?: () => boolean;
  sync?: (respond: () => void, request: number) => void;
}): Bot {
  const items = {
    5: { id: 5, name: "oak_planks" }, 17: { id: 17, name: "oak_log" },
    18: { id: 18, name: "birch_log" }, 58: { id: 58, name: "crafting_table" },
    270: { id: 270, name: "wooden_pickaxe" },
  };
  let requests = 0;
  const client = new EventEmitter();
  Object.assign(client, { write: () => {
    const respond = () => {
      const slots = Array.from({ length: 46 }, () => ({ itemCount: 0, itemId: 0 }));
      let slot = 9;
      for (const item of Object.values(items)) {
        const count = (options.serverCounts ?? options.counts)(item.id);
        if (count > 0) slots[slot++] = { itemCount: count, itemId: item.id };
      }
      client.emit("window_items", { windowId: 0, items: slots, carriedItem: { itemCount: 0 } });
    };
    ++requests;
    if (options.sync) options.sync(respond, requests); else respond();
  } });
  return Object.assign(new EventEmitter(), {
    _client: client, version: "1.21.11", currentWindow: null,
    entity: { position: { distanceTo: () => 2 } },
    registry: { itemsByName: Object.fromEntries(Object.values(items).map(item => [item.name, item])), items },
    inventory: {
      inventoryStart: 9, inventoryEnd: 45, slots: Array(46).fill(null), selectedItem: null,
      count: (id: number) => options.counts(id),
      items: () => Object.values(items).map(item => ({ name: item.name, count: options.counts(item.id) })).filter(item => item.count > 0),
    },
    recipesAll: () => options.recipes, craft: options.craft,
    blockAt: options.blockAt ?? (() => null), canSeeBlock: options.canSeeBlock ?? (() => true),
    closeWindow: async () => undefined,
  }) as unknown as Bot;
}
