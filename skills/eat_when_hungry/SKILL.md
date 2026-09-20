---
name: eat_when_hungry
description: Choisir et consommer un aliment lorsque le niveau de nourriture est bas.
required_capabilities:
  - equip
  - consume
required_queries:
  - get_self
  - get_inventory
---

# Eat when hungry

Lis d'abord `get_self`. Si la nourriture est basse, utilise `get_inventory` pour choisir un aliment
adapté réellement disponible. Ajoute ensuite `equip` vers `"hand"`, puis `consume` avec le même
`expectedItem` et `hand: "hand"`.

Après le résultat de `consume`, relis `get_self` et vérifie que la nourriture a augmenté. Un
`NOT_CONSUMABLE` impose de choisir un autre item. Un `MISSING_ITEM` impose de relire l'inventaire. Un
`ACTION_NOT_CONFIRMED` ne doit jamais être interprété comme un repas réussi.

Ne consomme pas si la nourriture est déjà pleine, sauf si l'objectif explicite concerne l'effet d'une
potion, du lait ou du miel.
