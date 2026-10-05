# Descriptions des tools

Les descriptions anglaises sont envoyées au LLM dans son catalogue `tools`, avec le JSON Schema
des arguments. Le World Context contient les observations, pas ces descriptions.
Le planner reçoit le catalogue complet de l'actionneur en référence textuelle dans son prompt système,
avec les mêmes descriptions et schémas, sans pouvoir appeler ces tools. Il n'y a pas de catalogue manuel séparé.

Emplacements à modifier :

- `src/bootstrap/createCapabilities.ts` : capacités physiques, notamment goto, dig, place.
- `src/world/queries/defaultQueries.ts` : lectures du monde.
- `src/world/queries/GetDroppedItems.ts` : items au sol.
- `src/agent/ToolCatalogBuilder.ts` : skills, landmarks, finish_step.
- `src/agent/CoordinatorTools.ts` : reply, ask_planner, run_step, complete_step, refresh_summary.

Les dix descriptions clarifiées utilisent des lignes courtes :

```text
Does: Break one block at the specified position.
Success: An inbound server block update confirmed removal at the target.
Limits: Does not confirm that its drops entered the inventory.
Notes: Check get_block_access when uncertain. Check drops and inventory after digging.
```

`Returns` remplace `Success` pour une observation.
Ne pas promettre une validation que le code ne fait pas : l'arrivée, la casse et le ramassage
sont trois observations différentes. Les valeurs inconnues doivent rester explicites.
Les autres descriptions courtes sont conservées ; il n'y a pas de prose dupliquée dans les prompts d'agents.

Le catalogue est construit au démarrage. Redémarrer le bot après édition.

## Recherches et sessions

`find_nearest_blocks({ names, maxDistance?, count? })` est une observation asynchrone sans déplacement.
`maxDistance` vaut 32 par défaut, avec un maximum de **50 blocs** ; `count` vaut 1 par défaut, maximum 128.
Les limites sont dans le schéma et la description transmis au modèle. Une recherche interrompue ou trop
longue retourne une erreur structurée, pas une liste vide. Pour chercher plus loin, il faut se déplacer.

Les queries du coordinateur et de l'actionneur utilisent les mêmes limites : délai de 2 secondes,
réponse sérialisée de 12 000 caractères maximum. Réduire `count` ou le rayon si la réponse est trop grande.
Le World Context de l'actionneur donne aussi la session du conteneur actuellement ouvert, si elle existe.
`transfer_item` et `close_container` restent les tools d'action ; aucune ouverture implicite n'est ajoutée.

## Crafting

L'actionneur dispose de deux tools physiques aux schémas objets simples, sans `anyOf` :

- `craft_from_inventory_2x2({ item, quantity })` utilise la grille personnelle 2x2.
- `craft_from_table_3x3({ item, quantity, tablePosition })` utilise une table existante,
  visible et à portée ; cette grille accepte aussi les recettes 2x2.

Le champ `station` n'est pas un argument. L'ancien tool `craft` n'est plus enregistré.
`quantity` est un nombre entier de 1 à 64 : quantité de sortie souhaitée, pas nombre de recettes.
`tablePosition` est la cellule observée, sous forme d'objet de coordonnées entières.

Exemples de deux appels successifs pour obtenir une table à partir d'une bûche :

```text
craft_from_inventory_2x2({"item":"oak_planks","quantity":4})
craft_from_inventory_2x2({"item":"crafting_table","quantity":1})
```

Les deux entrées et le moteur commun sont dans `src/capabilities/Craft.ts` ; descriptions et
enregistrement restent dans `src/bootstrap/createCapabilities.ts`. Le moteur ne fabrique pas les
ingrédients manquants et ne cherche/n'approche/ne pose pas la table. Les résultats gardent la
station utilisée comme donnée d'observation. Le skill `craft_item` référence les deux nouveaux tools.
