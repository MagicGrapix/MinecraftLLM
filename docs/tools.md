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
- `src/agent/CoordinatorTools.ts` : reply, ask_architect, ask_planner, run_step, complete_step, refresh_summary.
- `src/world/queries/LookupMaterial.ts` : lookup_material (schéma, description et recherche partagés).
- `src/agent/ArchitectTools.ts` : submit_blueprint, strictement réservé à l'Architect.

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

## Pose

`place({ referencePosition, face })` pose le bloc équipé contre un support existant.
La destination est la cellule adjacente dans la direction de la face, pas `referencePosition`.
Le succès exige le nom attendu, un paquet serveur à cette destination et une lecture locale concordante.
Les items sans bloc du même nom (par exemple `stick` ou `redstone`) sont refusés avant envoi.
Une erreur Mineflayer après la tentative n'est pas immédiatement définitive : vérification immédiate,
puis toutes les 100 ms pendant 3 secondes maximum, sans nouvelle pose ni requête réseau de polling.
À expiration, `ACTION_NOT_CONFIRMED` demande d'observer avant de retenter ; la modification peut encore arriver.
Les états inconnus restent distincts d'un bloc incorrect. L'orientation n'est pas validée par ce tool.
Les traces `place.confirmation` donnent `attempt`, `settled`, les changements `observed`, puis
`confirmed`, `expired` ou `interrupted`, avec cible, bloc attendu, états reçus et cause Mineflayer éventuelle.

## Collecte automatique (lot 3)

`collect_resource({"item":"oak_log","quantity":4})` cherche, approche, équipe un outil disponible,
casse et ramasse jusqu'à obtenir **quatre items supplémentaires**, sans appel LLM interne.
Le schéma strict accepte seulement `item` et `quantity` (entier 1–256). Le préfixe `minecraft:` est accepté.

Ressources supportées : `oak_log`, `spruce_log`, `birch_log`, `jungle_log`, `acacia_log`, `dark_oak_log`,
`mangrove_log`, `cherry_log`, `pale_oak_log`, `dirt` depuis dirt/grass_block, `cobblestone` depuis stone/cobblestone.
Les noms doivent exister dans le registre chargé. Les autres ressources sont refusées avant déplacement.
Le collecteur n'invente pas de recette : une pioche doit déjà être disponible pour la pierre.
Silk Touch est exclu quand il empêcherait le drop demandé ; aucun outil n'est fabriqué automatiquement.

Les constantes sont dans `src/collection/CollectionConfig.ts` : recherche de 32 blocs depuis l'origine fixe,
arrêt si le bot s'éloigne de plus de 50 blocs, 300 secondes maximum, déplacements bornés à 20 secondes,
deux essais d'accès par cellule/drop et huit tentatives sans gain avant arrêt. Les recherches sont coopératives,
par lots de 32 résultats dans les chunks chargés. Un dig non confirmé n'est pas rejoué à la même cellule.
Le bot ne creuse pas son appui ni un trou sans support connu dessous ; les bûches hautes restent récoltables
si accessibles. Les drops en chute visent une surface chargée proche, sans confondre leur hauteur et celle des pieds.
L'accès essaie un chemin libre, puis le creusement local (24 obstacles maximum), puis une réserve de
8 dirt si des poses sont nécessaires. Réserve : rayon 8, 24 tentatives, sources directement accessibles,
sans collecte récursive. Maximum 24 poses, relief de 3 blocs par déplacement, sol chargé à faible profondeur ;
pas de franchissement de liquide ni de vide. Les stations et chantiers `build` connus sont protégés.
Les bâtiments du joueur non enregistrés ne sont pas reconnus. Aucun outil n'est fabriqué automatiquement.
Le nettoyage retire uniquement les supports confirmés encore identiques et accessibles depuis le sol ;
il peut laisser des blocs. Une annulation arrête aussi le nettoyage. Il ne récupère pas obligatoirement les drops du nettoyage.

Le succès contient `item`, `requested`, `collected`, `inventoryKnown`, `sourcesFound`, `sourcesBroken`,
`accessFailed`, `durationMs`, `scaffoldsLeft`. En échec, ce bilan est dans `error.facts.progress` ; sur stop/timeout de l'Executor,
dans `error.facts.progress.collect`. `sourcesFound` compte les positions distinctes observées,
`sourcesBroken` les dig confirmés, `accessFailed` les cellules ayant subi au moins un refus/précontrôle raté.
Ce dernier compteur ne prouve pas une inaccessibilité définitive. `collected` est un gain net d'items,
pas le nombre de sources cassées ; lire aussi `inventoryKnown` avant toute reprise.

Un seul appel et un seul diff d'inventaire parent sont enregistrés. Les traces JSONL `collect.event` détaillent
recherche, accès, équipement, dig, déplacement et confirmation avec `taskId` et index local ; elles ne créent
pas de faux appels LLM. Leur affichage imbriqué dans la UI reste pour le lot 5.

`npm.cmd run smoke:collect` vérifie cette boucle sans LLM : voir [les tests physiques](scenario-testing.md).

## Construction (lots 2–3 et 7)

`build({ blueprintId, origin: { x, y, z } })` construit un blueprint déjà enregistré par `BlueprintStore`.
L'origine entière est la cellule locale (0,0,0), pas la position du bot ; elle reste fixe pour reprendre.
Un seul appel physique englobe déplacements, équipements, poses et vérifications, avec un délai par défaut de 300 secondes.
Le diff d'inventaire est celui de cet appel complet, pas un nouveau numéro d'action par bloc.

Le précontrôle refuse sans mouvement un stock insuffisant, un bloc incompatible, une cellule requise inconnue
ou un terrain non plat. Le chantier et sa marge de deux blocs doivent être à moins de 50 blocs du bot.
La pose exige une face visible, à portée, sans collision avec le bot, puis une confirmation serveur.
Le succès vérifie toutes les cellules contraintes et la sortie du bot hors de l'emprise.
Un échec conserve les blocs posés et un bilan partiel ; rappeler avec la même référence et la même origine.
Les dépendances `oak_door` sont posées après les cubes : un item, deux moitiés confirmées (orientation, charnière, fermée/non alimentée).
Une porte existante incompatible est un conflit, pas une invitation à la démolir. Le succès ne prouve pas l'habitabilité.
Si nécessaire, le Builder pose des escaliers extérieurs en terre : trois blocs de haut maximum,
24 blocs temporaires maximum, uniquement dans la marge. La terre destinée au dessin reste réservée.
`MISSING_SCAFFOLD_MATERIALS` indique séparément la terre de construction et la terre d'accès manquante.
Il ne récolte ni ne crafte ces matériaux. Le nettoyage retire seulement la terre suivie et encore conforme,
depuis le sol. Une erreur/annulation peut laisser des blocs : `progress.scaffolding` donne les positions
restantes et incertaines. Rappeler le même blueprint/origine dans la même session reprend le chantier.
Après redémarrage, aucun ancien bloc n'est revendiqué automatiquement. Les drops ne sont pas forcément ramassés.
L’Architect expose uniquement `submit_blueprint({ drawing: string })` : couches ASCII séparées par
une ligne vide, A = oak_planks, point = air requis. Dimensions et palette sont calculées en code.
Une erreur localise la couche/ligne (numérotation 1-based) ; le modèle resoumet le dessin complet.
Une validation/sauvegarde réussie termine la délégation sans prouver la conformité à la demande.
`lookup_material({ query, kind? })` reste une query du coordinateur et de l’actionneur, pas de l’Architect.
Elle distingue noms connus et support Blueprint, sans garantir disponibilité ou craftabilité.
`submit_blueprint` reste réservé à l'Architect. Le coordinateur possède `ask_architect({ instruction })`
et reçoit seulement le rapport compact ; ce succès invalide la checklist précédente, sans construire.
Le planner voit `build` et `lookup_material` comme documentation, jamais comme tools appelables.
L'actionneur ne peut appeler `build` qu'avec le blueprint sélectionné dans sa délégation actuelle.
Voir [Architect](blueprints.md#architect-lot-4) pour le rapport, les limites et le smoke sans Minecraft.

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
`quantity` est un nombre entier de 1 à 64 : gain minimal de sortie souhaité, pas nombre de recettes.
Les recettes produisent des lots entiers : `stick` avec `quantity: 1` peut produire quatre sticks à partir
de deux planches. Le résultat `craftedQuantity` indique le gain réel ; un surplus n'est pas un échec.
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

Chaque recette est confirmée séparément par l'inventaire serveur avant d'enchaîner la suivante :
résultat rangé, ingrédients consommés, grille et curseur vides. Les constantes `ACTION_CONFIRMATION`
de `src/config.ts` fixent un polling local de 100 ms et une attente maximale de 3 secondes, sans
réémettre le craft. `ACTION_NOT_CONFIRMED` peut laisser une production partielle : `craftedQuantity`
est le gain confirmé, `observedGain` la dernière différence serveur disponible (ou null),
`expectedGain` le gain attendu après la recette tentée. Les inventaires complets restent dans les traces
`craft.confirmation`/`craft.unconfirmed`. La confirmation de cette version cible Java 1.21.11.

`npm.cmd run smoke:craft` vérifie sans LLM les recettes 2x2/3x3, les quantités 7/64/7 et les ingrédients
via une lecture NBT indépendante du controller OP. Il utilise `craft_test_bot`, `test_controller`
et une cellule initialement vide à (-35,-60,-35), puis enlève sa table et vide son seul inventaire de test.
