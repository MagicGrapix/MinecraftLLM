---
name: craft_item
description: Fabriquer un item avec la grille personnelle ou une table de craft explicite.
required_capabilities:
  - goto
  - craft
required_queries:
  - get_inventory
  - find_nearest_blocks
---

# Craft item

Lis l'inventaire avant toute fabrication. Utilise la station `"inventory"` uniquement pour une recette
2×2. Pour une recette 3×3, trouve une `crafting_table`, ajoute `goto` vers elle, puis appelle `craft`
avec `station: "crafting_table"` et sa position exacte.

Si `craft` retourne `MISSING_ITEM`, utilise `missingIngredients` comme liste de sous-objectifs. Si le
code est `RECIPE_NOT_FOUND`, ne répète pas la même demande sans changer l'item ou la station. Si la
table est hors de portée, corrige la navigation plutôt que la capability.

La réussite doit toujours être vérifiée avec `get_inventory`; la quantité réellement produite peut
dépasser légèrement la quantité demandée lorsque la recette fabrique plusieurs items à la fois.
