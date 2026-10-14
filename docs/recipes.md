# Recipe library

The library documents crafting knowledge. It does not craft, check the bot's inventory, place a table,
or prove that a server accepted a recipe. No recipe file means missing knowledge, not impossibility.
The initial coverage is deliberately small: oak planks, sticks, crafting table, wooden axe/pickaxe/sword,
stone pickaxe and furnace. Sticks include concrete oak and birch variants.

## Files and validation

Edit `recipes/<exact_item_name>.json`, then restart the bot to reload. Each file describes one output item;
variants have 1-based indices in tools. Keep the order stable when editing.

```json
{
  "item": "wooden_axe",
  "minecraftVersion": "1.21.11",
  "variants": [{
    "label": "Oak planks",
    "type": "shaped",
    "outputCount": 1,
    "station": "crafting_table",
    "palette": { "A": "oak_planks", "B": "stick" },
    "rows": ["AA", "AB", ".B"]
  }]
}
```

For shapeless crafting, replace `palette`/`rows` with
`"ingredients":[{"item":"oak_log","count":1}]` and use `"type":"shapeless"`.
The oak-plank output count is 4, station `inventory`. Its renderer says `Placement: any order`;
it does not invent a mandatory layout.

At startup, the library checks:

- JSON/schema, filename/output match, version, exact item IDs, positive yields, rectangular patterns,
  defined symbols and minimum station (`inventory` = 2x2, `crafting_table` = 3x3).
- Concrete ingredients, shape and yield against installed `minecraft-data` for the connected version.
  Horizontal mirrors and translations of shaped patterns are equivalent; rotations are not.
- At most 9 ingredient slots; no invented category such as `any_wood`.
- Regular files only, at most 32 KiB and 8 variants. Limits are in `src/config.ts`.

Invalid files remain unavailable with filename/field diagnostics. They are not silently used or removed.
Search lists only valid documented files. Exact reads distinguish `INVALID_RECIPE_FILE`, `UNKNOWN_ITEM`,
`VERSION_MISMATCH`, `RECIPE_NOT_RECOGNIZED`, `UNSUPPORTED_RECIPE` and `RECIPE_MISSING`.
A missing library directory is a startup configuration error.

Server datapacks and custom recipes are not automatically known. Smelting, special dynamic recipes,
metadata-dependent ingredients and recipes with remainders are not supported by this first format.
Do not approximate them with a grid; extend schema, catalog validation, renderer and tests together.

## Agent tools

- `search_recipes({"query":"wooden axe"})`: exact names, words and typo suggestions, up to five entries.
  A truncated result includes the total and asks for a narrower query. No embeddings or inventory filter.
- `read_recipe({"item":"wooden_axe","variant":1})`: exact name, optional 1-based variant (default 1).
  Returns output **per craft**, station, ingredient counts and a `[A] [A] [ ]` grid.
  Shaped counts are derived from occupied cells, not maintained twice. Other variants get a short index.
- `submit_plan({"steps":[{"title":"...","successCriteria":"..."}]})`: planner-only terminal handoff.

The first two are shared by planner and actioner; the coordinator does not receive them as tools.
The planner sees the actioner's catalog as documentation but cannot execute it.
Whole batches still matter: 7 missing planks require 2 logs and yield 8 planks.
Recipe result size is limited to 6,000 characters; an oversized result fails rather than cutting a grid.
Tool traces contain structured data; the conversation contains only the readable feedback, with its action number.

## Verification and smoke

`npm.cmd test` uses fake LLMs and does not start Minecraft or a model. Recipe tests compare the initial
files to the installed version catalog and cover invalid patterns, yields, variants and missing knowledge.
Planner tests exercise tool replay, invalid submissions, limits, cancellation and compression; workflow tests
check that only accepted plans replace the checklist.

`npm.cmd run smoke:planner` explicitly calls the configured LLM, **without Minecraft**. It uses the real
planner prompt and tools, with an empty-inventory fixture, nearby oak trees and a mocked shelter bill
of 66 oak planks. The user request is in `tests/fixtures/prompts/planner-axe-shelter.md`.
Arguments after `--` replace that request, not the fixture world. Ctrl+C aborts; total time is bounded at 5 minutes.
Full requests/results are saved in session traces and `logs/planner/planner_<session>.json`.
Inspect quantities, batches, stations and missing knowledge manually: a valid submission is not proof that
the plan can be executed. Real Minecraft campaigns remain a separate validation.

Deferred: editing UI, self-learned recipes, semantic skill search and additional production methods.
