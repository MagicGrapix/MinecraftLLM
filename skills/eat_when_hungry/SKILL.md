---
name: eat_when_hungry
description: Select and consume food when the bot's food level is low.
required_capabilities:
  - equip
  - consume
required_queries:
  - get_self
  - get_inventory
---

# Eat when hungry

Call `get_self` first. If the food level is low, use `get_inventory` to select a suitable food item
that is actually available. Call `equip` for `"hand"` and wait for its result, then call `consume` with the same
`expectedItem` and `hand: "hand"`.

After the `consume` result, call `get_self` again and verify that the food level increased.
`NOT_CONSUMABLE` requires selecting another item. `MISSING_ITEM` requires reading the inventory again.
Never interpret `ACTION_NOT_CONFIRMED` as a successful meal.

Do not consume anything when the food level is already full unless the explicit objective concerns an
effect from a potion, milk, or honey.
