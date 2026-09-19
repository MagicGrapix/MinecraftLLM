---
name: gather
description: Récolter une quantité donnée d'une ressource présente dans le monde.
required_capabilities:
  - goto
  - equip
  - dig
required_queries:
  - get_inventory
  - find_nearest_blocks
---

# Gather

## Quand utiliser ce skill

Utilise cette technique lorsqu'un objectif demande d'obtenir une quantité précise d'une ressource
qui peut être récoltée dans les chunks actuellement connus, par exemple des bûches ou de la pierre.

## Informations à obtenir avant d'agir

1. Appelle `get_inventory` pour mesurer la quantité déjà possédée.
2. Calcule la quantité restante.
3. Appelle `find_nearest_blocks` avec le nom exact du bloc recherché.
4. Vérifie si un outil adapté est disponible avant de proposer `equip`.

## Stratégie recommandée

Travaille par petits horizons. Pour chaque cible connue :

1. propose un `TaskSpec` `goto` avec une portée suffisante ;
2. propose `equip` seulement si un outil utile est disponible ;
3. propose `dig` à la position exacte du bloc ;
4. attends les résultats avant de sélectionner la cible suivante ;
5. redemande l'inventaire après quelques blocs ou après un résultat ambigu.

Ne produis pas de coordonnées inventées. Toutes les positions doivent provenir d'une World Query.

## Gestion des erreurs

- `TARGET_NOT_FOUND` ou `WORLD_CHANGED` : relance `find_nearest_blocks`, car l'observation est obsolète.
- `NO_PATH` : essaie une autre cible connue plutôt que de répéter immédiatement la même tâche.
- `OUT_OF_REACH` : ajoute ou corrige une tâche `goto`.
- `MISSING_ITEM` sur `equip` : continue sans outil si la ressource reste récoltable, sinon signale le
  prérequis manquant.
- `TIMEOUT` ou `INTERRUPTED` : relis le snapshot d'exécution et le monde avant de replanifier.

## Condition de réussite

La réussite est vérifiée uniquement avec `get_inventory`. Le skill est terminé lorsque la quantité
totale de la ressource demandée est supérieure ou égale à la quantité cible.

## Limites connues

Ce skill n'explore pas de nouveaux chunks, ne fabrique pas d'outil et ne ramasse pas explicitement les
items éloignés. Il suppose que les drops sont collectés naturellement à proximité du bloc creusé.
