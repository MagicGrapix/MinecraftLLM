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
---

# Gather

## When to use this skill

Use this technique when an objective requires a specific quantity of a resource that can be gathered
from currently known chunks, such as logs or stone.

## Information to obtain before acting

1. Call `get_inventory` to measure the quantity already held.
2. Calculate the remaining quantity.
3. Call `find_nearest_blocks` with the exact Minecraft block name.
4. Check whether a suitable tool is available before proposing `equip`.

## Recommended strategy

Work in short horizons. For each known target:

1. create a `goto` `TaskSpec` with sufficient range;
2. add an `equip` `TaskSpec` only when a useful tool is available;
3. add a `dig` `TaskSpec` at the block's exact observed position;
4. wait for results before selecting the next target;
5. query the inventory again after several blocks or after an ambiguous result.

Capabilities are never called directly as tools. Submit the `TaskSpec` objects through
`enqueue_tasks`, using the latest execution revision.

Never invent coordinates. Every position must come from a World Query.

## Error handling

- `TARGET_NOT_FOUND` or `WORLD_CHANGED`: call `find_nearest_blocks` again because the observation is stale.
- `NO_PATH`: try another known target instead of immediately repeating the same task.
- `OUT_OF_REACH`: add or correct a `goto` task.
- `MISSING_ITEM` from `equip`: continue without a tool if the resource remains gatherable; otherwise
  report the missing prerequisite.
- `TIMEOUT` or `INTERRUPTED`: read a fresh execution snapshot and observe the world before replanning.

## Success condition

Verify success only with `get_inventory`. The skill is complete when the total quantity of the
requested resource is greater than or equal to the target quantity.

## Known limitations

This skill does not explore new chunks, craft tools, or explicitly collect distant item drops. It
assumes nearby drops are collected naturally after digging.
