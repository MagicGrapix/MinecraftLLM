---
name: gather
description: Gather a requested quantity of a resource found in the world.
required_capabilities:
  - goto
  - equip
  - dig
required_queries:
  - get_inventory
  - find_nearest_blocks
  - get_nearby_entities
  - get_block_access
---

# Gather

## When to use this skill

Use this technique when an objective requires a specific quantity of a resource that can be gathered
from currently known chunks, such as logs or stone.

## Information to obtain before acting

1. Call `get_inventory` to measure the quantity already held.
2. Calculate the remaining quantity.
3. Look for matching drops with `get_nearby_entities` before digging more blocks.
   A dropped-item entity has `droppedItem` with its item name and count when the
   server has supplied that metadata. If `droppedItem` is null, its contents are unknown.
4. If no suitable drop is visible, call `find_nearest_blocks` with the exact Minecraft block name.
5. Check whether a suitable tool is available before proposing `equip`.

## Recommended strategy

Work in short horizons. For each known block target:

1. Use `get_capability_schemas` for any TaskSpec you will create.
2. Use `set_plan` to prepare a short sequence, usually `goto` with `goal: "interact"` at the observed block position,
   optional `equip` if an appropriate tool is in inventory, then `dig` at the
   block's observed position.
   This goal finds a reachable visible face; do not invent feet coordinates or
   navigate underground to the supporting dirt. `goto` may clear obstacles and
   build using dirt/cobblestone already in inventory. It protects the target block.
   Use `canDig: false` / `canPlace: false` when terrain must remain unchanged.
   If access is uncertain after navigation, call `get_block_access` at the observed
   target coordinates. Inspect `reason` and `blocker` before retrying: visibility
   alone is not dig reach, and an unloaded target is unknown, not air.
3. Call `continue_plan` to execute the next task. After each TaskResult, inspect
   the new state and decide whether to continue, replace the plan, or finish.
4. After digging, check `get_inventory`. A successful `dig` only proves the block
   broke; it does not prove the dropped resource was picked up.
5. If the item is still missing, call `get_nearby_entities`. For a matching
   dropped item, plan a `goto` to its observed entity position with `range: 0`,
   execute it with `continue_plan`, then check `get_inventory` again.
   Dropped items are picked up by proximity; do not dig another block merely
   because the first drop remains on the ground.

Capabilities are never called directly as tools. `set_plan` does not execute a
task; `continue_plan` executes exactly one planned task.

Never invent coordinates. Every position must come from a World Query.

## Error handling

- `TARGET_NOT_FOUND` or `WORLD_CHANGED`: call `find_nearest_blocks` again because the observation is stale.
- `NO_PATH`: inspect the path diagnostics and movement policy, including available scaffolding, and choose a reachable target or
  report the obstruction instead of repeating the same task.
- `OUT_OF_REACH`: add or correct a `goto` task.
- `MISSING_ITEM` from `equip`: continue without a tool if the resource remains gatherable; otherwise
  report the missing prerequisite.
- `TIMEOUT` or `INTERRUPTED`: observe the world again before replanning.
- Missing or unidentifiable drop: observe nearby entities and inventory again;
  do not claim that the item was collected.

## Success condition

Verify success only with `get_inventory`. The skill is complete when the total quantity of the
requested resource is greater than or equal to the target quantity.

## Known limitations

This skill does not explore new chunks, craft tools, or provide a separate
collection capability. Pickup depends on reaching the drop and must be verified
in the inventory.
