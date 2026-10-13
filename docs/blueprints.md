# Blueprints et Builder

Le lot 1 fournit le format, la validation, les suggestions de noms, le calcul des matériaux et le stockage.
Ces opérations hors ligne ne connectent aucun bot, ne contactent aucun LLM et ne modifient pas Minecraft.
Le lot 2 ajoute la capability `build`, qui exécute une référence sauvegardée dans Minecraft, sans LLM interne.
Le lot 3 ajoute les dépendances `oak_door` (un item, deux moitiés vérifiées).
L’Architect isolé expose désormais un seul tool `submit_blueprint({ drawing })` (simplification du 6 octobre).
Son raccordement au coordinateur est livré au lot 5 du [plan](plans/blueprint-builder.md).

## Composants

- `src/world/MaterialCatalog.ts` reçoit un registre `minecraft-data` ou Mineflayer et capture les noms de sa version.
- `src/building/Blueprint.ts` définit le schéma strict et les données compilées.
- `src/building/BlueprintValidator.ts` valide un objet inconnu et produit cellules, placements et facture d'items.
- `src/building/BlueprintStore.ts` enregistre et relit les blueprints acceptés.
- `src/building/BuildingConfig.ts` contient les limites et la liste explicite des blocs pleins admis.
- `BlueprintDoors.ts` compile les portes ; `BuildDoor.ts` contrôle leur géométrie de pose ; `PlaceBuildDoor.ts` gère rotation et confirmation serveur.
- `src/agent/ArchitectAgent.ts` et `ArchitectTools.ts` orchestrent la conception hors jeu avec le prompt `prompts/architect.md`.
- `src/building/ArchitectDrawing.ts` adapte le dessin texte de l’Architect au format Blueprint interne.

Exemple d'utilisation dans un script, sans démarrer Minecraft :

```typescript
import minecraftData from "minecraft-data";
import { MaterialCatalog } from "./src/world/MaterialCatalog";
import { BlueprintValidator } from "./src/building/BlueprintValidator";
import { BlueprintStore } from "./src/building/BlueprintStore";

const catalog = new MaterialCatalog(minecraftData("1.21.11"));
const validator = new BlueprintValidator(catalog);
const store = new BlueprintStore(validator); // data/blueprints, relatif au cwd du programme

catalog.search("oak_plate"); // exact: null ; suggestions seulement, pas de substitution
const input = {
  name: "two_blocks",
  description: "Two oak planks with one required empty cell.",
  width: 3,
  depth: 1,
  palette: { A: "oak_planks" },
  layers: [["AA."]],
  dependencies: { doors: [] },
};
const checked = validator.validate(input);
// Dans une fonction async :
// const saved = await store.save(input);
// if (saved.ok) console.log(await store.load(saved.value.id));
```

Dans le runtime connecté, `BuildCapability` utilise `bot.registry` au lieu de choisir une version indépendante.
Le catalogue ne promet ni disponibilité en inventaire, ni recette, ni existence de ressources dans le monde.

## Format et repère

- `layers[y][z][x]` : couches du bas vers le haut, lignes vers le sud (+Z), colonnes vers l'est (+X).
- `width` et `depth` sont des entiers positifs ; la hauteur est le nombre de couches.
- Chaque ligne a exactement `width` caractères, chaque couche exactement `depth` lignes.
- Une lettre majuscule ASCII désigne un bloc de `palette`.
- `.` représente de l'air **requis** ; `_` représente une cellule ignorée. Les deux ne coûtent aucun item.
- Les positions des cellules et opérations compilées sont locales et entières ; elles ne sont pas des coordonnées monde.
- Le résultat `operations` contient les cubes dans l'ordre Y/Z/X, puis les portes. Ce n'est pas une preuve de constructibilité ni un planning de navigation.

Limites : largeur/profondeur 8, hauteur 5, palette 16 entrées, dépendances portes 16, fichier 65 536 octets.
Les chaînes, tableaux, coordonnées et champs supplémentaires sont validés sans conversion implicite.
Les erreurs détaillées sont limitées à 20 ; `totalIssues` indique leur nombre total.

La palette accepte les planches listées dans `BuildingConfig.ts`, cobblestone, stone, dirt et glass, seulement si ces blocs et leurs items existent dans le registre injecté.
Un bloc reconnu n'est pas automatiquement accepté : sable, bûches orientables, portes dans la palette, liquides, etc. sont refusés.
Le préfixe `minecraft:` est normalisé ; les autres namespaces, catégories et fautes ne deviennent jamais des correspondances exactes.

## Portes : dépendances explicites

`dependencies.doors` accepte `item: "oak_door"`, une `position` locale (moitié basse) et `facing: "north" | "south" | "east" | "west"`.
Les deux moitiés doivent remplacer deux `_` dans le dessin. Une lettre, un `.` ou une autre dépendance sont des conflits.
La porte doit tenir dans le volume ; au-dessus de Y=0, un cube plein doit être prévu immédiatement dessous.
À Y=0, le support vient du sol contrôlé par le Builder. Les portes adjacentes/doubles et les autres matériaux sont refusés.

Le compilateur produit **une opération et un item**, mais **deux cellules attendues**.
La charnière est déterministe : supports pleins à gauche/droite selon l'orientation ; égalité => gauche avec un clic décalé.
Les portes sont posées après tous les cubes pour stabiliser ces supports. Un environnement voisin incompatible empêche la pose.
L'adaptateur attend la rotation Mineflayer avant d'envoyer le clic ; `force=true` ne garantit pas que le serveur a reçu le nouveau yaw.
La pose utilise `_placeBlockWithOptions` pour préserver l'orientation et le point de clic. Cette dépendance privée est isolée
dans `PlaceBuildDoor.ts` et doit être retestée avec `smoke:doors` après une mise à jour de Mineflayer.

Les deux paquets serveur doivent confirmer nom, moitié, facing, hinge, `open=false`, `powered=false`.
Une porte existante partielle, ouverte, alimentée ou mal orientée renvoie `BLOCKED` / `DOOR_CONFLICT`, sans remplacement automatique.
Les compteurs de progression comptent des opérations : une porte conforme compte pour 1, pas 2.
Un succès prouve la conformité du dessin, pas son habitabilité. Ouvrir la porte (`use_block`) puis passer (`goto`) est distinct.
`goto` reconnaît les portes déjà ouvertes dont la forme de collision laisse passer le corps centré du bot ; il ne les ouvre pas automatiquement.
L'adaptateur `GotoDoors` corrige aussi les points de passage que le post-traitement du pathfinder déplacerait sur le haut de la porte.
`use_block.cursor`, s'il est fourni, sert au point visé **et** au clic : cela permet de cibler le panneau décalé d'une porte ouverte.

Fixtures :

- `tests/fixtures/blueprints/small-oak-shelter.json` : accepté, 5×5×4, 80 placements, 20 cellules d'air requis ; **55 oak_planks + 25 cobblestone**.
- `tests/fixtures/blueprints/small-oak-house.json` : accepté, 81 placements, 82 cellules occupées et 18 d'air requis ; **55 oak_planks + 25 cobblestone + 1 oak_door**.

## Résultats et erreurs

Les méthodes `validate`, `save` et `load` utilisent la forme `TaskResult` existante : `ok/value` ou `ok/error`.
Cette réutilisation d'enveloppe n'exécute pas de capability.

`validate` retourne en succès le blueprint normalisé, la version Minecraft, la hauteur, toutes les cellules,
les opérations de cubes/portes et les matériaux agrégés par nom d'item. Il ne modifie pas l'objet fourni.
Un dessin sans bloc à placer est refusé. Un dessin peut être valide sans être accessible ou habitable.

En échec, `code` vaut `INVALID_ARGUMENT`, `facts.reason` vaut `INVALID_BLUEPRINT` et `facts.issues` contient des erreurs localisées :

- `INVALID_SHAPE` : mauvais type, dimension, caractère ou champ.
- `UNKNOWN_SYMBOL` : lettre absente de la palette, avec position locale.
- `UNKNOWN_BLOCK` : nom inexistant, avec alternatives proposées.
- `UNSUPPORTED_BLOCK` : bloc reconnu mais comportement non pris en charge.
- `MISSING_PLACEMENT_ITEM` : bloc autorisé sans item correspondant dans cette version.
- `UNSUPPORTED_DEPENDENCY` : matériau de porte non pris en charge ou absent du registre.
- `DOOR_OUT_OF_BOUNDS`, `DOOR_OVERLAP`, `DOOR_SUPPORT`, `ADJACENT_DOORS` : dépendance incompatible avec le dessin.
- `EMPTY_BLUEPRINT` : rien à construire.

`MaterialCatalog.resolve(kind, name)` ne fait que la correspondance exacte avec normalisation du préfixe.
`search(query, kind = "block")` accepte 1 à 128 caractères après trim ; un argument hors limites lève `RangeError`.
La recherche suggère au plus cinq noms, classés par égalité, préfixe/sous-chaîne, mots et proximité orthographique avec ordre stable en cas d'égalité.
La normalisation de casse/espaces sert uniquement à suggérer, jamais à transformer un nom erroné en correspondance exacte.

## Persistance

`save` valide avant de créer le répertoire. Chaque sauvegarde reçoit un nouvel ID `bp_<uuid>` généré en code.
Le nom donné au dessin n'est jamais utilisé comme chemin. Une nouvelle version est un nouveau fichier ; il n'existe pas d'opération d'écrasement.

L'écriture utilise un fichier temporaire exclusif dans le même répertoire, un flush, puis la publication atomique par lien physique.
Ce choix évite le remplacement que permettrait un `rename` sur une référence existante. Une collision échoue sans toucher le fichier publié.
Le système de fichiers doit accepter les liens physiques (testé sur le volume Windows local du projet) ; pas de repli vers une écriture non atomique.
Le temporaire est nettoyé ensuite ; un crash peut laisser un `.tmp` inutilisé, jamais chargé comme blueprint.

Le fichier contient `id`, `formatVersion`, `minecraftVersion`, `blueprint` et `materials`. Les cellules et opérations sont recalculables et ne sont pas dupliquées sur disque.
`load` vérifie l'ID, lit au plus limite+1 octets, contrôle l'enveloppe/version, revalide le dessin et compare la facture sauvegardée au calcul frais.
Un fichier corrompu reste intact pour inspection. Un changement de version Minecraft exige une nouvelle soumission explicite.
Le répertoire est choisi par l'application ; les fichiers ne sont ni une preuve de permission de construire, ni une mémoire LLM rechargée automatiquement.

Erreurs de stockage :

- `INVALID_ARGUMENT`, raison `INVALID_BLUEPRINT_ID` ou `INVALID_BLUEPRINT_FILE` : mauvaise référence ou fichier invalide.
- `TARGET_NOT_FOUND` : référence valide mais absente.
- `WORLD_CHANGED`, raison `BLUEPRINT_VERSION_MISMATCH` : version Minecraft différente.
- `INTERNAL_ERROR`, raison `BLUEPRINT_IO_ERROR` : erreur de système de fichiers, dont collision d'ID.
- Les erreurs de revalidation du dessin conservent le feedback détaillé `INVALID_BLUEPRINT`.

Les fichiers générés sous `data/blueprints/` sont ignorés par Git ; les fixtures manuelles restent versionnées.

## Vérification

```powershell
node -r ts-node/register --test tests/unit/building/BlueprintValidator.test.ts tests/unit/building/BlueprintStore.test.ts tests/unit/world/MaterialCatalog.test.ts
npm.cmd test
```

Ces tests chargent les données locales de Minecraft et utilisent des répertoires temporaires pour le stockage. Aucun serveur Minecraft ni appel Ollama/LLM.

## Builder (lots 2–3)

Appel : `build({ blueprintId: "bp_<uuid>", origin: { x: -24, y: -60, z: -24 } })`.
Le script de smoke montre la sauvegarde d'une fixture et l'appel via `TaskFactory` / `Executor`.
Le chargement revalide fichier, version et matériaux avant tout déplacement.
Le dessin doit déjà avoir été enregistré, par exemple par un script ou par l'Architect isolé du lot 4.

### Parcours

1. Contrôler les bornes du monde, les cellules et le sol plat plein sous l'emprise et sa marge de deux blocs.
2. Calculer le stock nécessaire pour les seuls blocs manquants. Un bloc déjà conforme n'est pas replacé.
3. Parcourir les opérations dans l'ordre Y/Z/X ; différer une cellule qui n'a pas encore de support utilisable.
4. Sélectionner au plus huit postures/faces : support plein non interactif, face visible à 4,5 blocs maximum,
   pas de collision avec le bot, retour au sol encore possible après la pose.
5. Naviguer avec `canDig=false`, `canPlace=false`, équiper, revérifier les préconditions puis poser.
6. Attendre les paquets serveur pour la cellule (les deux moitiés pour une porte) et comparer l'état attendu. Aucun retry aveugle après une réponse incertaine.
7. Sortir de l'emprise puis vérifier tous les blocs et tout l'air requis, sans se fier au seul compteur de poses.

`BuildExit` utilise un graphe voxel conservateur dans la marge : marche cardinale, saut d'un bloc,
descente de trois blocs maximum. Il filtre les postures, sans remplacer le pathfinder réel.
Cela évite notamment de fermer le toit en restant dessus sans retour au sol.
Une posture théoriquement accessible peut encore échouer au déplacement : l'erreur est remontée après les candidats bornés.
Ce n'est pas un solveur de constructibilité pour tout dessin valide ; certains plans nécessitent un accès ou un ordre non pris en charge.

Les blocs définitifs sont posés uniquement dans les cellules prévues ; les accès temporaires sont décrits ci-dessous.
Les cellules `.` doivent rester de l'air réel ; un liquide n'est pas de l'air.
`_` est ignoré, pas déblayé. Un bloc incorrect est signalé, jamais détruit. Un changement de dimension interrompt le chantier.
La comparaison des blocs pleins se fait par nom ; aucune orientation particulière n'est requise par cette palette.
Le support de pose est limité à la palette de blocs pleins plus `grass_block` et `bedrock`, pour éviter les interactions de coffres/tables.

### Exécution, reprise et résultats

Le `Builder` dépend d'un port étroit `BuildOperations`, implémenté par `MineflayerBuildOperations`.
L'adaptateur appelle les primitives existantes avec le **même** `ExecutionContext`, jamais un second Executor.
La limite de `build` est 300 000 ms (`BUILD_LIMITS`) ; le TaskSpec explicite reste prioritaire.
Le signal arrête les opérations suivantes. Une promesse déjà partie reste attendue et garde le verrou physique.
`stillSettling=true` signifie qu'il ne faut pas lancer une autre action ; les règles normales de l'Executor restent applicables.

Le bilan compact comprend référence, origine, dimension, phase, durée, total, opérations conformes observées,
opérations initialement conformes, placements confirmés de cet appel et nombre restant. Une porte = une opération.
En erreur physique, `facts.progress` contient ce bilan. En timeout/interruption, l'Executor conserve le dernier bilan publié
sous `facts.progress.build` ; c'est un instantané, pas une garantie sur une pose encore en vol.
Les erreurs précoces de référence/fichier n'ont pas de bilan de monde, puisque celui-ci n'a pas encore été observé.

Il n'y a ni rollback ni sauvegarde d'un compteur de chantier faisant autorité.
Une reprise à la même référence/origine recompare le monde courant et recalcule le stock restant.
Un succès précédent ne dispense jamais de cette vérification ; un dessin totalement conforme ne consomme aucun nouvel item.

Les traces `build.event` portent `taskId`, référence, origine, type d'événement, cible et bloc si applicables.
`action.task_started` relie ce taskId au `actionNumber` du journal de tools.
Les déplacements/poses internes ne créent pas de tours LLM ni de faux appels dans la conversation.
Le `ToolCallJournal` existant capture l'inventaire avant/après le `build` entier (ou indisponible si encore en terminaison).

### Échafaudages limités (lot 7)

Lorsque les postures existantes ne permettent plus de poser, `BuildScaffolding` cherche un escalier
extérieur d'une à trois marches en terre. Il simule les blocs pour vérifier qu'une nouvelle posture
permet une pose du blueprint et un retour au sol. Il sélectionne d'abord le moins de blocs nouveaux.
Chaque pose et déplacement est ensuite vérifié sur le monde réel. Ce n'est pas une garantie de chemin.

- Les escaliers restent hors de l'emprise, dans la marge de deux blocs. Aucune cellule du dessin,
  même ignorée, ni aucun bloc déjà présent n'est remplacé par de la terre temporaire.
- Limites dans `BUILD_LIMITS` : 24 blocs suivis au maximum, trois blocs de haut. Aucun pilier sous le bot,
  accès intérieur, terrassement ou échafaudage automatique du pathfinder. Goto garde canDig/canPlace=false.
- Le stock destiné aux blocs définitifs est réservé. Avant chaque pose temporaire, le surplus de terre
  doit couvrir les nouvelles marches restantes. Un manque renvoie `MISSING_ITEM` avec
  `reason=MISSING_SCAFFOLD_MATERIALS`, besoins définitifs/temporaires, disponible et manque.
  La nécessité de cet accès peut apparaître après le début du chantier ; le bilan partiel est conservé.
- Chaque cible est enregistrée avant l'envoi de sa pose, avec son ancien état d'air. Seule une pose
  confirmée donne le droit de retirer la terre. Une pose incertaine ou un bloc ayant changé est signalé,
  sans retrait automatique. La comparaison utilise le type et le stateId observés.
- Après construction et sortie, le nettoyage travaille du haut vers le bas depuis le sol extérieur.
  Il casse seulement les blocs suivis, encore conformes, visibles et à portée ; la confirmation serveur
  de `DigCapability` reste obligatoire. Les drops peuvent rester au sol. L'herbe couverte peut devenir terre.
- `progress.scaffolding` sépare `placedThisCall`, `removedThisCall`, `remaining` et `uncertain` du dessin.
  Des événements `scaffold_*` relient le plan, chaque pose et chaque retrait au même appel `build`.
- Un échec ou stop ne lance pas de nettoyage supplémentaire. La liste reste dans `BuildCapability`
  pour le même runtime/dimension/blueprint/origine ; un nouvel appel peut finir la construction ou le nettoyage.
  Un nettoyage échoué renvoie `SCAFFOLD_CLEANUP_INCOMPLETE`, sa cause et les positions restantes.
  Le succès exige aussi un nettoyage terminé et la vérification finale du blueprint.
- Cette propriété n'est pas persistée pour reprendre après redémarrage. Le code ne suppose jamais qu'une
  terre déjà présente lui appartient. La réapparition externe d'un bloc strictement identique n'est pas
  distinguable par une simple observation de stateId.

`npm.cmd run smoke:scaffolding` teste un pilier de cinq blocs, stock fourni, arrêt après une pose temporaire,
reprise sur la même capability, vérification indépendante du nettoyage et rappel sans nouvelle pose.
Il utilise le coin réservé du smoke ci-dessous et restaure sa zone, sans LLM ni reset complet de l'arène.
Le scénario `build_with_scaffolding` fournit aussi une vérification de campagne sans LLM.

### Smoke Minecraft explicite

```powershell
npm.cmd run smoke:build
npm.cmd run smoke:doors
```

Serveur local déjà lancé, `test_controller` OP et non déjà utilisé par un autre processus.
Le script connecte un bot survival dédié `build_test_bot`, sans LLM, puis teste deux blocs et l'abri de 80 blocs,
avec interruption après deux poses, reprise et nouvel appel idempotent. Un deuxième bot vérifie indépendamment toutes les cellules.
La variante `smoke:doors` teste aussi les quatre orientations d'une porte isolée et la maison de 81 placements,
puis ouvre la porte, entre, ressort et la referme. Toutes les cellules sont vérifiées à nouveau.
La zone réservée est (-24,-60,-24) à (-20,-57,-20), avec deux blocs de marge ; elle doit être vide et chargée.
Le script ne reset pas l'arène et ne touche pas à l'inventaire de l'agent habituel.
Il retire ses blocs de test et restaure l'herbe du petit sol de test (la couverture peut naturellement la transformer en terre),
puis déconnecte les deux bots. Les blueprints temporaires sont supprimés. Aucune construction de test n'est conservée.

## Architect (lot 4)

`ArchitectAgent` reçoit un client LLM, deux templates (`architect.md`, `context-summary.md`),
un `ArchitectTools` et éventuellement l’inspecteur. `ArchitectTools` ne reçoit que le `BlueprintStore` ;
le validateur du store utilise le catalogue de la version Minecraft. Aucun objet Mineflayer n’est requis.
La boucle est décrite dans [agents et contexte](agent-workflow.md#architect-isolé-lot-4).

- `submit_blueprint({ drawing: string })` : texte multiligne, A = oak_planks, point = air requis.
  Une ligne vide sépare les couches du bas vers le haut. Lignes nord→sud, caractères ouest→est.
  Le modèle ne fournit ni nom, description, palette, dimensions, ni dépendances.
- `ArchitectDrawing` normalise les fins de ligne CRLF/LF, ignore les séparateurs vides extérieurs/répétés,
  mais ne répare ni lignes, ni symboles. Les erreurs donnent la couche/ligne à partir de 1.
  Limites : 8 caractères par ligne, 8 lignes par couche, 5 couches, 2048 caractères au total.
- Le code déduit les dimensions, génère un nom technique et le Blueprint interne, puis appelle
  `BlueprintStore.save`. Le format de stockage et les capacités du Builder (dont les portes) restent inchangés.
  Un dessin invalide n’est pas enregistré. Le modèle reçoit le feedback pour resoumettre l’ensemble.
  Une panne de stockage termine la délégation, sans demander au modèle de corriger le disque.
- `lookup_material` reste disponible dans les queries des autres agents, pas dans ce rôle simplifié.

Une soumission acceptée retourne `blueprintId`, `formatVersion`, `minecraftVersion`, `name`,
`description`, `dimensions: { width, depth, height }`, `materials`. La facture est calculée en code.
L'acceptation prouve le format et les matériaux supportés, pas l'habitabilité ni la conformité sémantique
à une demande de maison. Le Builder devra encore vérifier le site et le stock avant de construire.

Essai réel facultatif, sans connexion Minecraft :

```powershell
npm.cmd run smoke:architect
npm.cmd run smoke:architect -- "Design a low 3 by 3 shelter made of oak planks."
```

Le script utilise la configuration LLM actuelle, le registre `MINECRAFT_VERSION`, puis relit le fichier
accepté pour confirmer sa persistance. Le scénario par défaut reste dans `tests/fixtures/prompts/architect-request.md`.
Les fichiers générés restent dans `data/blueprints/` ; les logs courts et les traces complètes (requêtes,
soumissions, erreurs et rounds d'inspecteur) restent dans `logs/`. Ctrl+C demande un arrêt attendu.
Il ne démarre pas de serveur debug et n'ajoute rien à la session de l'interface 3001 déjà ouverte.

### Expérience de conception par couches

L'[atelier Architect](architect-workbench.md#couche-par-couche) propose aussi `start_blueprint`,
`set_blueprint_layer` et `finish_blueprint`. `ArchitectDraft` garde les dimensions, le plan textuel
et les couches acceptées en mémoire pendant une délégation. X n'existe que dans le gabarit ; il ne peut
jamais être enregistré comme matériau ou comme air. Une couche invalide n'altère pas le brouillon.
`LayeredArchitectTools` ne publie qu'après finish, via le même parseur et `saveArchitectBlueprint`
que la soumission complète. Il ne s'agit pas d'un nouveau format Blueprint ni d'un builder différent.
Le protocole par couches reste expérimental dans l'atelier, pas activé par le coordinateur Minecraft.

## Intégration (lot 5)

`createAgentRuntime` partage client LLM, catalogue connecté et répertoire Blueprint entre Architect et Builder.
Son dernier paramètre facultatif `{ llm, blueprintsDirectory }` est une injection applicative pour les tests,
jamais un argument modifiable par le modèle. Par défaut : client configuré et `data/blueprints/`.
Voir [le cycle de sélection/remplacement/arrêt](agent-workflow.md#construction-dans-le-workflow-lot-5).
Les prompts coordinator/planner/actioner reçoivent `{{construction_context}}`. Le prompt Architect reste séparé.
`agent_summary_<session>.md` inclut désormais la référence sélectionnée et les matériaux, sans grille.
L'inspecteur distingue « blueprint validated, not built » et les appels physiques `build` à leur origine.

```powershell
npm.cmd run smoke:build-workflow
```

Même serveur, bots, coin de test et nettoyage que `smoke:build`. Les matériaux sont fournis par le
controller : 80 planches de chêne. La fixture texte est `architect-shelter.txt`. Le test appelle le vrai
bootstrap/workflow avec un client LLM **scripté**, pas Ollama : conception sans modification du monde,
puis nouvelle demande avec Architect → planner → actionneur → build → complétion.
Le controller vérifie indépendamment les 100 cellules contraintes : 80 blocs et 20 cellules d’air.
L'inspecteur de ce smoke utilise le port 3003 pendant l'essai ; ses rounds, arguments et résultats
sont conservés dans les traces JSONL normales. Les modèles sont étiquetés `scripted-fixture-no-llm`.
Cela valide l'intégration et l'exécution Minecraft, **pas** la fiabilité des décisions de Qwen.
Les campagnes conversationnelles avec modèle réel et approvisionnement restent au lot 6.
