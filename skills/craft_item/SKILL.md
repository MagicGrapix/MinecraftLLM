---
name: craft_item
description: Craft an item with the personal grid or an explicitly located crafting table.
required_capabilities:
  - goto
  - craft
required_queries:
  - get_inventory
  - find_nearest_blocks
---

# Craft item

Read the inventory before crafting. Use the `"inventory"` station only for a 2x2 recipe. For a 3x3
recipe, find a `crafting_table`, add a `goto` task for it, then call `craft` with
`station: "crafting_table"` and its exact observed position.

If `craft` returns `MISSING_ITEM`, use `missingIngredients` as the list of sub-objectives. If the code
is `RECIPE_NOT_FOUND`, do not repeat the same request without changing the item or station. If the
table is out of reach, correct navigation rather than the capability.

Always verify success with `get_inventory`. The actual quantity produced may slightly exceed the
requested quantity when a recipe produces several items at once.
