---
name: gather
description: Gather a requested quantity of a resource found in the world.
required_capabilities:
  - collect_resource
  - goto
  - equip
  - dig
required_queries:
  - get_inventory
  - find_nearest_blocks
  - get_dropped_items
  - get_block_access
---

# Gather

## When to use this skill

Use this technique when an objective requires a specific quantity of a resource that can be gathered
from currently known chunks, such as logs, stone, coal or iron.

## Information to obtain before acting

1. Read the current inventory snapshot; call `get_inventory` only if it is missing or uncertain.
2. Use the delegated success criterion to calculate the remaining quantity. If the
   request asks for additional resources, use the initial inventory as a baseline;
   an existing item does not prove a new item was collected.
3. When using atomic tools rather than `collect_resource`, look for matching loose items with `get_dropped_items` before digging more blocks.
   Use `names` to filter item names, `maxDistance` for the search radius, and
   `count` for the maximum number of returned entities, not the quantity to collect.
   Each result contains `item`, `count`, `position` and `distance`.
   Without a name filter, unidentified drops have `item: null` and `count: null`;
   their contents are unknown. This tool finds loose items, not placed blocks.
4. For manual collection with no suitable drop visible, call `find_nearest_blocks` with the exact Minecraft block name.
5. Check whether a suitable tool is available before proposing `equip`.

## Recommended strategy

For logs, dirt, cobblestone, coal or raw iron, prefer `collect_resource({ item: "oak_log", quantity: 4 })`.
It searches, navigates, mines and picks up drops without intermediate LLM calls.
Use `item: "coal"` for coal and `item: "raw_iron"` for iron, including deepslate ores.
Mining coal needs a pickaxe; iron needs a harvest-capable pickaxe, such as stone (not wood or gold).
The collector selects an available harvest tool and excludes Silk Touch when it would produce the wrong drop.
It does not smelt raw iron into ingots; use a furnace afterwards.
`quantity` is additional inventory, not target stock. Calculate the missing amount from the
step baseline/current inventory. On partial failure, subtract only a confirmed gain
(`inventoryKnown: true`); otherwise query inventory before deciding what remains.
It can acquire spare dirt for bounded access; missing harvest tools are not crafted.
Read `scaffoldsLeft` separately from collection success. Do not repeat unchanged failures.

For a specific block target or a resource outside that catalogue, use the atomic tools:

1. Call `goto` with `goal: "interact"` at the observed block position and wait for
   its result. If a suitable tool is available, optionally call `equip` before
   calling `dig` at the block's observed position.
   This goal finds a reachable visible face; do not invent feet coordinates or
   navigate underground to the supporting dirt. `goto` may clear obstacles and
   build using dirt/cobblestone already in inventory. It protects the target block.
   Use `canDig: false` / `canPlace: false` when terrain must remain unchanged.
   If access is uncertain after navigation, call `get_block_access` at the observed
   target coordinates. Inspect `reason` and `blocker` before retrying: visibility
   alone is not dig reach, and an unloaded target is unknown, not air.
2. After each tool result, inspect the new state and choose the next observation,
   action, changed approach, or `finish_step` report. Call one tool at a time.
3. After digging, check `get_inventory`. A successful `dig` only proves the block
   broke; it does not prove the dropped resource was picked up.
4. If the item is still missing, call `get_dropped_items` with the desired item name. For a matching
   dropped item, call `goto` to its observed entity position with `range: 0`,
   then check `get_inventory` again after navigation finishes.
   Dropped items are picked up by proximity; do not dig another block merely
   because the first drop remains on the ground.

Capabilities are native tools. Their exact input schemas are supplied in the
tool catalog. A short intended approach can accompany a tool call as assistant
text; there is no separate executable plan to create or advance.

Never invent coordinates. Every position must come from a World Query.

## Error handling

- `TARGET_NOT_FOUND` or `WORLD_CHANGED`: call `find_nearest_blocks` again because the observation is stale.
- `NO_PATH`: inspect the path diagnostics and movement policy, including available scaffolding, and choose a reachable target or
  report the obstruction instead of repeating the same task.
- `OUT_OF_REACH`: inspect `get_block_access`, then choose an appropriate `goto`.
- `MISSING_ITEM` from `equip`: continue without a tool if the resource remains gatherable; otherwise
  report the missing prerequisite.
- `TIMEOUT` or `INTERRUPTED`: observe the world again before replanning.
- Missing or unidentifiable drop: observe loose items and inventory again;
  do not claim that the item was collected.

## Success condition

Verify success with `get_inventory` against the delegated success criterion.
For an additional-resource request, verify the required increase from the initial
inventory; otherwise verify the requested total quantity.

## Known limitations

The collector searches loaded chunks within 32 blocks of its starting position,
stays within 50 blocks, and stops after bounded failures or 300 seconds.
It does not explore new chunks or craft tools. Unknown player buildings are not
automatically recognized; use a testing area. Manual pickup must be verified in inventory.
